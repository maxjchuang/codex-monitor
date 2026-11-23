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
import sqlite3
import subprocess
import sys
import threading
import time

CODEX = os.environ.get("CODEX_BIN", "codex")
CODEX_HOME = os.environ.get("CODEX_HOME", os.path.expanduser("~/.codex"))
HIST_DB = os.path.join(CODEX_HOME, "thread_history_1.sqlite")
STATE_DB = os.path.join(CODEX_HOME, "state_5.sqlite")

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


def latest_threads(limit=20, include_archived=False):
    """按最近活动取会话（threads 表带 title/cwd，比 app-server 的 preview 更准）。"""
    conn = db(STATE_DB)
    if not conn:
        return []
    try:
        rows = conn.execute(
            "select id, title, cwd, updated_at, model, tokens_used, rollout_path "
            "from threads order by updated_at desc limit ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]
    except sqlite3.Error:
        return []
    finally:
        conn.close()


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
        out.append({"type": r["item_type"], "at": r["created_at_ms"], "data": payload})
    return out


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


def live_state(thread_id, turn, questions, now_ms=None):
    """综合判断会话此刻的状态。

    桌面版会把正在跑的轮次持久化成 interrupted，所以“最近是否有新动作”比
    turn.status 更可信；提问优先，因为它意味着 Codex 已经停下来了。
    """
    now_ms = now_ms or int(time.time() * 1000)
    age = (now_ms - last_activity_at(thread_id)) / 1000
    if questions:
        return "waiting", age
    if age <= 90:
        return "running", age
    status = (turn or {}).get("status")
    if status == "completed":
        return "done", age
    if status == "failed":
        return "failed", age
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
    return t, ""


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


def deliver(thread_id, message, wait_sec, resume=True, srv=None):
    """投递一轮任务。srv 由调用方传入时复用它（新建线程必须复用，否则新进程看不到该线程）。"""
    own = srv is None
    srv = srv or AppServer()
    try:
        if resume:
            srv.call("thread/resume", {"threadId": thread_id})
        srv.call(
            "turn/start",
            {"threadId": thread_id, "input": [{"type": "text", "text": message, "text_elements": []}]},
        )
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


# ─────────────────────────── 输出 ───────────────────────────
def show_list(args):
    threads = latest_threads(args.limit)
    if not threads:
        print("没读到 Codex 会话（检查 ~/.codex 是否存在）")
        return

    srv = AppServer()
    rows = []
    try:
        for t in threads:
            turn, questions = live_turn(srv, t["id"], items_limit=1)
            rows.append((t, turn, questions))
    finally:
        srv.close()

    now_ms = int(time.time() * 1000)
    kinds = [live_state(t["id"], turn, q, now_ms)[0] for t, turn, q in rows]
    running = kinds.count("running")
    waiting = kinds.count("waiting")
    print(f"本机 Codex 会话 {len(rows)} 个 · 正在跑 {running} · 等你回复 {waiting}\n")

    for t, turn, questions in rows:
        kind, _ = live_state(t["id"], turn, questions, now_ms)
        state = {
            "running": "▶ 正在跑",
            "waiting": "❓ 等你答",
            "done": "✓ 已完成",
            "failed": "✗ 失败",
            "stopped": "⏸ 已停下",
        }.get(kind, "· 空闲")
        cwd = os.path.basename(str(t.get("cwd") or "")) or "-"
        title = t.get("title") or clip(first_user_text(t["id"]), 60) or "(无标题)"
        print(f"{state:<10} {hhmm(t['updated_at'])[:5]}  {cwd:<22} {clip(title, 60)}")
        if questions:
            print(f"{'':<10} {'':<5}  ↳ {clip(questions[0].get('title'), 88)}")
        print(f"{'':<10} {'':<5}  id={t['id']}")


def show_status(args):
    thread_id = args.thread
    meta = None
    if not thread_id:
        threads = latest_threads(1)
        if not threads:
            print("没有会话")
            return
        meta, thread_id = threads[0], threads[0]["id"]
    else:
        meta = next((t for t in latest_threads(500) if t["id"] == thread_id), {"id": thread_id})

    srv = AppServer()
    try:
        turn, questions = live_turn(srv, thread_id, items_limit=3)
    finally:
        srv.close()

    print(f"会话: {clip(meta.get('title') or '(无标题)', 70)}")
    print(f"  id       {thread_id}")
    print(f"  目录     {meta.get('cwd')}")
    print(f"  模型     {meta.get('model')}")
    print(f"  最近活动 {hhmm(meta.get('updated_at'))}")

    kind, _ = live_state(thread_id, turn, questions)
    if turn:
        state = {
            "running": "进行中",
            "waiting": "已停下（等你回答）",
            "done": "已完成",
            "failed": "失败",
            "stopped": "已停下",
        }.get(kind, TURN_LABEL.get(turn.get("status"), turn.get("status")))
        if turn.get("durationMs"):
            dur = f"用时 {turn['durationMs'] / 1000:.0f}s"
        elif kind == "running":
            dur = "计时中"
        else:
            dur = "无耗时记录"
        started = turn.get("startedAt")
        print(f"  当前轮次 {state}（开始 {hhmm(started)}，{dur}）")
    if questions:
        print("\n❓ Codex 正在等你拍板：")
        for q in questions:
            print(f"   {q.get('title')}")
            for opt in q.get("options") or []:
                print(f"     - {opt}")

    items = recent_items(thread_id, args.items)
    if items:
        print("\n最近动作（新的在上）:")
        for it in items:
            label, detail = describe_item(it)
            print(f"  {hhmm(it['at'])}  {label:<8} {clip(detail, 100)}")

    if args.json:
        print("\n--- JSON ---")
        print(json.dumps({"thread": meta, "turn": turn, "questions": questions, "items": items},
                         ensure_ascii=False, indent=2))


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


def main():
    ap = argparse.ArgumentParser(description="监控并驱动本机 Codex 桌面版")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("list", help="会话列表 + 运行状态")
    p.add_argument("--limit", type=int, default=12)
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
    p.set_defaults(func=lambda a: deliver(a.thread, a.message, a.wait, resume=True))

    p = sub.add_parser("new", help="开新会话并派活")
    p.add_argument("--cwd", required=True)
    p.add_argument("--message", required=True)
    p.add_argument("--wait", type=int, default=0)
    p.set_defaults(func=lambda a: deliver_new(a))

    args = ap.parse_args()
    args.func(args)


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
