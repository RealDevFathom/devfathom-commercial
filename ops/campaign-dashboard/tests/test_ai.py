import base64
import http.client
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "server"))
sys.path.insert(0, os.path.join(ROOT, "collector"))

import ai  # noqa: E402
import app  # noqa: E402
import worker_collector as wc  # noqa: E402

FAKE_KEY = "test-key-not-real-0000"
CFG = {"user": "ops", "password": "pw", "token": "tok", "trust_proxy": False}


class FakeAnthropic(BaseHTTPRequestHandler):
    calls = []

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeAnthropic.calls.append({"headers": dict(self.headers), "body": body})
        msgs = body["messages"]
        if "format" in body.get("output_config", {}):
            text = json.dumps({"summary": "All good.", "warnings": [
                {"severity": "warn", "area": "now", "title": "DEV-10 slow", "reason": "typecheck slow", "batch": "b", "issue": "DEV-10",
                 "evidence": [{"label": "DEV-10", "link": "#task=b/DEV-10"}, {"label": "evil", "link": "javascript:alert(1)"}]}],
                "suggestions": []})
            out = {"model": body["model"], "stop_reason": "end_turn", "content": [{"type": "text", "text": text}], "usage": {"input_tokens": 100, "output_tokens": 50}}
        elif not any(isinstance(m["content"], list) and any(c.get("type") == "tool_result" for c in m["content"]) for m in msgs):
            out = {"model": body["model"], "stop_reason": "tool_use", "usage": {"input_tokens": 10, "output_tokens": 5}, "content": [
                {"type": "thinking", "thinking": "", "signature": "sig"},
                {"type": "tool_use", "id": "toolu_1", "name": "get_live_activity", "input": {}},
                {"type": "tool_use", "id": "toolu_2", "name": "get_task", "input": {"issue": "DEV-12", "batch_id": ""}}]}
        else:
            out = {"model": body["model"], "stop_reason": "end_turn", "usage": {"input_tokens": 10, "output_tokens": 5},
                   "content": [{"type": "text", "text": "DEV-10 is verifying, see [DEV-10](#task=b/DEV-10)."}]}
        data = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def fixture_state():
    payload = wc.collect(os.path.join(ROOT, "fixtures", "jobs"), None, live_window=0, host_metrics=False)
    with open(os.path.join(ROOT, "fixtures", "box.json")) as fh:
        box = json.load(fh)
    snap = {"worker": {"receivedAt": 1.0, "payload": payload}, "box": {"receivedAt": 1.0, "payload": box}}
    return app.build_state(snap, now=2.0)


class AITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fake = ThreadingHTTPServer(("127.0.0.1", 0), FakeAnthropic)
        threading.Thread(target=cls.fake.serve_forever, daemon=True).start()
        cls.orig_url = ai.API_URL
        ai.API_URL = f"http://127.0.0.1:{cls.fake.server_address[1]}/v1/messages"

    @classmethod
    def tearDownClass(cls):
        ai.API_URL = cls.orig_url
        cls.fake.shutdown()

    def setUp(self):
        FakeAnthropic.calls = []
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def svc(self, **env):
        base = {"ANTHROPIC_API_KEY": FAKE_KEY}
        base.update(env)
        state = fixture_state()
        return ai.AIService(lambda: state, self.tmp, env=base)

    def test_every_tool_runs_read_only(self):
        tools = ai.ReadOnlyTools(fixture_state())
        args = {"get_batch": {"batch_id": "pharmacy-review-50"}, "get_task": {"issue": "DEV-12", "batch_id": ""},
                "get_github_activity": {"days": 30}, "get_linear_states": {"issues": []},
                "search_events": {"query": "", "kind": "", "issue": "", "since_hours": 0, "limit": 5}}
        for t in ai.TOOLS:
            res = tools.run(t["name"], args.get(t["name"], {}))
            json.dumps(res, default=str)
            self.assertNotIn("error", res if isinstance(res, dict) else {}, t["name"])
            self.assertTrue(t["strict"])
            self.assertFalse(t["input_schema"]["additionalProperties"])
        self.assertIn("error", tools.run("merge_pr", {}))

    def test_chat_tool_loop_and_request_shape(self):
        out = self.svc().chat([{"role": "user", "content": "what is running?"}])
        self.assertIn("#task=b/DEV-10", out["reply"])
        self.assertEqual(out["tools"], ["get_live_activity", "get_task"])
        first, second = FakeAnthropic.calls
        h = {k.lower(): v for k, v in first["headers"].items()}
        self.assertEqual(h["x-api-key"], FAKE_KEY)
        self.assertEqual(h["anthropic-version"], ai.API_VERSION)
        self.assertEqual(h["anthropic-beta"], ai.FALLBACK_BETA)
        b = first["body"]
        self.assertEqual(b["model"], "claude-opus-5-5")
        self.assertEqual(b["thinking"], {"type": "adaptive"})
        self.assertEqual(b["fallbacks"], "default")
        self.assertNotIn("tool_choice", b)
        self.assertEqual(b["system"][0]["cache_control"], {"type": "ephemeral"})
        # tool results returned in ONE user message, assistant content echoed unchanged
        msgs = second["body"]["messages"]
        self.assertEqual(msgs[-2]["role"], "assistant")
        self.assertEqual(msgs[-2]["content"][0]["type"], "thinking")
        self.assertEqual([c["tool_use_id"] for c in msgs[-1]["content"]], ["toolu_1", "toolu_2"])

    def test_analysis_structured_and_link_filtering(self):
        s = self.svc()
        res = s.analyze(force=True)
        self.assertEqual(res["summary"], "All good.")
        w = res["warnings"][0]
        self.assertEqual([e["link"] for e in w["evidence"]], ["#task=b/DEV-10"])  # javascript: dropped
        body = FakeAnthropic.calls[0]["body"]
        self.assertEqual(body["output_config"]["format"]["type"], "json_schema")
        # cached: a second non-forced call within the min interval does not hit the API
        s.analyze()
        self.assertEqual(len(FakeAnthropic.calls), 1)
        # persisted for restarts
        self.assertEqual(self.svc().analysis["summary"], "All good.")

    def test_budget_and_rate_limit(self):
        s = self.svc(AI_DAILY_TOKEN_BUDGET="20", AI_CHAT_PER_MIN="2")
        self.assertTrue(s.allow_chat("1.1.1.1"))
        self.assertTrue(s.allow_chat("1.1.1.1"))
        self.assertFalse(s.allow_chat("1.1.1.1"))
        s.chat([{"role": "user", "content": "hi"}])
        with self.assertRaises(ai.AIError):
            s.chat([{"role": "user", "content": "again"}])
        self.assertTrue(s.status()["budgetExhausted"])

    def test_disabled_without_key(self):
        s = ai.AIService(fixture_state, self.tmp, env={})
        self.assertFalse(s.enabled)
        self.assertIsNone(s.analyze(force=True))
        with self.assertRaises(ai.AIError):
            s.chat([{"role": "user", "content": "x"}])


class AIEndpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        os.environ["ANTHROPIC_API_KEY"] = FAKE_KEY
        self.srv = app.make_server("127.0.0.1", 0, dict(CFG), self.tmp)
        del os.environ["ANTHROPIC_API_KEY"]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.auth = "Basic " + base64.b64encode(b"ops:pw").decode()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        shutil.rmtree(self.tmp)

    def req(self, method, path, headers=None, body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.srv.server_address[1], timeout=10)
        c.request(method, path, body=body, headers=headers or {})
        r = c.getresponse()
        data = r.read()
        c.close()
        return r, data

    def test_key_never_exposed_and_csrf_guard(self):
        r, body = self.req("GET", "/api/state", {"Authorization": self.auth})
        self.assertEqual(r.status, 200)
        self.assertNotIn(FAKE_KEY.encode(), body)
        self.assertTrue(json.loads(body)["ai"]["enabled"])
        msg = json.dumps({"messages": [{"role": "user", "content": "hi"}]}).encode()
        r, _ = self.req("POST", "/api/ai/chat", {"Content-Type": "application/json"}, msg)
        self.assertEqual(r.status, 401)
        r, _ = self.req("POST", "/api/ai/chat", {"Authorization": self.auth, "Content-Type": "application/json"}, msg)
        self.assertEqual(r.status, 403)  # missing X-Requested-With
        r, _ = self.req("POST", "/api/ai/chat", {"Authorization": self.auth, "Content-Type": "application/json",
                                                 "X-Requested-With": "ops-dash", "Origin": "https://evil.example"}, msg)
        self.assertEqual(r.status, 403)
        r, _ = self.req("POST", "/api/ai/nope", {"Authorization": self.auth, "Content-Type": "application/json", "X-Requested-With": "ops-dash"}, b"{}")
        self.assertEqual(r.status, 404)


if __name__ == "__main__":
    unittest.main()
