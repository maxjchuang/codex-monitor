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
            "model text, tokens_used integer, rollout_path text)"
        )
        conn.commit()
        conn.close()

        self._old = (c.HIST_DB, c.STATE_DB)
        c.HIST_DB, c.STATE_DB = hist, state

    def tearDown(self):
        c.HIST_DB, c.STATE_DB = self._old
        self.tmp.cleanup()

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


class TestThreads(TempDbs):
    def test_latest_threads_sorted_by_update(self):
        conn = sqlite3.connect(c.STATE_DB)
        conn.execute("insert into threads values ('a','old','/p',1,'m',0,'')")
        conn.execute("insert into threads values ('b','new','/p',2,'m',0,'')")
        conn.commit()
        conn.close()
        self.assertEqual([t["id"] for t in c.latest_threads(5)], ["b", "a"])

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


if __name__ == "__main__":
    unittest.main()
