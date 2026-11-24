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
import base64
import fcntl
import json
import mimetypes
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

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


def latest_threads(limit=20, include_archived=False, order="recent"):
    """按最近活动取会话。

    标题取 threads.name（Codex 侧栏显示的就是它），没有 name 时才退回 title。
    项目名取 projects.name，按 cwd 反查 project_roots 得到。

    include_archived=False 时排除已归档的会话：Codex 侧栏也不显示它们，
    而且归档里大多是验收用的短会话，混进来会把真正在用的挤下去。
    order 决定排序字段，"recent" 用 recency_at_ms（Codex 记的最近使用时间），
    "updated" 用 updated_at_ms。
    """
    conn = db(STATE_DB)
    if not conn:
        return []
    try:
        rows = conn.execute(
            # subagent 会话是子 agent 的内部线程，Codex 侧栏不把它们当作独立会话，
            # 所以这里排除，否则列表会被并行的子任务刷满。
            "select id, title, name, cwd, updated_at, model, tokens_used, "
            "rollout_path, is_pinned, source, thread_source, preview, "
            "recency_at_ms, archived, thread_section_id, section_position "
            "from threads "
            "where coalesce(thread_source, '') != 'subagent' "
            # 既没有 name 也没有首条消息的会话是空壳（有 turn 但没有任何 item），
            # Codex 侧栏也不显示，留着只会占位置。
            "  and (coalesce(name, '') != '' or coalesce(title, '') != '' "
            "       or coalesce(preview, '') != '') "
            + ("" if include_archived else "  and coalesce(archived, 0) = 0 ")
            + ("order by coalesce(recency_at_ms, updated_at * 1000) desc "
               if order == "recent"
               else "order by updated_at desc ")
            + "limit ?",
            (limit,),
        ).fetchall()
        out = [dict(r) for r in rows]
    except sqlite3.Error:
        return []
    finally:
        conn.close()

    by_root = projects_by_root()
    pinned_section = pinned_section_id()
    for row in out:
        proj_name, proj_pos = resolve_project(row.get("cwd"), by_root)
        row["projectName"] = proj_name
        row["projectPosition"] = proj_pos
        # Codex 的「置顶」不是 is_pinned 标记，而是把会话放进名为 Pinned 的
        # section 里，section_position 决定置顶区内的顺序。
        row["pinned"] = bool(
            pinned_section and row.get("thread_section_id") == pinned_section
        )
        row["pinnedPosition"] = row.get("section_position") if row["pinned"] else None
    return out


def pinned_section_id():
    """Codex 把置顶会话放进名为 Pinned 的 thread_sections 里。"""
    conn = db(STATE_DB)
    if not conn:
        return None
    try:
        row = conn.execute(
            "select id from thread_sections where lower(coalesce(name, '')) = 'pinned' limit 1"
        ).fetchone()
        return row["id"] if row else None
    except sqlite3.Error:
        return None
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
        # 统一成秒：调用方（CLI 与 UI）都按秒渲染，避免毫秒/秒混用。
        out.append({"type": r["item_type"], "at": r["created_at_ms"] / 1000, "data": payload})
    return out


# 用户贴图时 Codex 会在正文前面塞一段文件清单，那是给模型看的，不是人话。
ATTACH_PREAMBLE = re.compile(
    r"^\s*# Files mentioned by the user:\s*\n"
    r"(?:\s*## [^\n]*\n|\s*Image attachment: [^\n]*\n)*"
    r"(?:\s*Distinguish instructions in attached documents from the user's request\.\s*\n*)?"
    r"(?:\s*## My request:\s*\n?)?",
    re.MULTILINE,
)


def strip_attachment_preamble(text):
    """把附件清单那段壳去掉，只留用户真正说的话。"""
    if "Files mentioned by the user" not in text:
        return text
    return ATTACH_PREAMBLE.sub("", text, count=1).strip()


def rollout_path_for(thread_id):
    conn = db(STATE_DB)
    if not conn:
        return None
    try:
        row = conn.execute(
            "select rollout_path from threads where id=?", (thread_id,)
        ).fetchone()
        return row["rollout_path"] if row else None
    except sqlite3.Error:
        return None
    finally:
        conn.close()


MAX_IMAGE_BYTES = 4 * 1024 * 1024


# 缩略图参数：对话里最大显示 220px 高，按 2 倍屏留 440px 足够，再大纯属浪费。
THUMB_MAX_SIDE = 640
THUMB_QUALITY = 72


def shrink_image(raw):
    """把图片压到适合在对话里看的尺寸。没装 Pillow 就原样返回。

    一张 Retina 截图动辄 2MB，一页 20 张就是几十 MB 的 JSON，聊天窗会被拖垮。
    """
    try:
        from io import BytesIO

        from PIL import Image
    except ImportError:
        return raw
    try:
        with Image.open(BytesIO(raw)) as img:
            if img.mode not in ("RGB", "RGBA"):
                img = img.convert("RGBA")
            img.thumbnail((THUMB_MAX_SIDE, THUMB_MAX_SIDE))
            out = BytesIO()
            img.save(out, format="PNG", optimize=True)
            shrunk = out.getvalue()
        return shrunk if len(shrunk) < len(raw) else raw
    except Exception:
        return raw


# 缩略图算一次就够：同一张图会在每次轮询里重复出现，重算是纯浪费。
_IMAGE_CACHE = {}
_IMAGE_CACHE_MAX = 128


def image_data_url(path, rollout_path=None):
    """把 localImage 的路径变成能直接塞进 <img> 的 data URL。

    先读本地文件；临时目录会被系统清掉，读不到就去 rollout 里找同一路径的内嵌
    副本（Codex 自己存了一份 base64）。两处都没有就返回 None。
    """
    try:
        stamp = os.path.getmtime(path)
    except OSError:
        stamp = None
    key = (path, stamp, rollout_path)
    if key in _IMAGE_CACHE:
        return _IMAGE_CACHE[key]
    try:
        with open(path, "rb") as handle:
            raw = handle.read(MAX_IMAGE_BYTES + 1)
        if 0 < len(raw) <= MAX_IMAGE_BYTES:
            mime = mimetypes.guess_type(path)[0] or "image/png"
            url = f"data:{mime};base64,{base64.b64encode(shrink_image(raw)).decode()}"
            remember_image(key, url)
            return url
    except OSError:
        pass
    url = rollout_image(rollout_path, path)
    remember_image(key, url)
    return url


# Codex 给你发图的方式是在正文里写 Markdown 图片，路径是本机绝对路径：
#   ![说明](/Users/.../shot.png)
# 浏览器打不开 file:// 路径，所以要把这些路径换成 data URL。
MD_IMAGE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)\)")


def inline_markdown_images(text, rollout_path=None):
    """把正文里指向本机文件的 Markdown 图片换成 data URL。

    只换真的读得到、而且确实是图片的路径。换不了的原样留着，前端会退化成
    一个「打不开的图」而不是静默消失——用户至少知道 Codex 发了张图。
    """
    if not text or "![" not in text:
        return text

    def swap(match):
        alt, path = match.group(1), match.group(2)
        if not os.path.isabs(path):
            return match.group(0)
        url = image_data_url(path, rollout_path)
        if not url:
            return match.group(0)
        return f"![{alt}]({url})"

    return MD_IMAGE.sub(swap, text)


def remember_image(key, url):
    if len(_IMAGE_CACHE) >= _IMAGE_CACHE_MAX:
        _IMAGE_CACHE.clear()
    _IMAGE_CACHE[key] = url


def shrink_data_url(url):
    """rollout 里的内嵌图同样要压，否则回退路径会塞进一张 2MB 的图。"""
    try:
        header, encoded = url.split(",", 1)
        raw = base64.b64decode(encoded)
    except (ValueError, TypeError):
        return url
    if len(raw) > MAX_IMAGE_BYTES:
        return None
    return f"{header},{base64.b64encode(shrink_image(raw)).decode()}"


def rollout_image(rollout_path, path):
    """从 rollout jsonl 里捞回某张图的 base64。按路径精确匹配，不靠顺序。"""
    if not rollout_path or not os.path.exists(rollout_path):
        return None
    try:
        with open(rollout_path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if "input_image" not in line or path not in line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                payload = record.get("payload") or {}
                content = payload.get("content") or []
                if not any(path in (seg.get("text") or "") for seg in content
                           if seg.get("type") == "input_text"):
                    continue
                for seg in content:
                    url = seg.get("image_url") or ""
                    if seg.get("type") == "input_image" and url.startswith("data:image/"):
                        return shrink_data_url(url)
    except OSError:
        pass
    return None


def projection_stalled(thread_id, rollout_path):
    """Codex 的历史投影是不是卡住了。

    正常情况下投影游标就等于 rollout 文件的字节数——每个会话都精确相等。但如果
    rollout 被压缩重写过（Faster Agent 那个会话就是），游标会远大于文件大小，
    投影器按旧偏移找不到新记录，于是永远停在那儿，历史库再也追不上 rollout。
    这种情况下只能自己去 rollout 里把后面的对话补出来。
    """
    if not rollout_path or not os.path.exists(rollout_path):
        return False
    conn = db(HIST_DB)
    if not conn:
        return False
    try:
        row = conn.execute(
            "select next_rollout_byte_offset from thread_history_projection_state "
            "where thread_id=?", (thread_id,)
        ).fetchone()
    except sqlite3.Error:
        return False
    finally:
        conn.close()
    if not row or row["next_rollout_byte_offset"] is None:
        return False
    try:
        size = os.path.getsize(rollout_path)
    except OSError:
        return False
    return row["next_rollout_byte_offset"] > size


def rollout_entries(rollout_path):
    """从 rollout 里读出用户和 Codex 说过的话，形状和 transcript 的条目一致。"""
    out = []
    if not rollout_path or not os.path.exists(rollout_path):
        return out
    try:
        handle = open(rollout_path, encoding="utf-8", errors="replace")
    except OSError:
        return out
    with handle:
        for line in handle:
            if "item_completed" not in line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            payload = record.get("payload") or {}
            if payload.get("type") != "item_completed":
                continue
            item = payload.get("item") or {}
            kind = item.get("type")
            at = (payload.get("completed_at_ms") or payload.get("started_at_ms") or 0) / 1000
            if not at:
                continue
            if kind == "UserMessage":
                content = item.get("content") or []
                text = " ".join(
                    seg.get("text", "") for seg in content if seg.get("type") == "text"
                ).strip()
                text = strip_attachment_preamble(text)
                images = [seg.get("path") for seg in content
                          if seg.get("type") == "localImage" and seg.get("path")]
                if text or images:
                    entry = {"role": "user", "at": at, "text": text, "id": item.get("id")}
                    if images:
                        entry["images"] = images
                    out.append(entry)
            elif kind == "AgentMessage":
                text = " ".join(
                    seg.get("text", "") for seg in item.get("content") or []
                    if seg.get("type") == "Text"
                ).strip()
                if text:
                    out.append({
                        "role": "agent", "at": at, "text": text,
                        "final": True, "id": item.get("id"), "questions": None,
                    })
    return out


def transcript(thread_id, limit=200, scan_limit=4000, before=None):
    """按时间正序返回一段对话，供聊天窗口渲染。

    只保留对“读起来像聊天”有意义的条目：用户说的话、Codex 说的话，以及被折叠成
    一行的动作（跑命令、改文件等）。推理过程不入正文，避免把聊天窗口灌满。

    before 是毫秒时间戳游标，只取早于它的条目，用于向上滚动加载更多。
    """
    conn = db(HIST_DB)
    if not conn:
        return {"entries": [], "truncated": False}
    try:
        # A busy session can be thousands of rows of mostly commands and reasoning.
        # Scanning a wider window (then trimming to `limit` below) keeps the actual
        # conversation from being crowded out by tool chatter.
        if before:
            rows = conn.execute(
                "select item_type, created_at_ms, item_json from thread_items "
                "where thread_id=? and created_at_ms < ? "
                "order by created_at_ms desc limit ?",
                (thread_id, int(before), max(1, scan_limit)),
            ).fetchall()
        else:
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
            content = payload.get("content") or []
            # 用户贴的图存成 localImage，只带一个临时目录路径。临时文件会被系统清掉
            # （实测 155 张里 40 张还在），所以拿不到时回退到 rollout 里的内嵌副本。
            images = [c.get("path") for c in content
                      if c.get("type") == "localImage" and c.get("path")]
            text = " ".join(
                c.get("text", "") for c in content if c.get("type") == "text"
            ).strip()
            text = strip_attachment_preamble(text)
            entry = {"role": "user", "at": at, "text": text, "id": payload.get("id")}
            if images:
                entry["images"] = images
            if text or images:
                out.append(entry)
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

    # 先分组再裁剪：先 trim 会把一轮切碎（结尾那几十条命令占满了窗口，
    # 用户的提问和最终答复反而被挤掉），而且 work 块也就没法成立。
    rollout = rollout_path_for(thread_id)
    # 投影卡住时，历史库缺的是最后那几轮对话——正是用户最想看的。用 rollout 补上。
    if not before and projection_stalled(thread_id, rollout):
        newest = max((r["created_at_ms"] for r in rows), default=0)
        for entry in rollout_entries(rollout):
            if entry["at"] * 1000 > newest:
                out.append(entry)
        out.sort(key=lambda e: e["at"])

    # 图片只在真正要返回的条目上解析：一条消息的 base64 能有 2MB，给整页
    # 都解一遍既慢又占内存，而裁掉的那些根本不会显示。
    for entry in out:
        paths = entry.pop("images", None)
        if paths:
            urls = [url for url in (image_data_url(p, rollout) for p in paths) if url]
            if urls:
                entry["images"] = urls
        # Codex 发给用户的图写在正文里（Markdown 图片 + 本机绝对路径），
        # 和上面那种「用户附的图」是两条路径，得分别处理。
        if entry.get("role") == "agent" and entry.get("text"):
            entry["text"] = inline_markdown_images(entry["text"], rollout)

    grouped = group_turns(out, turn_spans(thread_id))
    kept = trim_turns(grouped, limit)
    # 还有更早的内容吗？把游标一起返回，前端向上滚时带着它来要上一页。
    # 判断依据是「这一页是否被裁过」或者「扫描窗口本身就已经满了」。
    more = len(kept) < len(grouped) or len(rows) >= max(1, scan_limit)
    # 游标必须取「这一页最早那条」的时间，不能取扫描窗口的最后一行：
    # 窗口是按 4000 行截的，那一行可能比本页最早的一条还早好几天，
    # 拿它当游标会直接跳到几天前，第二页就空了。
    oldest = int(kept[0]["at"] * 1000) if kept and kept[0].get("at") else None
    return {
        "entries": kept,
        "truncated": truncated,
        "hasMore": bool(more and oldest),
        "before": oldest,
    }


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


def trim_turns(grouped, limit):
    """按轮保留最近 limit 条，再把相邻的同轮动作压一下。

    裁剪单位是「条目」但计数按分组后的结果来，因为一个 work 块无论里面装了多少
    条命令，在界面上只占一行。这样窗口里留下的是若干轮完整对话，而不是一截被
    命令灌满的尾巴。
    """
    if not grouped:
        return []
    kept = grouped[-limit:] if limit and len(grouped) > limit else grouped
    # 截断可能落在一轮中间，把开头那个孤立的 work 块丢掉，免得首屏是一段
    # 没有提问也没有结论的过程。
    if len(kept) < len(grouped) and kept and kept[0]["role"] == "work":
        kept = kept[1:]
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
def _notification_is_for(msg, thread_id=None, turn_id=None):
    """这条通知是不是我们要等的那一轮。

    派了子代理之后，子代理是独立 thread，会先发自己的 turn/completed。
    只按方法名匹配的话，主轮次还在等子代理就被当成跑完了，调用方关掉进程，
    主轮次直接变 interrupted——用户看到的就是「派完活任务自己停了」。

    优先按 turnId 判断，它精确到某一轮；没有 turnId 才退回 threadId。
    两个都判断不出来时返回 False：宁可多等到超时，也不能误判成结束。
    """
    params = msg.get("params") or {}
    if not isinstance(params, dict):
        return False
    turn = params.get("turn")
    turn = turn if isinstance(turn, dict) else {}
    if turn_id is not None:
        # 真实字段是 turn.id；turn.turnId 是历史写法，一起认，避免哪天又改回去。
        got = turn.get("id") or turn.get("turnId") or params.get("turnId")
        if got is not None:
            return got == turn_id
    if thread_id is not None:
        got = params.get("threadId") or turn.get("threadId")
        if got is not None:
            return got == thread_id
    return False


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
        # 读线程收到消息就唤醒等结果的人，不再靠轮询。
        self.cond = threading.Condition(self.lock)
        # stdin 是多线程共用的，写一条完整的行必须独占。
        self._write_lock = threading.Lock()
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
            with self.cond:
                self.messages.append(msg)
                self.cond.notify_all()

    def _write(self, payload):
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()

    def call(self, method, params=None, timeout=180):
        with self._write_lock:
            self._id += 1
            rid = self._id
            self._write({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
        deadline = time.time() + timeout
        with self.cond:
            while True:
                for i, msg in enumerate(self.messages):
                    if msg.get("id") == rid and ("result" in msg or "error" in msg):
                        # 拿到的应答立刻从缓冲里删掉，长跑的服务不会越攒越多。
                        del self.messages[i]
                        if "error" in msg:
                            raise RuntimeError(f"{method}: {msg['error']}")
                        return msg["result"]
                remaining = deadline - time.time()
                if remaining <= 0:
                    raise TimeoutError(f"{method} 超时")
                # 50ms 一次的空转改成阻塞等通知：有应答立刻醒，没应答就睡到超时。
                self.cond.wait(min(remaining, 1.0))

    def notify(self, method, params=None):
        self._write({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def wait_notification(self, method, timeout, thread_id=None, turn_id=None):
        """等某条通知。给了 thread_id / turn_id 就只认那一轮。

        必须过滤：派了子代理之后，子代理是独立 thread，会先发自己的
        turn/completed。只认方法名的话，主轮次还在等子代理就被当成结束，
        调用方关进程，主轮次直接变 interrupted——任务看着就是「自己停了」。
        """
        deadline = time.time() + timeout
        with self.cond:
            while True:
                for i, msg in enumerate(self.messages):
                    if msg.get("method") != method:
                        continue
                    if (thread_id is not None or turn_id is not None) and not _notification_is_for(
                        msg, thread_id, turn_id
                    ):
                        continue
                    del self.messages[i]
                    return msg.get("params")
                remaining = deadline - time.time()
                if remaining <= 0:
                    return None
                self.cond.wait(min(remaining, 1.0))

    def close(self, wait=2.0):
        """关掉进程并等它真的退出。

        app-server 在退出时才释放 thread 的写入锁，所以「terminate 完立刻重试」
        会和还没退干净的旧进程抢同一把锁。等一会儿。
        """
        try:
            self.proc.terminate()
        except Exception:
            return
        try:
            self.proc.wait(timeout=wait)
        except Exception:
            try:
                self.proc.kill()
                self.proc.wait(timeout=1.0)
            except Exception:
                pass


LOCK_DIR = os.path.join(CODEX_HOME, "thread-writer-locks")


def thread_locked(thread_id):
    """这个会话的写入锁是否被别的进程占着。

    Codex 给每个 thread 一个 .lock 文件，持有者用 flock 独占。直接试着拿一次
    非阻塞锁就知道结果，不用真的 resume —— resume 反而会自己占住它。
    """
    path = os.path.join(LOCK_DIR, f"{thread_id}.lock")
    if not os.path.exists(path):
        return False
    try:
        # 只读打开：探测锁不需要写权限，也绝不碰 Codex 的数据。
        with open(path, "r") as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                return True
            fcntl.flock(handle, fcntl.LOCK_UN)
            return False
    except OSError:
        return False


DESKTOP_OWNER = re.compile(r"/(?:ChatGPT|Codex)\.app/Contents/.+/codex$", re.I)


def lock_owner(thread_id):
    """谁占着这个会话的锁。

    光知道「被占着」不够：Codex 桌面端只要打开过某个会话就一直占着不放，
    哪怕它已经闲着几小时。这种情况下关掉桌面端就能发，而正在跑的时候只能等。
    用 lsof 拿到 pid 再看进程路径，才分得清是哪一种。
    """
    path = os.path.join(LOCK_DIR, f"{thread_id}.lock")
    if not os.path.exists(path):
        return None
    try:
        out = subprocess.run(
            ["/usr/sbin/lsof", "-nP", "-t", "--", path],
            capture_output=True, text=True, timeout=2.0,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    pid = out.split()[0] if out else ""
    if not pid.isdigit():
        return None
    try:
        command = subprocess.run(
            ["/bin/ps", "-p", pid, "-o", "comm="],
            capture_output=True, text=True, timeout=2.0,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return {"pid": int(pid), "command": "", "desktop": False}
    return {"pid": int(pid), "command": command, "desktop": bool(DESKTOP_OWNER.search(command))}


WRITER_BUSY = "already has an active writer"


def is_writer_busy(exc):
    return WRITER_BUSY in str(exc)


def push_turn(srv, thread_id, message):
    """resume 之后投一轮。srv 必须是新进程，否则 resume 会撞上自己的锁。

    注意：调用方不能让 srv 在轮次结束前退出。app-server 一退出，Codex 就把在飞的
    轮次记成 interrupted，任务实际没跑（实测 durationMs 只有 61ms）。投递请用
    deliver_and_release()，它会等这一轮跑完再关进程。
    """
    srv.call("thread/resume", {"threadId": thread_id})
    return srv.call(
        "turn/start",
        {"threadId": thread_id, "input": [
            {"type": "text", "text": message, "text_elements": []}]},
    )


# 投递之后必须让 app-server 活到轮次结束。它一退出，Codex 就把在飞的轮次
# 记成 interrupted，任务实际没跑——实测 durationMs 只有 61ms。
# 但也不能让它一直活着：resume 会把会话锁挂在这个进程上，直到进程退出才放，
# 那样 Codex 桌面端就再也拿不到这个会话了。
# 所以投递走后台线程，等这一轮跑完再关。
DELIVER_TURN_TIMEOUT = 1800


def deliver_and_release(thread_id, message, timeout=DELIVER_TURN_TIMEOUT):
    """投递一轮，等它跑完，再放掉会话锁。

    返回 {"delivered": bool, "status": str, "error": str|None}。
    """
    srv = AppServer()
    try:
        started = push_turn(srv, thread_id, message)
        turn_id = ((started or {}).get("turn") or {}).get("id")
        params = srv.wait_notification(
            "turn/completed", timeout, thread_id=thread_id, turn_id=turn_id
        )
        if not params:
            # 没等到结束通知不代表没投递，任务可能还在跑，只是超过了等待上限。
            return {"delivered": True, "status": "running", "error": None}
        turn = params.get("turn") or {}
        return {"delivered": True, "status": turn.get("status"), "error": None}
    except Exception as exc:
        return {"delivered": False, "status": "failed", "error": str(exc)}
    finally:
        srv.close()


def deliver_async(thread_id, message, on_done=None):
    """把投递丢到后台，HTTP 立刻返回，任务继续跑。"""

    def run():
        result = deliver_and_release(thread_id, message)
        if on_done is not None:
            try:
                on_done(result)
            except Exception:
                pass

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread


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
        turn_id = ((result or {}).get("turn") or {}).get("id")
        params = srv.wait_notification(
            "turn/completed", wait_sec, thread_id=thread_id, turn_id=turn_id
        )
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
def build_list(srv, limit=12, order="recent"):
    """会话列表的结构化视图。UI 与 CLI 共用，避免两套判断逻辑漂移。

    order 只影响「非置顶」那部分：置顶会话永远单独成一组排在最前，
    组内按 Codex 的 section_position 排。
    """
    threads = latest_threads(limit, order=order)
    # 每个会话都要问一次 app-server，串行做 N 个会话就是 N 次往返。
    # 并发发出去，总耗时从「N 倍单次」变成「一次往返」。
    rows = []
    if threads:
        with ThreadPoolExecutor(max_workers=min(8, len(threads))) as pool:
            futures = [
                pool.submit(live_turn, srv, t["id"], 1) for t in threads
            ]
            for t, fut in zip(threads, futures):
                try:
                    turn, questions = fut.result()
                except Exception:
                    turn, questions = None, None
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
            # 排序要用 Codex 记的「最近使用时间」，它和 updated_at 略有差别。
            "recencyAt": t.get("recency_at_ms"),
            "pinned": bool(t.get("pinned")),
            "pinnedPosition": t.get("pinnedPosition"),
            "state": kind,
            "activityAgeSec": None if age is None else int(age),
            "question": questions[0].get("title") if questions else None,
            "questions": questions or [],
            "lastAction": {"label": label, "detail": clip(detail, 200)} if items else None,
        })
    # 置顶的永远在最前，组内按 Codex 的 section_position。
    # 其余按所选顺序（最近使用 / 最近更新），同一档里再按状态收一下。
    state_rank = {"waiting": 0, "running": 1, "failed": 2, "stopped": 3, "done": 4}

    def sort_key(r):
        if r["pinned"]:
            return (0, r["pinnedPosition"] or 0, 0)
        stamp = r.get("recencyAt") or ((r.get("updatedAt") or 0) * 1000)
        return (1, -stamp, state_rank.get(r["state"], 9))

    out.sort(key=sort_key)
    return {
        "generatedAt": int(time.time() * 1000),
        "counts": {
            "total": len(out),
            "running": sum(1 for r in out if r["state"] == "running"),
            "waiting": sum(1 for r in out if r["state"] == "waiting"),
        },
        "sessions": out,
    }


# ─────────────────────────── 排队：锁释放后自动投递 ───────────────────────────
QUEUE_DIR = os.path.join(os.path.expanduser("~"), ".codex-monitor")
QUEUE_FILE = os.path.join(QUEUE_DIR, "queue.json")
QUEUE_LOCK = threading.Lock()


def _queue_read():
    """读出待投递的消息。文件损坏时当作空队列，不因为一条坏数据就罢工。"""
    try:
        with open(QUEUE_FILE, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return []
    return data if isinstance(data, list) else []


def _queue_write(items):
    """原子写：先写临时文件再 rename，避免中途崩溃留下半个 JSON。"""
    try:
        os.makedirs(QUEUE_DIR, exist_ok=True)
        tmp = QUEUE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(items, handle, ensure_ascii=False)
        os.replace(tmp, QUEUE_FILE)
    except OSError:
        pass


def queue_add(thread_id, message):
    """把一条消息排进队列。同一条消息重复提交要能认出来，不重复排队。"""
    with QUEUE_LOCK:
        items = _queue_read()
        entry = {
            "id": f"{int(time.time() * 1000)}-{len(items)}",
            "threadId": thread_id,
            "message": message,
            "queuedAt": int(time.time() * 1000),
            "attempts": 0,
            "error": None,
        }
        items.append(entry)
        _queue_write(items)
        return entry


def queue_list(thread_id=None):
    with QUEUE_LOCK:
        items = _queue_read()
    if thread_id:
        items = [i for i in items if i.get("threadId") == thread_id]
    return items


def queue_remove(entry_id):
    with QUEUE_LOCK:
        items = [i for i in _queue_read() if i.get("id") != entry_id]
        _queue_write(items)


def queue_mark_failed(entry_id, error):
    """投递失败时记下来。连续失败太多次就放弃，别无限重试。"""
    with QUEUE_LOCK:
        items = _queue_read()
        for item in items:
            if item.get("id") == entry_id:
                item["attempts"] = int(item.get("attempts") or 0) + 1
                item["error"] = str(error)[:300]
                break
        _queue_write(items)


MAX_QUEUE_ATTEMPTS = 5
QUEUE_PUMP_SEC = 5

# 这些错误重试多少次都不会好，排队等着只是白占位置。
PERMANENT_ERRORS = (
    "cannot resume an unloaded multi-agent",
    "thread not found",
    "no rollout found",
)


def is_permanent_error(exc):
    text = str(exc).lower()
    return any(marker in text for marker in PERMANENT_ERRORS)


def queue_drain(verbose=False):
    """把队列里能投的都投掉。

    只在锁真的空出来时才试；被占着就留着等下一轮，这不算失败。
    真正的失败（比如会话被删了）记一次，超过上限就丢掉，免得永远卡在队头。
    """
    delivered, waiting, failed = [], [], []
    for entry in queue_list():
        tid, msg, entry_id = entry.get("threadId"), entry.get("message"), entry.get("id")
        if not tid or not msg:
            # 坏条目直接丢掉，但要说一声，不然队列无声少一条没法排查。
            if verbose:
                print(f"⚠️ 丢弃不完整的队列条目 {entry_id}", flush=True)
            queue_remove(entry_id)
            continue
        if thread_locked(tid):
            waiting.append(entry_id)
            continue
        try:
            # 队列里的消息同样要等轮次跑完再放锁，不能投完就关进程。
            result = deliver_and_release(tid, msg)
            if not result["delivered"]:
                raise RuntimeError(result.get("error") or "投递失败")
            queue_remove(entry_id)
            delivered.append(entry_id)
            if verbose:
                print(f"✅ 队列投递成功 {tid} {msg[:40]}", flush=True)
        except Exception as exc:
            if is_writer_busy(exc):
                # 刚好被别人抢先锁上了，不算失败，下一轮再试。
                waiting.append(entry_id)
            else:
                queue_mark_failed(entry_id, exc)
                updated = next((i for i in queue_list() if i.get("id") == entry_id), None)
                # 永久性错误立刻放弃，可重试的失败到上限才放弃。
                if is_permanent_error(exc) or (
                    updated and int(updated.get("attempts") or 0) >= MAX_QUEUE_ATTEMPTS
                ):
                    queue_remove(entry_id)
                failed.append(entry_id)
                if verbose:
                    print(f"❌ 队列投递失败 {tid}: {str(exc)[:80]}", flush=True)
    return {"delivered": delivered, "waiting": waiting, "failed": failed}


def lock_kind(thread_id, state):
    """把「被锁住」分成用户能据以行动的两类。

    busy   —— 那一轮还在跑，谁都插不进去，只能等它结束。
    idle   —— 桌面端只是把这个会话开着（可能开了一整天），关掉就能发。
    unknown—— 锁在，但查不到持有者，别乱承诺。
    """
    if state == "running":
        return "busy"
    owner = lock_owner(thread_id)
    if owner is None:
        return "unknown"
    if owner["desktop"]:
        return "idle" if state in ("done", "stopped", "failed") else "busy"
    return "busy"


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
        "transcriptHasMore": chat["hasMore"],
        # 被别的进程（通常是 Codex 桌面端）占着时不能投递，UI 据此禁用输入框。
        # lockedBy 让 UI 能说清是「正在跑，只能等」还是「只是开着，关掉就能发」。
        "locked": thread_locked(thread_id),
        "lockedBy": lock_kind(thread_id, kind) if thread_locked(thread_id) else None,
        # 已经排队的消息：UI 要告诉用户「关掉就会自己发出去」，而不是干等着。
        "queued": [
            {"id": q.get("id"), "message": q.get("message"),
             "queuedAt": q.get("queuedAt"), "attempts": q.get("attempts")}
            for q in queue_list(thread_id)
        ],
        "transcriptBefore": chat["before"],
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
            if path == "/codex-monitor/queue":
                qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                self._json({"ok": True, "data": queue_list((qs.get("thread") or [None])[0])})
                return
            if path == "/codex-monitor/state":
                qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                limit = int((qs.get("limit") or ["12"])[0])
                order = (qs.get("order") or ["recent"])[0]
                try:
                    with srv_lock:
                        self._json({"ok": True, "data": build_list(app_server(), limit, order)})
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
                        self._json({"ok": True, "data": build_list(
                            app_server(),
                            int(payload.get("limit") or 12),
                            payload.get("order") or "recent",
                        )})
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

            if path == "/codex-monitor/more":
                # 向上滚动时只要更早的一页，不带详情里那些重复字段。
                tid = payload.get("threadId")
                if not tid:
                    self._json({"ok": False, "error": "threadId required"}, 400)
                    return
                try:
                    page = transcript(
                        tid,
                        int(payload.get("limit") or 30),
                        before=payload.get("before"),
                    )
                except Exception as exc:
                    self._json({"ok": False, "error": str(exc)}, 500)
                    return
                self._json({"ok": True, "data": page})
                return

            if path == "/codex-monitor/send":
                tid, msg = payload.get("threadId"), (payload.get("message") or "").strip()
                if not tid or not msg:
                    self._json({"ok": False, "error": "threadId and message required"}, 400)
                    return
                # 投递要 resume，而 resume 会把会话锁挂到进程上，直到进程退出才放。
                # 所以「投完立刻关」会把正在跑的轮次杀掉（实测 durationMs 只有 61ms，
                # 之后状态一直是 interrupted），而「一直不关」又会让 Codex 桌面端
                # 再也拿不到这个会话。折中是后台投递：等这一轮跑完再关进程。
                # 先在请求线程里探一次锁，好在被占着时能当场回 202 而不是假装投递成功。
                try:
                    if thread_locked(tid):
                        raise RuntimeError(WRITER_BUSY)
                    deliver_async(tid, msg)
                    self._json({"ok": True, "delivered": True, "async": True})
                except Exception as exc:
                    if is_writer_busy(exc):
                        # 锁着时不丢消息：排进队列，等锁释放自动投。
                        # 用户关掉 Codex 桌面端后什么都不用做，这条会自己发出去。
                        entry = queue_add(tid, msg)
                        self._json({
                            "ok": True,
                            "queued": True,
                            "queueId": entry["id"],
                            "error": "这个会话正被占着，消息已排队，锁一释放就会自动投递。",
                            "busy": True,
                        }, 202)
                    else:
                        self._json({"ok": False, "error": str(exc)}, 500)
                return

            self._json({"ok": False, "error": "not found"}, 404)

    class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
        daemon_threads = True
        allow_reuse_address = True

    httpd = Server((host, port), Handler)

    # 后台投递线程：队列里的消息在锁释放后要自己发出去，不能等用户再点一次。
    # 间隔不能太短——每轮都要探一次锁、必要时还要起 app-server，成本不低。
    def pump():
        while True:
            try:
                if queue_list():
                    queue_drain(verbose=True)
            except Exception as exc:
                print(f"队列泵出错: {exc}", flush=True)
            time.sleep(QUEUE_PUMP_SEC)

    threading.Thread(target=pump, daemon=True).start()

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
