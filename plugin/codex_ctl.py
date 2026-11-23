#!/usr/bin/env python3
"""codex_ctl — 监控本机 Codex 桌面版，并代替你给它派活。

命令:
  python3 codex_ctl.py list                    # 会话列表 + 是否正在跑
  python3 codex_ctl.py status [--thread ID]    # 某个会话在干什么、卡在哪
  python3 codex_ctl.py watch [--interval 5]    # 持续监控，有变化就打印
  python3 codex_ctl.py send --thread ID --message "..." [--wait N]
  python3 codex_ctl.py new --cwd DIR --message "..." [--wait N]

数据来源：
  · 派活 / 会话枚举 —— `codex app-server` JSON-RPC（与桌面版同一份 ~/.codex 状态）
  · 实时工作状态   —— ~/.codex/thread_history_1.sqlite（桌面版边跑边写，可看到正在执行
                      的命令、文件改动、子 agent 活动，以及“等你回答”的提问）
"""

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time

CODEX = os.environ.get("CODEX_BIN", "codex")
CODEX_HOME = os.environ.get("CODEX_HOME", os.path.expanduser("~/.codex"))
HIST_DB = os.path.join(CODEX_HOME, "thread_history_1.sqlite")
STATE_DB = os.path.join(CODEX_HOME, "state_5.sqlite")

# 无终态且静默超过这个时长，才认为会话真的停了。见 live_state 的判据说明。
LIVE_WINDOW_SEC = 300

TURN_LABEL = {
    "inProgress": "进行中",
    "completed": "已完成",
    "interrupted": "已停下",
    "failed": "失败",
}


# ─────────────────────────── 实时状态：读 Codex 本地库 ───────────────────────────
def db(path):
    if not os.path.exists(path):
        return None
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2)
        conn.row_factory = sqlite3.Row
        return conn
    except sqlite3.Error:
        return None


def projects_by_root():
    """项目显示名与它覆盖的目录。

    Codex 的侧栏显示的是 projects.name（可以是「Bitable 组件库」这种自定义名），
    而不是目录名。一个项目可以挂多个根目录，所以这里建的是 root -> 项目 的映射。
    threads.project_id 在库里普遍为空，因此归属只能按 cwd 反查 project_roots。
    """
    conn = db(STATE_DB)
    if not conn:
        return {}
    try:
        rows = conn.execute(
            "select p.id, p.name, r.path, p.position "
            "from projects p left join project_roots r on r.project_id = p.id"
        ).fetchall()
    except sqlite3.Error:
        return {}
    finally:
        conn.close()

    by_root = {}
    projects = {}
    for pid, name, path, position in rows:
        if pid not in projects:
            projects[pid] = {
                "id": pid,
                "name": name or "",
                "position": position if position is not None else 1 << 30,
                "roots": [],
            }
        if path:
            projects[pid]["roots"].append(path)
    # 同一个目录若被两个项目声明，按 projects.position 先到先得；resolve_project 会
    # 从最深的目录逐级向上找，所以嵌套根目录天然是「最长匹配」。
    for proj in sorted(projects.values(), key=lambda p: p["position"]):
        for root in proj["roots"]:
            by_root.setdefault(os.path.normpath(root), proj)
    return by_root


def resolve_project(cwd, by_root):
    """把会话的 cwd 落到某个项目上；返回 (项目名, 项目序号)。"""
    if not cwd:
        return None, None
    path = os.path.normpath(str(cwd))
    # 先精确匹配，再逐级向上找最近的根目录。
    probe = path
    while True:
        proj = by_root.get(probe)
        if proj:
            return proj["name"], proj["position"]
        parent = os.path.dirname(probe)
        if parent == probe:
            return None, None
        probe = parent


def latest_threads(limit=20, include_archived=False):
    """按最近活动取会话。

    标题取 threads.name（Codex 侧栏显示的就是它），没有 name 时才退回 title。
    项目名取 projects.name，按 cwd 反查 project_roots 得到。
    """
    conn = db(STATE_DB)
    if not conn:
        return []
    try:
        rows = conn.execute(
            # subagent 会话是子 agent 的内部线程，Codex 侧栏不把它们当作独立会话，
            # 所以这里排除，否则列表会被并行的子任务刷满。
            "select id, title, name, cwd, updated_at, model, tokens_used, "
            "rollout_path, is_pinned, source, thread_source, preview "
            "from threads "
            "where coalesce(thread_source, '') != 'subagent' "
            # 既没有 name 也没有首条消息的会话是空壳（有 turn 但没有任何 item），
            # Codex 侧栏也不显示，留着只会占位置。
            "  and (coalesce(name, '') != '' or coalesce(title, '') != '' "
            "       or coalesce(preview, '') != '') "
            "order by updated_at desc limit ?",
            (limit,),
        ).fetchall()
        out = [dict(r) for r in rows]
    except sqlite3.Error:
        return []
    finally:
        conn.close()

    by_root = projects_by_root()
    for row in out:
        proj_name, proj_pos = resolve_project(row.get("cwd"), by_root)
        row["projectName"] = proj_name
        row["projectPosition"] = proj_pos
    return out


def latest_turn(thread_id):
    conn = db(HIST_DB)
    if not conn:
        return None
    try:
        row = conn.execute(
            "select turn_id, status, started_at, completed_at, duration_ms "
            "from thread_turns where thread_id=? order by started_at desc limit 1",
            (thread_id,),
        ).fetchone()
        return dict(row) if row else None
    except sqlite3.Error:
        return None
    finally:
        conn.close()


def recent_items(thread_id, limit=8):
    conn = db(HIST_DB)
    if not conn:
        return []
    try:
        rows = conn.execute(
            "select item_type, created_at_ms, item_json from thread_items "
            "where thread_id=? order by created_at_ms desc limit ?",
            (thread_id, limit),
        ).fetchall()
    except sqlite3.Error:
        return []
    finally:
        conn.close()
    out = []
    for r in rows:
        try:
            payload = json.loads(r["item_json"])
        except (json.JSONDecodeError, TypeError):
            payload = {}
        # 统一成秒：调用方（CLI 与 UI）都按秒渲染，避免毫秒/秒混用。
        out.append({"type": r["item_type"], "at": r["created_at_ms"] / 1000, "data": payload})
    return out


def transcript(thread_id, limit=200, scan_limit=4000):
    """按时间正序返回一段对话，供聊天窗口渲染。

    只保留对“读起来像聊天”有意义的条目：用户说的话、Codex 说的话，以及被折叠成
    一行的动作（跑命令、改文件等）。推理过程不入正文，避免把聊天窗口灌满。
    """
    conn = db(HIST_DB)
    if not conn:
        return {"entries": [], "truncated": False}
    try:
        # A busy session can be thousands of rows of mostly commands and reasoning.
        # Scanning a wider window (then trimming to `limit` below) keeps the actual
        # conversation from being crowded out by tool chatter.
        rows = conn.execute(
            "select item_type, created_at_ms, item_json from thread_items "
            "where thread_id=? order by created_at_ms desc limit ?",
            (thread_id, max(1, scan_limit)),
        ).fetchall()
    except sqlite3.Error:
        return {"entries": [], "truncated": False}
    finally:
        conn.close()

    out = []
    truncated = len(rows) > max(1, limit)
    for r in reversed(rows):
        try:
            payload = json.loads(r["item_json"])
        except (json.JSONDecodeError, TypeError):
            payload = {}
        kind = r["item_type"]
        at = r["created_at_ms"] / 1000
        if kind == "userMessage":
            text = " ".join(
                c.get("text", "") for c in payload.get("content") or [] if c.get("type") == "text"
            ).strip()
            if text:
                out.append({"role": "user", "at": at, "text": text, "id": payload.get("id")})
            continue
        if kind == "agentMessage":
            text = (payload.get("text") or "").strip()
            if text:
                final = payload.get("phase") == "final_answer"
                out.append({
                    "role": "agent",
                    "at": at,
                    "text": text,
                    "final": final,
                    "id": payload.get("id"),
                    "questions": payload.get("questions") or None,
                })
            continue
        if kind == "reasoning":
            continue
        label, detail = describe_item({"type": kind, "data": payload})
        out.append({"role": "action", "at": at, "label": label, "text": clip(detail, 240)})

    entries = trim_transcript(out, limit)
    return {"entries": group_turns(entries, turn_spans(thread_id)), "truncated": truncated}


def turn_spans(thread_id):
    """每一轮的 (user_item_id, final_agent_item_id, duration_ms)。

    thread_turns 直接把「哪个用户消息开头、哪个 agent 消息收尾、跑了多久」记好了，
    不用自己拿时间戳去猜边界。
    """
    conn = db(HIST_DB)
    if not conn:
        return []
    try:
        rows = conn.execute(
            "select first_user_item_id, final_agent_item_id, duration_ms, started_at, completed_at "
            "from thread_turns where thread_id=? order by started_at",
            (thread_id,),
        ).fetchall()
    except sqlite3.Error:
        # 老库/测试库可能没有这两列，退化到只读时长，分组仍然可用。
        try:
            rows = conn.execute(
                "select null, null, duration_ms, started_at, completed_at "
                "from thread_turns where thread_id=? order by started_at",
                (thread_id,),
            ).fetchall()
        except sqlite3.Error:
            return []
    finally:
        conn.close()
    return [
        {
            "firstUser": r["first_user_item_id"],
            "finalAgent": r["final_agent_item_id"],
            "durationMs": r["duration_ms"],
            "startedAt": r["started_at"],
            "completedAt": r["completed_at"],
        }
        for r in rows
    ]


def group_turns(entries, spans):
    """把一轮里的中间过程收进 work 块，只把最终回复留在正文。

    Codex 自己就是这么显示的：正文只有用户说的话和最终答复，中间的命令、推理、
    阶段性说明都折进一行「用时 X」。所以这里按轮切开，把 user 之后的动作和
    commentary 归到同一个 work 块，final_answer 单独露出。
    """
    if not entries:
        return []
    # 用 user 消息切轮：Codex 的一轮一定从用户消息开始。
    turns = []
    current = None
    for entry in entries:
        if entry["role"] == "user":
            current = {"user": entry, "work": [], "final": None}
            turns.append(current)
            continue
        if current is None:
            # 前面还有没有归属的条目（比如更早的轮被 trim 掉了），单独成块。
            current = {"user": None, "work": [], "final": None}
            turns.append(current)
        if entry["role"] == "agent" and entry.get("final"):
            # 一轮里可能有多个 final_answer（中途被打断），最后一个才是收尾。
            current["final"] = entry
        else:
            current["work"].append(entry)

    # 时长按 final_agent_item_id 精确匹配：一轮的收尾消息 id 是唯一的，
    # 比对顺序更可靠——中间有轮被 trim 掉也不会错位。
    by_final = {
        sp["finalAgent"]: sp["durationMs"]
        for sp in spans
        if sp.get("finalAgent") and sp.get("durationMs") is not None
    }
    for turn in turns:
        final = turn["final"]
        if final is not None and final.get("id") in by_final:
            turn["durationMs"] = by_final[final["id"]]

    out = []
    for turn in turns:
        if turn["user"] is not None:
            out.append(turn["user"])
        work = turn["work"]
        if work:
            out.append({
                "role": "work",
                "at": work[-1]["at"],
                "durationMs": turn.get("durationMs"),
                "count": len(work),
                "entries": work,
            })
        if turn["final"] is not None:
            out.append(turn["final"])
    return out


def trim_transcript(entries, limit):
    """保留最近 limit 条，并把成串的同类动作压成一行。

    聊天窗口里连续几十条命令既读不下去也挤掉了对话本身，所以连续的同类动作
    只留第一条和总数。
    """
    if not entries:
        return []
    kept = entries[-limit:] if limit and len(entries) > limit else entries
    out = []
    run = []
    for entry in kept:
        if entry["role"] == "action":
            run.append(entry)
            continue
        if run:
            out.extend(collapse_run(run))
            run = []
        out.append(entry)
    if run:
        out.extend(collapse_run(run))
    return out


def collapse_run(run):
    # A couple of consecutive commands still read fine as-is; only a long burst is
    # worth collapsing, and collapsing it must not silently drop information.
    if len(run) <= 2:
        return list(run)
    return [{
        "role": "action",
        "at": run[-1]["at"],
        "label": run[0]["label"],
        "text": clip(run[0]["text"], 160),
        "count": len(run),
        "lastLabel": run[-1]["label"],
        "lastText": clip(run[-1]["text"], 160),
    }]


def last_activity_at(thread_id):
    """该会话最新一条动作的时间（毫秒）。桌面版边跑边写，是最可靠的心跳。"""
    conn = db(HIST_DB)
    if not conn:
        return 0
    try:
        row = conn.execute(
            "select max(created_at_ms) from thread_items where thread_id=?", (thread_id,)
        ).fetchone()
        return (row[0] if row else 0) or 0
    except sqlite3.Error:
        return 0
    finally:
        conn.close()


def activity_age(thread_id, now_ms=None):
    """距最近一次动作多少秒；没有活动记录时返回 None（不要伪装成天文数字）。"""
    last = last_activity_at(thread_id)
    if not last:
        return None
    return max(0.0, ((now_ms or int(time.time() * 1000)) - last) / 1000)


def live_state(thread_id, turn, questions, now_ms=None):
    """综合判断会话此刻的状态。

    判据优先级（重要）：
    1. 有提问 → waiting，Codex 已经停下来了。
    2. turn.status 明确终态（completed/failed）→ 立即落地。这一条必须排在心跳之前：
       实测 98.7% 的已完成轮次，最后一条动作距完成不到 90s，若让心跳优先，
       干完了还会显示“正在跑”。
    3. inProgress → running。
    4. 只剩 interrupted/未知才用“最近是否有新动作”兜底：桌面版会把在跑的轮次
       持久化成 interrupted，而 13.5% 的轮次内部存在 >90s 的静默间隔（跑长命令、
       等子 agent），所以窗口太窄会误判成“已停下”。
    """
    now_ms = now_ms or int(time.time() * 1000)
    age = activity_age(thread_id, now_ms)
    if questions:
        return "waiting", age

    status = (turn or {}).get("status")
    if status == "completed":
        return "done", age
    if status == "failed":
        return "failed", age
    if status == "inProgress":
        return "running", age
    if age is not None and age <= LIVE_WINDOW_SEC:
        return "running", age
    return "stopped", age


def live_turn(srv, thread_id, items_limit=1):
    """从 app-server 取最近一轮的真实状态（SQLite 的 inProgress 会滞后）。

    返回 (turn_dict | None, questions | None)。
    """
    try:
        res = srv.call("thread/turns/list", {"threadId": thread_id, "limit": items_limit, "itemsView": "summary"})
    except (RuntimeError, TimeoutError):
        return None, None
    data = res.get("data") or []
    if not data:
        return None, None
    turn = data[0]
    questions = None
    for item in turn.get("items") or []:
        if item.get("type") == "agentMessage" and item.get("questions"):
            questions = item["questions"]
    return turn, questions


def pending_question(thread_id):
    """Codex 停下来等人拍板时，最近一轮的状态是 interrupted，且该轮里带 questions。

    只认“最近一轮”，所以你一回复（新的一轮开始）或它继续往下跑，提示就自动消失。
    """
    turn = latest_turn(thread_id)
    if not turn or turn["status"] != "interrupted":
        return None
    conn = db(HIST_DB)
    if not conn:
        return None
    try:
        rows = conn.execute(
            "select item_json from thread_items where thread_id=? and turn_id=? "
            "and item_type='agentMessage' order by created_at_ms desc limit 3",
            (thread_id, turn["turn_id"]),
        ).fetchall()
    except sqlite3.Error:
        return None
    finally:
        conn.close()
    for r in rows:
        try:
            payload = json.loads(r["item_json"])
        except (json.JSONDecodeError, TypeError):
            continue
        if payload.get("questions"):
            return payload["questions"]
    return []


def describe_item(item):
    """把一条 Codex 活动翻译成一行中文。"""
    t, d = item["type"], item["data"]
    if t == "userMessage":
        parts = [c.get("text", "") for c in d.get("content") or [] if c.get("type") == "text"]
        return "你提出", " ".join(parts)
    if t == "agentMessage":
        phase = d.get("phase")
        label = {"commentary": "Codex 说", "final_answer": "Codex 结论"}.get(phase, "Codex 说")
        return label, d.get("text") or ""
    if t == "reasoning":
        summary = " ".join(
            s.get("text", "") for s in d.get("summary") or [] if isinstance(s, dict)
        )
        return "思考", summary or "（推理中）"
    if t == "commandExecution":
        cmd = " ".join(str(d.get("command") or "").split())
        return "执行命令", cmd
    if t == "fileChange":
        files = [f.get("path") for f in d.get("changes") or [] if isinstance(f, dict)]
        return "改文件", ", ".join(str(f) for f in files) or "(见详情)"
    if t == "webSearch":
        return "联网搜索", str(d.get("query") or "")
    if t == "mcpToolCall":
        return "调工具", f"{d.get('server') or ''}/{d.get('tool') or ''}"
    if t == "subAgentActivity":
        return "子 agent", f"{d.get('kind') or ''} @{d.get('agentPath') or ''}"
    if t == "plan":
        return "更新计划", "（计划有变）"
    if t == "contextCompaction":
        return "压缩上下文", ""
    if t == "collabAgentToolCall":
        return "协作子 agent", ""
    if t == "imageView":
        return "看图", ""
    if t == "imageGeneration":
        return "生成图片", ""
    if t == "sleep":
        return "等待", ""
    if t == "enteredReviewMode":
        return "进入审查", ""
    if t == "exitedReviewMode":
        return "退出审查", ""
    if t == "functionCallOutput":
        return "工具输出", ""
    return "其他动作", t


def first_user_text(thread_id):
    """threads.title 为空时，用该会话第一条用户消息兜底。"""
    conn = db(HIST_DB)
    if not conn:
        return ""
    try:
        row = conn.execute(
            "select item_json from thread_items where thread_id=? and item_type='userMessage' "
            "order by created_at_ms asc limit 1",
            (thread_id,),
        ).fetchone()
    except sqlite3.Error:
        return ""
    finally:
        conn.close()
    if not row:
        return ""
    try:
        payload = json.loads(row["item_json"])
    except (json.JSONDecodeError, TypeError):
        return ""
    parts = [c.get("text", "") for c in payload.get("content") or [] if c.get("type") == "text"]
    return " ".join(parts)


def clip(text, n=110):
    text = " ".join(str(text or "").split())
    return text if len(text) <= n else text[: n - 1] + "…"


def clean_title(text, n=80):
    """把一条消息压成适合列表显示的一行标题。

    Codex 的 threads.name 是干净的短名（「GridView 表格组件」），但它只覆盖了
    一部分会话；其余只能退回首条消息，而那条消息常带换行、代码块和 markdown 标记。
    这里去掉围栏和行内标记，再折成单行。
    """
    raw = str(text or "")
    if not raw.strip():
        return ""
    # 代码围栏整段丢掉：它后面往往是命令，不是会话在讲什么。
    raw = re.sub(r"```[\s\S]*?```", " ", raw)
    raw = re.sub(r"```[\s\S]*$", " ", raw)  # 未闭合的围栏
    # 行内代码保留文字，去掉反引号；其余常见标记直接去掉符号。
    raw = re.sub(r"`([^`]*)`", r"\1", raw)
    raw = re.sub(r"\*\*([^*]*)\*\*", r"\1", raw)
    raw = re.sub(r"(?m)^\s{0,3}#{1,6}\s*", "", raw)
    raw = re.sub(r"(?m)^\s{0,3}[-*+]\s+", "", raw)
    raw = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", raw)
    return clip(raw, n)


def hhmm(ts):
    """接受秒或毫秒时间戳。"""
    if not ts:
        return "--:--"
    if ts > 1e11:
        ts = ts / 1000
    return time.strftime("%H:%M:%S", time.localtime(ts))


# ─────────────────────────── 派活：app-server JSON-RPC ───────────────────────────
class AppServer:
    def __init__(self):
        self.proc = subprocess.Popen(
            [CODEX, "app-server", "--listen", "stdio://"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
        self.messages = []
        self.lock = threading.Lock()
        threading.Thread(target=self._read, daemon=True).start()
        self._id = 0
        self.call("initialize", {"clientInfo": {"name": "codex-monitor", "version": "0.1"}})
        self.notify("initialized", {})

    def _read(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            with self.lock:
                self.messages.append(msg)

    def _write(self, payload):
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()

    def call(self, method, params=None, timeout=180):
        self._id += 1
        rid = self._id
        self._write({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self.lock:
                for msg in self.messages:
                    if msg.get("id") == rid and ("result" in msg or "error" in msg):
                        if "error" in msg:
                            raise RuntimeError(f"{method}: {msg['error']}")
                        return msg["result"]
            time.sleep(0.05)
        raise TimeoutError(f"{method} 超时")

    def notify(self, method, params=None):
        self._write({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def wait_notification(self, method, timeout):
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self.lock:
                for msg in self.messages:
                    if msg.get("method") == method:
                        return msg.get("params")
            time.sleep(0.2)
        return None

    def close(self):
        try:
            self.proc.terminate()
        except Exception:
            pass


def deliver(thread_id, message, wait_sec, resume=True, srv=None, quiet=False):
    """投递一轮任务。srv 由调用方传入时复用它（新建线程必须复用，否则新进程看不到该线程）。

    quiet=True 时不打印人话，只返回结构化结果，供 UI 的 HTTP 层判断真实成败。
    """
    own = srv is None
    srv = srv or AppServer()
    try:
        if resume:
            srv.call("thread/resume", {"threadId": thread_id})
        result = srv.call(
            "turn/start",
            {"threadId": thread_id, "input": [{"type": "text", "text": message, "text_elements": []}]},
        )
        if quiet:
            return {"delivered": True, "turn": (result or {}).get("turn")}
        print(f"✅ 已把任务投递给 Codex 会话 {thread_id}")
        if wait_sec <= 0:
            print("   （后台执行中，用 `status` 或 `watch` 跟进）")
            return
        print(f"⏳ 等待结果（最多 {wait_sec}s）…")
        params = srv.wait_notification("turn/completed", wait_sec)
        if not params:
            print("   还没跑完，稍后用 status 查看。")
            return
        turn = params.get("turn", {})
        status = TURN_LABEL.get(turn.get("status"), turn.get("status"))
        print(f"状态: {status}   用时: {(turn.get('durationMs') or 0) / 1000:.0f}s")
        for item in turn.get("items") or []:
            if item.get("type") == "agentMessage" and item.get("text"):
                print(f"\nCodex: {item['text']}")
    finally:
        if own:
            srv.close()


# ─────────────────────────── 数据（供 CLI 与 UI 共用）───────────────────────────
def build_list(srv, limit=12):
    """会话列表的结构化视图。UI 与 CLI 共用，避免两套判断逻辑漂移。"""
    threads = latest_threads(limit)
    rows = []
    for t in threads:
        turn, questions = live_turn(srv, t["id"], items_limit=1)
        rows.append((t, turn, questions))

    now_ms = int(time.time() * 1000)
    out = []
    for t, turn, questions in rows:
        kind, age = live_state(t["id"], turn, questions, now_ms)
        items = recent_items(t["id"], 1)
        label, detail = describe_item(items[0]) if items else ("", "")
        out.append({
            "id": t["id"],
            "cwd": t.get("cwd"),
            # 与 Codex 侧栏一致：项目用 projects.name，会话用 threads.name。
            # 两者都可能为空，空的时候才退回目录名 / 首条消息。
            "project": t.get("projectName")
            or os.path.basename(str(t.get("cwd") or ""))
            or "-",
            "projectPosition": t.get("projectPosition"),
            "title": clean_title(t.get("name"))
            or clean_title(t.get("title"))
            or clean_title(first_user_text(t["id"]))
            or "(无标题)",
            "model": t.get("model"),
            "updatedAt": t.get("updated_at"),
            "state": kind,
            "activityAgeSec": None if age is None else int(age),
            "question": questions[0].get("title") if questions else None,
            "questions": questions or [],
            "lastAction": {"label": label, "detail": clip(detail, 200)} if items else None,
        })
    # 等你回答的排最前，其余按最近活动倒序
    order = {"waiting": 0, "running": 1, "failed": 2, "stopped": 3, "done": 4}
    out.sort(key=lambda r: (order.get(r["state"], 9), -(r["updatedAt"] or 0)))
    return {
        "generatedAt": int(time.time() * 1000),
        "counts": {
            "total": len(out),
            "running": sum(1 for r in out if r["state"] == "running"),
            "waiting": sum(1 for r in out if r["state"] == "waiting"),
        },
        "sessions": out,
    }


def build_status(srv, thread_id, items_limit=8, transcript_limit=200):
    """单个会话的详情：轮次、提问、最近动作、聊天记录。"""
    meta = next((t for t in latest_threads(500) if t["id"] == thread_id), {"id": thread_id})
    turn, questions = live_turn(srv, thread_id, items_limit=3)
    kind, age = live_state(thread_id, turn, questions)
    items = recent_items(thread_id, items_limit)
    chat = transcript(thread_id, transcript_limit)
    return {
        "id": thread_id,
        "cwd": meta.get("cwd"),
        "project": meta.get("projectName")
        or os.path.basename(str(meta.get("cwd") or ""))
        or "-",
        "projectPosition": meta.get("projectPosition"),
        "title": clean_title(meta.get("name"))
        or clean_title(meta.get("title"))
        or clean_title(first_user_text(thread_id))
        or "(无标题)",
        "model": meta.get("model"),
        "updatedAt": meta.get("updated_at"),
        "state": kind,
        "activityAgeSec": None if age is None else int(age),
        "turn": {
            "status": (turn or {}).get("status"),
            "startedAt": (turn or {}).get("startedAt"),
            "durationMs": (turn or {}).get("durationMs"),
        } if turn else None,
        "questions": questions or [],
        "transcript": chat["entries"],
        "transcriptTruncated": chat["truncated"],
        "items": [
            {"type": it["type"], "at": it["at"],
             "label": describe_item(it)[0], "detail": clip(describe_item(it)[1], 300)}
            for it in items
        ],
    }


# ─────────────────────────── 输出 ───────────────────────────
def show_list(args):
    srv = AppServer()
    try:
        data = build_list(srv, args.limit)
    finally:
        srv.close()

    if args.json:
        print(json.dumps(data, ensure_ascii=False))
        return
    rows = data["sessions"]
    if not rows:
        print("没读到 Codex 会话（检查 ~/.codex 是否存在）")
        return
    c = data["counts"]
    print(f"本机 Codex 会话 {c['total']} 个 · 正在跑 {c['running']} · 等你回复 {c['waiting']}\n")
    for r in rows:
        state = {
            "running": "▶ 正在跑",
            "waiting": "❓ 等你答",
            "done": "✓ 已完成",
            "failed": "✗ 失败",
            "stopped": "⏸ 已停下",
        }.get(r["state"], "· 空闲")
        print(f"{state:<10} {hhmm(r['updatedAt'])[:5]}  {r['project']:<22} {clip(r['title'], 60)}")
        if r["question"]:
            print(f"{'':<10} {'':<5}  ↳ {clip(r['question'], 88)}")
        print(f"{'':<10} {'':<5}  id={r['id']}")


def show_status(args):
    thread_id = args.thread
    if not thread_id:
        threads = latest_threads(1)
        if not threads:
            print("没有会话")
            return
        thread_id = threads[0]["id"]

    srv = AppServer()
    try:
        d = build_status(srv, thread_id, args.items)
    finally:
        srv.close()

    if args.json:
        print(json.dumps(d, ensure_ascii=False))
        return

    print(f"会话: {clip(d['title'], 70)}")
    print(f"  id       {d['id']}")
    print(f"  目录     {d['cwd']}")
    print(f"  模型     {d['model']}")
    print(f"  最近活动 {hhmm(d['updatedAt'])}")

    if d["turn"]:
        state = {
            "running": "进行中",
            "waiting": "已停下（等你回答）",
            "done": "已完成",
            "failed": "失败",
            "stopped": "已停下",
        }.get(d["state"], TURN_LABEL.get(d["turn"]["status"], d["turn"]["status"]))
        dur_ms = d["turn"].get("durationMs")
        if dur_ms:
            dur = f"用时 {dur_ms / 1000:.0f}s"
        elif d["state"] == "running":
            dur = "计时中"
        else:
            dur = "无耗时记录"
        print(f"  当前轮次 {state}（开始 {hhmm(d['turn'].get('startedAt'))}，{dur}）")

    if d["questions"]:
        print("\n❓ Codex 正在等你拍板：")
        for q in d["questions"]:
            print(f"   {q.get('title')}")
            for opt in q.get("options") or []:
                print(f"     - {opt}")

    if d["items"]:
        print("\n最近动作（新的在上）:")
        for it in d["items"]:
            print(f"  {hhmm(it['at'])}  {it['label']:<8} {clip(it['detail'], 100)}")


def show_watch(args):
    if args.once:
        rows = []
        for t in latest_threads(args.limit):
            items = recent_items(t["id"], 1)
            if items:
                label, detail = describe_item(items[0])
                rows.append(f"{hhmm(items[0]['at'])} {os.path.basename(str(t.get('cwd') or '')):<20} {label}: {clip(detail, 90)}")
        print("\n".join(rows) or "暂无活动")
        return
    print(f"监控中（每 {args.interval}s 刷新，Ctrl-C 退出）\n")
    seen = {}
    try:
        while True:
            threads = latest_threads(args.limit)
            for t in threads:
                turn = latest_turn(t["id"])
                items = recent_items(t["id"], 1)
                last = items[0]["at"] if items else 0
                key = t["id"]
                if key not in seen:
                    seen[key] = last
                    continue
                if last > seen[key]:
                    seen[key] = last
                    label, detail = describe_item(items[0])
                    kind, _ = live_state(t["id"], turn, None)
                    status = {"running": "进行中", "done": "已完成", "failed": "失败"}.get(kind, "")
                    print(f"[{hhmm(time.time())}] {os.path.basename(str(t.get('cwd') or '')):<20} {status:<6} {label}: {clip(detail, 80)}")
                qs = pending_question(t["id"])
                if qs and not seen.get(key + ":q"):
                    seen[key + ":q"] = True
                    print(f"[{hhmm(time.time())}] ⚠️ {os.path.basename(str(t.get('cwd') or ''))} 等你回答: {clip(qs[0].get('title'), 80)}")
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\n已停止监控")


def serve(port=0, host="127.0.0.1"):
    """长驻 HTTP 服务，供 DSH 插件的 UI 轮询。

    只起一个 AppServer 复用到所有请求，避免每次轮询都拉起新进程（约 2s 开销）。
    """
    import http.server
    import socketserver
    import urllib.parse

    srv_lock = threading.Lock()
    app = {"srv": None}

    def app_server():
        """惰性建立并复用 app-server；失败后下次请求重试。"""
        if app["srv"] is None:
            app["srv"] = AppServer()
        return app["srv"]

    def reset_app_server():
        if app["srv"] is not None:
            try:
                app["srv"].close()
            except Exception:
                pass
            app["srv"] = None

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _json(self, obj, code=200):
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = urllib.parse.urlparse(self.path).path
            if path == "/codex-monitor/ping":
                self._json({"ok": True, "pid": os.getpid()})
                return
            if path == "/codex-monitor/state":
                qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                limit = int((qs.get("limit") or ["12"])[0])
                try:
                    with srv_lock:
                        self._json({"ok": True, "data": build_list(app_server(), limit)})
                except Exception as exc:
                    reset_app_server()
                    self._json({"ok": False, "error": str(exc)}, 500)
                return
            self._json({"ok": False, "error": "not found"}, 404)

        def do_POST(self):
            path = urllib.parse.urlparse(self.path).path
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            try:
                payload = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                self._json({"ok": False, "error": "bad json"}, 400)
                return

            if path == "/codex-monitor/state":
                try:
                    with srv_lock:
                        self._json({"ok": True, "data": build_list(app_server(), int(payload.get("limit") or 12))})
                except Exception as exc:
                    reset_app_server()
                    self._json({"ok": False, "error": str(exc)}, 500)
                return

            if path == "/codex-monitor/status":
                tid = payload.get("threadId")
                if not tid:
                    self._json({"ok": False, "error": "threadId required"}, 400)
                    return
                try:
                    with srv_lock:
                        self._json({"ok": True, "data": build_status(
                            app_server(), tid,
                            int(payload.get("items") or 8),
                            int(payload.get("transcript") or 200),
                        )})
                except Exception as exc:
                    reset_app_server()
                    self._json({"ok": False, "error": str(exc)}, 500)
                return

            if path == "/codex-monitor/send":
                tid, msg = payload.get("threadId"), (payload.get("message") or "").strip()
                if not tid or not msg:
                    self._json({"ok": False, "error": "threadId and message required"}, 400)
                    return
                try:
                    with srv_lock:
                        cur = app_server()
                        cur.call("thread/resume", {"threadId": tid})
                        cur.call("turn/start", {"threadId": tid, "input": [
                            {"type": "text", "text": msg, "text_elements": []}]})
                    self._json({"ok": True, "delivered": True})
                except Exception as exc:
                    reset_app_server()
                    self._json({"ok": False, "error": str(exc)}, 500)
                return

            self._json({"ok": False, "error": "not found"}, 404)

    class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
        daemon_threads = True
        allow_reuse_address = True

    httpd = Server((host, port), Handler)
    print(json.dumps({"ready": True, "port": httpd.server_address[1]}), flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        reset_app_server()


def main():
    ap = argparse.ArgumentParser(description="监控并驱动本机 Codex 桌面版")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("list", help="会话列表 + 运行状态")
    p.add_argument("--limit", type=int, default=12)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=show_list)

    p = sub.add_parser("status", help="某会话的详细工作状态")
    p.add_argument("--thread")
    p.add_argument("--items", type=int, default=8)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=show_status)

    p = sub.add_parser("watch", help="持续监控变化")
    p.add_argument("--interval", type=int, default=5)
    p.add_argument("--limit", type=int, default=8)
    p.add_argument("--once", action="store_true", help="只输出一次快照")
    p.set_defaults(func=show_watch)

    p = sub.add_parser("send", help="给已有会话派活")
    p.add_argument("--thread", required=True)
    p.add_argument("--message", required=True)
    p.add_argument("--wait", type=int, default=0)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_send)

    p = sub.add_parser("serve", help="长驻 HTTP 服务（供 UI 插件使用）")
    p.add_argument("--port", type=int, default=0)
    p.add_argument("--host", default="127.0.0.1")
    p.set_defaults(func=lambda a: serve(a.port, a.host))

    p = sub.add_parser("new", help="开新会话并派活")
    p.add_argument("--cwd", required=True)
    p.add_argument("--message", required=True)
    p.add_argument("--wait", type=int, default=0)
    p.set_defaults(func=lambda a: deliver_new(a))

    args = ap.parse_args()
    args.func(args)


def cmd_send(args):
    """CLI 入口。--json 时输出结构化结果，且失败也以 JSON 报错（供 UI 判断）。"""
    if not args.json:
        deliver(args.thread, args.message, args.wait, resume=True)
        return
    try:
        result = deliver(args.thread, args.message, args.wait, resume=True, quiet=True)
        print(json.dumps({"ok": True, **result}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        sys.exit(1)


def deliver_new(args):
    srv = AppServer()
    try:
        res = srv.call(
            "thread/start",
            {"cwd": os.path.abspath(args.cwd), "approvalPolicy": "never", "sandbox": "danger-full-access"},
        )
        tid = res["thread"]["id"]
        deliver(tid, args.message, args.wait, resume=False, srv=srv)
    finally:
        srv.close()


if __name__ == "__main__":
    sys.exit(main())
