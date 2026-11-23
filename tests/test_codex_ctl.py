#!/usr/bin/env python3
"""codex_ctl 的离线测试：不启动 Codex，只验证状态判断与解析逻辑。

运行：python3 -m unittest discover -s tests -v
"""

import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import codex_ctl as c


class TempDbs(unittest.TestCase):
    """在临时目录里造出与 Codex 同构的两张表。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        hist = os.path.join(self.tmp.name, "thread_history_1.sqlite")
        state = os.path.join(self.tmp.name, "state_5.sqlite")

        conn = sqlite3.connect(hist)
        conn.execute(
            "create table thread_items (thread_id text, turn_id text, item_id text, "
            "item_type text, created_at_ms integer, item_json text)"
        )
        conn.execute(
            "create table thread_turns (thread_id text, turn_id text, status text, "
            "started_at integer, completed_at integer, duration_ms integer)"
        )
        conn.commit()
        conn.close()

        conn = sqlite3.connect(state)
        conn.execute(
            "create table threads (id text, title text, cwd text, updated_at integer, "
            "model text, tokens_used integer, rollout_path text, name text, "
            "is_pinned integer, source text, thread_source text, preview text, "
            "recency_at_ms integer, archived integer, thread_section_id text, "
            "section_position integer)"
        )
        # Codex 侧栏的项目名来自 projects.name，一个项目可以挂多个根目录。
        conn.execute("create table projects (id text, name text, position integer)")
        conn.execute("create table project_roots (project_id text, path text)")
        # 置顶不是 is_pinned，而是会话被放进名为 Pinned 的 section。
        conn.execute("create table thread_sections (id text, name text, appearance text)")
        conn.commit()
        conn.close()

        self._old = (c.HIST_DB, c.STATE_DB)
        c.HIST_DB, c.STATE_DB = hist, state

    def tearDown(self):
        c.HIST_DB, c.STATE_DB = self._old
        self.tmp.cleanup()

    def add_thread(self, thread_id, name, updated_at=1000, recency_ms=None,
                   archived=0, section=None, position=None, thread_source="user",
                   cwd="/p/alpha"):
        conn = sqlite3.connect(c.STATE_DB)
        conn.execute(
            "insert into threads (id, title, cwd, updated_at, model, tokens_used, "
            "rollout_path, name, is_pinned, source, thread_source, preview, "
            "recency_at_ms, archived, thread_section_id, section_position) "
            "values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (thread_id, name, cwd, updated_at, "m", 0, "", name, 0, "cli",
             thread_source, "", recency_ms, archived, section, position),
        )
        conn.commit()
        conn.close()

    def add_section(self, section_id, name):
        conn = sqlite3.connect(c.STATE_DB)
        conn.execute("insert into thread_sections values (?,?,?)", (section_id, name, None))
        conn.commit()
        conn.close()

    def add_item(self, thread_id, item_type, payload, at_ms, turn_id="t1"):
        conn = sqlite3.connect(c.HIST_DB)
        conn.execute(
            "insert into thread_items values (?,?,?,?,?,?)",
            (thread_id, turn_id, f"i{at_ms}", item_type, at_ms, __import__("json").dumps(payload)),
        )
        conn.commit()
        conn.close()

    def add_turn(self, thread_id, status, started_at=0, duration_ms=None, turn_id="t1"):
        conn = sqlite3.connect(c.HIST_DB)
        conn.execute(
            "insert into thread_turns values (?,?,?,?,?,?)",
            (thread_id, turn_id, status, started_at, None, duration_ms),
        )
        conn.commit()
        conn.close()


class TestLiveState(TempDbs):
    def test_recent_activity_means_running(self):
        """桌面版把正在跑的轮次写成 interrupted，但心跳新鲜就必须判为 running。"""
        self.add_turn("t", "interrupted")
        self.add_item("t", "reasoning", {}, at_ms=1000)
        kind, _ = c.live_state("t", {"status": "interrupted"}, None, now_ms=1000 + 30_000)
        self.assertEqual(kind, "running")

    def test_question_beats_heartbeat(self):
        """有待回答问题时应判 waiting，即使刚有新动作。"""
        self.add_item("t", "agentMessage", {"questions": [{"title": "删吗"}]}, at_ms=5000)
        kind, _ = c.live_state("t", {"status": "interrupted"}, [{"title": "删吗"}], now_ms=5000)
        self.assertEqual(kind, "waiting")

    def test_stale_activity_is_not_running(self):
        self.add_turn("t", "interrupted")
        self.add_item("t", "reasoning", {}, at_ms=1000)
        kind, _ = c.live_state("t", {"status": "interrupted"}, None, now_ms=1000 + 600_000)
        self.assertEqual(kind, "stopped")

    def test_completed_stays_done_when_idle(self):
        self.add_turn("t", "completed", duration_ms=1234)
        self.add_item("t", "agentMessage", {"text": "好了"}, at_ms=1000)
        kind, _ = c.live_state("t", {"status": "completed"}, None, now_ms=1000 + 600_000)
        self.assertEqual(kind, "done")

    def test_completed_beats_fresh_heartbeat(self):
        """回归：已完成的轮次即使心跳新鲜也必须判 done。

        实测 98.7% 的已完成轮次最后一条动作距完成不到 90s；若让心跳优先，
        用户会看到“干完了还在跑”。
        """
        self.add_turn("t", "completed", duration_ms=1000)
        self.add_item("t", "agentMessage", {"text": "好了"}, at_ms=1000)
        kind, _ = c.live_state("t", {"status": "completed"}, None, now_ms=1000 + 5_000)
        self.assertEqual(kind, "done")

    def test_in_progress_is_running_even_when_quiet(self):
        """inProgress 是明确信号，静默也不能判成 stopped。"""
        self.add_turn("t", "inProgress")
        self.add_item("t", "reasoning", {}, at_ms=1000)
        kind, _ = c.live_state("t", {"status": "inProgress"}, None, now_ms=1000 + 900_000)
        self.assertEqual(kind, "running")

    def test_long_silence_within_window_stays_running(self):
        """回归：跑长命令会有 >90s 静默，窗口内不能误判成已停下。"""
        self.add_turn("t", "interrupted")
        self.add_item("t", "reasoning", {}, at_ms=1000)
        kind, _ = c.live_state("t", {"status": "interrupted"}, None, now_ms=1000 + 120_000)
        self.assertEqual(kind, "running")

    def test_no_activity_yet_is_not_a_huge_age(self):
        """回归：没有活动记录时 age 必须是 None，不能算成“距 1970 年多少秒”。"""
        kind, age = c.live_state("no-such-thread", {"status": "interrupted"}, None, now_ms=1795435073 * 1000)
        self.assertEqual(kind, "stopped")
        self.assertIsNone(age)

    def test_failed_reported(self):
        self.add_turn("t", "failed")
        self.add_item("t", "reasoning", {}, at_ms=1000)
        kind, _ = c.live_state("t", {"status": "failed"}, None, now_ms=1000 + 600_000)
        self.assertEqual(kind, "failed")


class TestParsing(TempDbs):
    def test_hhmm_accepts_seconds_and_millis(self):
        self.assertEqual(c.hhmm(1795428378), c.hhmm(1795428378000))
        self.assertEqual(c.hhmm(0), "--:--")

    def test_clip_truncates(self):
        self.assertEqual(len(c.clip("x" * 500, 20)), 20)
        self.assertTrue(c.clip("x" * 500, 20).endswith("…"))
        self.assertEqual(c.clip("short", 20), "short")

    def test_describe_command(self):
        label, detail = c.describe_item(
            {"type": "commandExecution", "at": 0, "data": {"command": "/bin/zsh -lc 'ls'"}}
        )
        self.assertEqual(label, "执行命令")
        self.assertIn("ls", detail)

    def test_describe_file_change(self):
        label, detail = c.describe_item(
            {"type": "fileChange", "at": 0, "data": {"changes": [{"path": "/a/b.py"}]}}
        )
        self.assertEqual(label, "改文件")
        self.assertIn("b.py", detail)

    def test_first_user_text_fallback(self):
        self.add_item("t", "userMessage", {"content": [{"type": "text", "text": "原始需求"}]}, at_ms=1)
        self.assertEqual(c.first_user_text("t"), "原始需求")

    def test_pending_question_reads_latest_turn(self):
        self.add_turn("t", "interrupted")
        self.add_item("t", "agentMessage", {"questions": [{"title": "选哪个"}]}, at_ms=10)
        self.assertEqual(c.pending_question("t")[0]["title"], "选哪个")

    def test_no_pending_question_when_completed(self):
        self.add_turn("t", "completed")
        self.add_item("t", "agentMessage", {"questions": [{"title": "旧问题"}]}, at_ms=10)
        self.assertIsNone(c.pending_question("t"))


class TestWorkGrouping(TempDbs):
    """中间过程要收进 work 块，正文只留用户消息和最终答复。"""

    def _entry(self, role, text, **kw):
        d = {"role": role, "at": 0, "text": text}
        d.update(kw)
        return d

    def test_middle_process_folds_into_work_block(self):
        entries = [
            self._entry("user", "修一下"),
            self._entry("agent", "我先看看"),
            {"role": "action", "at": 0, "label": "执行命令", "text": "ls"},
            self._entry("agent", "修好了", final=True),
        ]
        out = c.group_turns(entries, [])
        roles = [e["role"] for e in out]
        self.assertEqual(roles, ["user", "work", "agent"])
        self.assertEqual(len(out[1]["entries"]), 2)
        self.assertTrue(out[2]["final"])

    def test_no_work_block_when_turn_is_just_an_answer(self):
        entries = [
            self._entry("user", "问个问题"),
            self._entry("agent", "答", final=True),
        ]
        out = c.group_turns(entries, [])
        self.assertEqual([e["role"] for e in out], ["user", "agent"])

    def test_duration_matched_by_final_item_id(self):
        entries = [
            self._entry("user", "修一下", id="u1"),
            {"role": "action", "at": 0, "label": "执行命令", "text": "ls"},
            self._entry("agent", "修好了", final=True, id="a1"),
        ]
        spans = [{"finalAgent": "a1", "durationMs": 389000}]
        out = c.group_turns(entries, spans)
        work = [e for e in out if e["role"] == "work"][0]
        self.assertEqual(work["durationMs"], 389000)

    def test_duration_left_empty_when_span_is_missing(self):
        """中间有轮被 trim 掉时不能把时长错配到别的轮上。"""
        entries = [
            self._entry("user", "修一下", id="u1"),
            {"role": "action", "at": 0, "label": "执行命令", "text": "ls"},
            self._entry("agent", "修好了", final=True, id="a1"),
        ]
        spans = [{"finalAgent": "别的id", "durationMs": 999}]
        out = c.group_turns(entries, spans)
        work = [e for e in out if e["role"] == "work"][0]
        self.assertIsNone(work.get("durationMs"))

    def test_leading_orphan_entries_still_grouped(self):
        """更早的轮被 trim 掉时，前面剩下的动作不能丢。"""
        entries = [
            {"role": "action", "at": 0, "label": "执行命令", "text": "ls"},
            self._entry("user", "修一下"),
            self._entry("agent", "好了", final=True),
        ]
        out = c.group_turns(entries, [])
        self.assertEqual(out[0]["role"], "work")
        self.assertIn("user", [e["role"] for e in out])

    def test_empty_transcript(self):
        self.assertEqual(c.group_turns([], []), [])


class TestTranscriptShape(TempDbs):
    """端到端：transcript() 的输出必须真的带 work 块和最终答复。"""

    def _write_turn(self, tid, i, n_cmds=30):
        import json as _json
        base = 1000 + i * 10000
        self.add_item(tid, "userMessage",
                      {"id": f"u{i}", "content": [{"type": "text", "text": f"第{i}个问题"}]},
                      at_ms=base)
        for k in range(n_cmds):
            self.add_item(tid, "commandExecution",
                          {"command": f"/bin/zsh -lc 'echo {k}'"}, at_ms=base + 10 + k)
        self.add_item(tid, "agentMessage",
                      {"id": f"a{i}", "phase": "final_answer", "text": f"第{i}个答复"},
                      at_ms=base + 5000)

    def test_returns_user_work_and_final_answer(self):
        """一轮里塞满命令时，用户提问和最终答复都不能被挤掉。"""
        for i in range(3):
            self._write_turn("t", i)
        r = c.transcript("t", limit=20)
        roles = [e["role"] for e in r["entries"]]
        self.assertIn("work", roles)
        self.assertIn("user", roles)
        self.assertIn("agent", roles)
        # 每一轮都完整：user 在前，work 中间，final 在后。
        self.assertEqual(roles[0], "user")
        self.assertEqual(roles[-1], "agent")

    def test_work_block_absorbs_the_commands(self):
        self._write_turn("t", 0, n_cmds=30)
        r = c.transcript("t", limit=20)
        work = [e for e in r["entries"] if e["role"] == "work"][0]
        self.assertEqual(work["count"], 30)
        self.assertEqual(len(work["entries"]), 30)


class TestArchivedAndPinned(TempDbs):
    """归档的不列出；置顶的单独成组；两种排序都要成立。"""

    def test_archived_sessions_are_hidden(self):
        self.add_thread("live", "在用的会话", updated_at=2000)
        self.add_thread("gone", "已经归档的会话", updated_at=3000, archived=1)
        names = [r["name"] for r in c.latest_threads(20)]
        self.assertIn("在用的会话", names)
        self.assertNotIn("已经归档的会话", names)

    def test_include_archived_still_works(self):
        self.add_thread("gone", "归档的", updated_at=3000, archived=1)
        names = [r["name"] for r in c.latest_threads(20, include_archived=True)]
        self.assertIn("归档的", names)

    def test_pinned_comes_from_the_pinned_section(self):
        self.add_section("sec-pin", "Pinned")
        self.add_thread("a", "置顶会话", section="sec-pin", position=2000000)
        self.add_thread("b", "普通会话", updated_at=5000)
        rows = c.latest_threads(20)
        by_id = {r["id"]: r for r in rows}
        self.assertTrue(by_id["a"]["pinned"])
        self.assertFalse(by_id["b"]["pinned"])
        self.assertEqual(by_id["a"]["pinnedPosition"], 2000000)

    def test_a_section_that_is_not_pinned_does_not_count(self):
        self.add_section("sec-other", "Archive")
        self.add_thread("a", "别的分组", section="sec-other", position=1)
        rows = c.latest_threads(20)
        self.assertFalse(rows[0]["pinned"])

    def test_recent_order_uses_recency_not_updated(self):
        # 故意让 updated_at 和 recency_at_ms 指向相反的顺序：
        # 用错字段就会得到相反的列表。
        self.add_thread("old-but-recent", "最近用过", updated_at=1000, recency_ms=9000)
        self.add_thread("new-but-stale", "刚被改过", updated_at=8000, recency_ms=2000)
        names = [r["name"] for r in c.latest_threads(20, order="recent")]
        self.assertEqual(names, ["最近用过", "刚被改过"])

    def test_updated_order_still_available(self):
        self.add_thread("x", "旧的", updated_at=1000, recency_ms=9000)
        self.add_thread("y", "新的", updated_at=8000, recency_ms=2000)
        names = [r["name"] for r in c.latest_threads(20, order="updated")]
        self.assertEqual(names, ["新的", "旧的"])

    def test_build_list_puts_pinned_first(self):
        self.add_section("sec-pin", "Pinned")
        # 置顶的那个 updated_at 更老，仍然必须排在最前。
        self.add_thread("pin", "置顶的", updated_at=1000, section="sec-pin", position=1)
        self.add_thread("fresh", "更新的", updated_at=9000, recency_ms=9000)
        # live_turn 会去问 app-server，这里传 None，失败会被 build_list 兜住，
        # 测试只关心排序。
        data = c.build_list(None, 20, "recent")
        self.assertEqual(data["sessions"][0]["id"], "pin")
        self.assertTrue(data["sessions"][0]["pinned"])


class TestTranscriptPaging(TempDbs):
    """向上滚动加载更多：游标不能重叠，也不能跳空。"""

    def _seed(self, n_turns):
        for i in range(n_turns):
            base = 1000 + i * 10000
            self.add_item("t", "userMessage",
                          {"id": f"u{i}", "content": [{"type": "text", "text": f"问{i}"}]},
                          at_ms=base)
            self.add_item("t", "agentMessage",
                          {"id": f"a{i}", "phase": "final_answer", "text": f"答{i}"},
                          at_ms=base + 1000)

    def test_pages_do_not_overlap_and_cover_everything(self):
        self._seed(10)
        seen, before, pages = [], None, 0
        while pages < 20:
            page = c.transcript("t", limit=3, before=before)
            rows = page["entries"]
            if not rows:
                break
            seen = rows + seen
            pages += 1
            if not page["hasMore"]:
                break
            before = page["before"]
        # 十轮各一问一答，翻完必须一条不多一条不少。
        self.assertEqual([r["text"] for r in seen if r["role"] == "user"],
                         [f"问{i}" for i in range(10)])
        self.assertEqual(len(seen), 20)

    def test_cursor_is_the_oldest_kept_entry(self):
        """游标取扫描窗口末尾会跳到几天前，第二页直接空掉。"""
        self._seed(6)
        page = c.transcript("t", limit=2)
        self.assertTrue(page["hasMore"])
        self.assertEqual(page["before"], int(page["entries"][0]["at"] * 1000))
        nxt = c.transcript("t", limit=2, before=page["before"])
        self.assertTrue(nxt["entries"], "第二页不该是空的")

    def test_last_page_reports_no_more(self):
        self._seed(2)
        page = c.transcript("t", limit=50)
        self.assertFalse(page["hasMore"])

    def test_before_cursor_filters_strictly_earlier(self):
        self._seed(3)
        page = c.transcript("t", limit=2)
        older = c.transcript("t", limit=50, before=page["before"])
        if older["entries"]:
            self.assertLessEqual(older["entries"][-1]["at"], page["entries"][0]["at"])


class TestTrimTurns(TempDbs):
    """裁剪必须以轮为单位，不能先 trim 再分组。"""

    def _turn(self, i):
        return [
            {"role": "user", "at": i, "text": f"问{i}"},
            {"role": "work", "at": i, "durationMs": 1000, "count": 2,
             "entries": [{"role": "action", "at": i, "label": "执行命令", "text": "ls"}]},
            {"role": "agent", "at": i, "text": f"答{i}", "final": True},
        ]

    def test_keeps_whole_turns_not_a_slice_of_one(self):
        grouped = []
        for i in range(10):
            grouped.extend(self._turn(i))
        out = c.trim_turns(grouped, 9)
        roles = [e["role"] for e in out]
        # 三的整数倍，正好三轮，且必须以 user 开头、agent 结尾。
        self.assertEqual(len(out), 9)
        self.assertEqual(roles[0], "user")
        self.assertEqual(roles[-1], "agent")

    def test_drops_leading_orphan_work_block(self):
        """截断落在一轮中间时，首屏不能是一段没有提问也没有结论的过程。"""
        grouped = [{"role": "work", "at": 0, "count": 1,
                    "entries": [{"role": "action", "at": 0, "label": "执行命令", "text": "ls"}]}]
        for i in range(5):
            grouped.extend(self._turn(i))
        out = c.trim_turns(grouped, 6)
        self.assertNotEqual(out[0]["role"], "work")

    def test_busy_tail_does_not_crowd_out_the_conversation(self):
        """一轮里几十条命令只算一个 work 块，不该把整轮挤出窗口。"""
        grouped = self._turn(0)
        grouped[1]["count"] = 80
        out = c.trim_turns(grouped, 3)
        self.assertEqual([e["role"] for e in out], ["user", "work", "agent"])

    def test_empty(self):
        self.assertEqual(c.trim_turns([], 10), [])


class TestThreads(TempDbs):
    def test_latest_threads_sorted_by_update(self):
        conn = sqlite3.connect(c.STATE_DB)
        conn.execute("insert into threads (id,title,cwd,updated_at) values ('a','old','/p',1)")
        conn.execute("insert into threads (id,title,cwd,updated_at) values ('b','new','/p',2)")
        conn.commit()
        conn.close()
        self.assertEqual([t["id"] for t in c.latest_threads(5)], ["b", "a"])

    def test_name_beats_raw_title(self):
        """threads.name 是 Codex 显示的会话名，优先于原始首条消息。"""
        conn = sqlite3.connect(c.STATE_DB)
        conn.execute(
            "insert into threads (id,title,name,cwd,updated_at) "
            "values ('a','请接手 GridView 任务。功能已经实现，接下来…','GridView 表格组件','/p',1)"
        )
        conn.commit()
        conn.close()
        row = c.latest_threads(5)[0]
        self.assertEqual(c.clean_title(row["name"]), "GridView 表格组件")

    def test_project_name_comes_from_projects_table(self):
        """项目名取 projects.name，而不是目录名。"""
        conn = sqlite3.connect(c.STATE_DB)
        conn.execute("insert into projects values ('p1','Bitable 组件库',0)")
        conn.execute("insert into project_roots values ('p1','/Users/x/bitable/base-ui-component-lib')")
        conn.execute(
            "insert into threads (id,title,cwd,updated_at) "
            "values ('a','t','/Users/x/bitable/base-ui-component-lib/packages/grid',1)"
        )
        conn.commit()
        conn.close()
        row = c.latest_threads(5)[0]
        self.assertEqual(row["projectName"], "Bitable 组件库")

    def test_project_resolves_from_nested_subdirectory(self):
        """会话在项目子目录里时也要归到这个项目。"""
        conn = sqlite3.connect(c.STATE_DB)
        conn.execute("insert into projects values ('p1','Faster',3)")
        conn.execute("insert into project_roots values ('p1','/Users/x/faster')")
        conn.execute(
            "insert into threads (id,title,cwd,updated_at) "
            "values ('a','t','/Users/x/faster/src/deep/nested',1)"
        )
        conn.commit()
        conn.close()
        self.assertEqual(c.latest_threads(5)[0]["projectName"], "Faster")

    def test_empty_threads_are_hidden(self):
        """有 turn 但没有任何内容的空壳会话不显示。"""
        conn = sqlite3.connect(c.STATE_DB)
        conn.execute(
            "insert into threads (id,title,cwd,updated_at) values ('empty','','/p',9)"
        )
        conn.execute(
            "insert into threads (id,title,cwd,updated_at) values ('real','真的任务','/p',1)"
        )
        conn.commit()
        conn.close()
        self.assertEqual([t["id"] for t in c.latest_threads(5)], ["real"])

    def test_subagent_threads_are_hidden(self):
        """子 agent 的线程不是独立会话，不应出现在列表里。"""
        conn = sqlite3.connect(c.STATE_DB)
        conn.execute(
            "insert into threads (id,title,cwd,updated_at,thread_source) "
            "values ('sub','child work','/p',9,'subagent')"
        )
        conn.execute(
            "insert into threads (id,title,cwd,updated_at,thread_source) "
            "values ('main','real work','/p',1,'user')"
        )
        conn.commit()
        conn.close()
        self.assertEqual([t["id"] for t in c.latest_threads(5)], ["main"])

    def test_missing_db_is_safe(self):
        c.HIST_DB = os.path.join(self.tmp.name, "nope.sqlite")
        self.assertEqual(c.recent_items("x"), [])
        self.assertEqual(c.last_activity_at("x"), 0)


class TestDeliverReuse(TempDbs):
    """新建的线程只存在于创建它的 app-server 进程里，投递必须复用同一个进程。"""

    def test_deliver_reuses_given_server(self):
        closed = []

        class Fake:
            def __init__(self):
                self.calls = []

            def call(self, method, params=None, timeout=180):
                self.calls.append(method)
                return {"turn": {"status": "completed", "durationMs": 1, "items": []}}

            def wait_notification(self, method, timeout):
                return {"turn": {"status": "completed", "durationMs": 1, "items": []}}

            def close(self):
                closed.append(True)

        fake = Fake()
        c.deliver("tid", "hi", 0, resume=False, srv=fake)
        self.assertIn("turn/start", fake.calls)
        self.assertNotIn("thread/resume", fake.calls)
        self.assertEqual(closed, [], "传入的 server 不应被 deliver 关闭")

    def test_deliver_resumes_when_asked(self):
        class Fake:
            def __init__(self):
                self.calls = []

            def call(self, method, params=None, timeout=180):
                self.calls.append(method)
                return {}

            def wait_notification(self, method, timeout):
                return None

            def close(self):
                pass

        fake = Fake()
        c.deliver("tid", "hi", 0, resume=True, srv=fake)
        self.assertEqual(fake.calls[:2], ["thread/resume", "turn/start"])


class TranscriptTrimmingTest(unittest.TestCase):
    """聊天窗口只取最近一段，且不能被成串的命令挤掉对话。"""

    def test_short_run_is_left_alone(self):
        entries = [
            {"role": "action", "at": 1, "label": "执行命令", "text": "ls"},
            {"role": "action", "at": 2, "label": "执行命令", "text": "pwd"},
        ]
        self.assertEqual(len(c.trim_transcript(entries, 50)), 2)

    def test_long_run_collapses_into_one_line(self):
        entries = [{"role": "action", "at": i, "label": "执行命令", "text": f"cmd{i}"} for i in range(9)]
        out = c.trim_transcript(entries, 50)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["count"], 9)
        self.assertEqual(out[0]["text"], "cmd0")
        self.assertEqual(out[0]["lastText"], "cmd8")

    def test_messages_survive_a_command_flood(self):
        entries = []
        for i in range(60):
            entries.append({"role": "action", "at": i, "label": "执行命令", "text": f"cmd{i}"})
            if i % 20 == 0:
                entries.append({"role": "user", "at": i, "text": f"第 {i} 条消息"})
        out = c.trim_transcript(entries, 200)
        texts = [e["text"] for e in out if e["role"] == "user"]
        self.assertEqual(len(texts), 3)

    def test_trim_keeps_the_newest_entries(self):
        entries = [{"role": "user", "at": i, "text": f"m{i}"} for i in range(30)]
        out = c.trim_transcript(entries, 5)
        self.assertEqual([e["text"] for e in out], ["m25", "m26", "m27", "m28", "m29"])

    def test_empty_input_is_empty(self):
        self.assertEqual(c.trim_transcript([], 10), [])


if __name__ == "__main__":
    unittest.main()
