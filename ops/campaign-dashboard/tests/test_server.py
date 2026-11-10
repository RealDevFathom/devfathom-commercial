import base64
import http.client
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "server"))

import app  # noqa: E402

CFG = {"user": "ops", "password": "s3cret-pass", "token": "ingest-tok", "trust_proxy": False}


def basic(user, pw):
    return "Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode()


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.srv = app.make_server("127.0.0.1", 0, dict(CFG), self.tmp)
        self.port = self.srv.server_address[1]
        self.thread = threading.Thread(target=self.srv.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        shutil.rmtree(self.tmp)

    def req(self, method, path, headers=None, body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request(method, path, body=body, headers=headers or {})
        r = c.getresponse()
        data = r.read()
        c.close()
        return r, data

    def ingest(self, source, obj, token="ingest-tok", ctype="application/json"):
        body = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        return self.req("POST", f"/api/ingest/{source}", {"Authorization": f"Bearer {token}", "Content-Type": ctype}, body)

    def test_healthz_no_auth(self):
        r, data = self.req("GET", "/healthz")
        self.assertEqual((r.status, data), (200, b"ok"))

    def test_basic_auth_required(self):
        for path in ("/", "/static/app.js", "/api/state"):
            r, _ = self.req("GET", path)
            self.assertEqual(r.status, 401, path)
            self.assertIn("Basic", r.getheader("WWW-Authenticate"))
        r, _ = self.req("GET", "/api/state", {"Authorization": basic("ops", "wrong")})
        self.assertEqual(r.status, 401)
        r, _ = self.req("GET", "/api/state", {"Authorization": basic("ops", "s3cret-pass")})
        self.assertEqual(r.status, 200)
        self.assertEqual(r.getheader("Cache-Control"), "no-store")
        self.assertEqual(r.getheader("X-Frame-Options"), "DENY")
        self.assertIn("default-src 'self'", r.getheader("Content-Security-Policy"))
        self.assertIn("max-age", r.getheader("Strict-Transport-Security"))

    def test_static_whitelist_no_listing(self):
        auth = {"Authorization": basic("ops", "s3cret-pass")}
        for path in ("/static/", "/static/../app.py", "/static/%2e%2e/app.py", "/app.py"):
            r, _ = self.req("GET", path, auth)
            self.assertEqual(r.status, 404, path)
        r, body = self.req("GET", "/", auth)
        self.assertEqual(r.status, 200)
        self.assertIn(b"Campaign Ops", body)

    def test_rate_limit_on_failures(self):
        for _ in range(app.FAIL_LIMIT):
            self.req("GET", "/api/state", {"Authorization": basic("ops", "nope")})
        r, _ = self.req("GET", "/api/state", {"Authorization": basic("ops", "s3cret-pass")})
        self.assertEqual(r.status, 429)

    def test_ingest_auth_and_validation(self):
        r, _ = self.ingest("worker", {"a": 1}, token="bad")
        self.assertEqual(r.status, 401)
        r, _ = self.ingest("nope", {"a": 1})
        self.assertEqual(r.status, 404)
        r, _ = self.ingest("worker", {"a": 1}, ctype="text/plain")
        self.assertEqual(r.status, 415)
        r, _ = self.ingest("worker", b"[1,2]")
        self.assertEqual(r.status, 400)
        r, _ = self.ingest("worker", b"{bad")
        self.assertEqual(r.status, 400)
        r, _ = self.req("POST", "/api/ingest/worker", {"Authorization": "Bearer ingest-tok", "Content-Type": "application/json",
                                                       "Content-Length": str(app.MAX_BODY + 1)})
        self.assertEqual(r.status, 413)

    def test_ingest_sanitizes_persists_and_merges(self):
        worker = {"batches": [{"id": "b1", "label": "B1", "tasks": [
            {"issue": "DEV-15", "phase": "gated", "gated": True, "fixed": True, "finalSHA": "abcdef1234",
             "gates": {"prisma": {"status": "PASS"}, "final_sha": {"status": "PASS", "sha": "abcdef1234"}},
             "note": "see 10.1.2.3", "secretThing": "x"}]}],
            "codex": {"activeCount": 2, "cap": 50}, "system": {"cores": 4, "disks": {"/workspace": {"pct": 91, "freeBytes": 1}}},
            "killSwitch": {"pass": False}, "usage": {"weeklyPct": 96}}
        box = {"repo": "RealDevFathom/devfathom-commercial", "workers": [{"instanceId": "i-1", "state": "running", "spotPrice": 3.1}],
               "github": {"merged": [{"number": 7, "title": "fix DEV-15", "mergedAt": 1, "sha": "abc", "headSha": "abcdef1234567890", "issues": ["DEV-15"]}],
                          "closedIssues": [{"number": 8, "title": "DEV-15", "closedAt": 2, "issues": ["DEV-15"]}]},
               "linear": {"available": True, "states": {"DEV-15": {"state": "Done", "type": "completed"}}}}
        self.assertEqual(self.ingest("worker", worker)[0].status, 200)
        self.assertEqual(self.ingest("box", box)[0].status, 200)
        with open(os.path.join(self.tmp, "worker.json")) as fh:
            stored = json.load(fh)
        self.assertNotIn("secretThing", json.dumps(stored))
        self.assertNotIn("10.1.2.3", json.dumps(stored))
        r, body = self.req("GET", "/api/state", {"Authorization": basic("ops", "s3cret-pass")})
        state = json.loads(body)
        t = state["batches"][0]["tasks"][0]
        self.assertTrue(t["done"])
        self.assertEqual(t["gates"]["merged"]["status"], "PASS")
        self.assertEqual(state["overview"]["done"], 1)
        self.assertFalse(state["sources"]["worker"]["stale"])
        codes = {a["code"] for a in state["alerts"]}
        for code in ("disk-/workspace", "reserve", "killswitch", "usage", "spot-i-1"):
            self.assertIn(code, codes)
        # restart reloads persisted payloads
        store = app.Store(self.tmp)
        self.assertIn("worker", store.snapshot())
        # known-issues for the box collector requires the ingest token
        r, _ = self.req("GET", "/api/known-issues")
        self.assertEqual(r.status, 401)
        r, body = self.req("GET", "/api/known-issues", {"Authorization": "Bearer ingest-tok"})
        self.assertEqual(json.loads(body)["issues"], ["DEV-15"])

    def test_stale_flags(self):
        snap = {"worker": {"receivedAt": 1000.0, "payload": {}}}
        st = app.build_state(snap, now=1000.0 + app.STALE_AFTER + 1)
        self.assertTrue(st["sources"]["worker"]["stale"])
        self.assertTrue(st["sources"]["box"]["stale"])
        self.assertIn("stale-worker", {a["code"] for a in st["alerts"]})

    def test_fail_closed_without_secrets(self):
        self.assertFalse(app.check_basic(basic("ops", ""), "ops", ""))
        self.assertFalse(app.check_bearer("Bearer ", ""))


if __name__ == "__main__":
    unittest.main()
