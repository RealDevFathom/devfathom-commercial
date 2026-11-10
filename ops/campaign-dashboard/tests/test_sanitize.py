import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "collector"))

from sanitize import is_sensitive_key, sanitize, scrub_string  # noqa: E402


class SanitizeTests(unittest.TestCase):
    def test_copies_identical(self):
        with open(os.path.join(ROOT, "collector", "sanitize.py"), "rb") as a, \
                open(os.path.join(ROOT, "server", "sanitize.py"), "rb") as b:
            self.assertEqual(a.read(), b.read(), "collector/sanitize.py and server/sanitize.py must match")

    def test_drops_sensitive_keys_at_any_depth(self):
        data = {
            "issue": "DEV-10", "token": "x", "INGEST_TOKEN": "x", "clientSecret": "x", "password": "x",
            "passwd": "x", "apiKey": "x", "api_key": "x", "Authorization": "x", "cookie": "x",
            "credentials": "x", "privateKey": "x", "email": "x", "phone": "x", "ip": "x", "publicIpv4": "x",
            "ipv6": "x", "host": "x", "dbHost": "x", "url": "x", "prUrl": "x",
            "nested": [{"secretValue": 1, "ok": 2}],
        }
        out = sanitize(data)
        self.assertEqual(out, {"issue": "DEV-10", "nested": [{"ok": 2}]})

    def test_keeps_campaign_keys(self):
        for key in ("sourceSHA", "newSourceSHA", "host_build", "steps", "changedFiles", "status",
                    "activeCodexOrVerify", "system", "killSwitch", "repo", "instanceId", "spotPrice"):
            self.assertFalse(is_sensitive_key(key), key)

    def test_redacts_values(self):
        cases = [
            "connect to 10.0.12.7 failed",
            "via fe80::1ff:fe23:4567:890a%eth0",
            "addr 2001:0db8:85a3:0000:0000:8a2e:0370:7334",
            "owner someone@example.com",
            "ghp_" + "A" * 36,
            "gho_" + "b" * 36,
            "key sk-" + "c" * 32,
            "xoxb-123456789012-abcdef",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
        ]
        for c in cases:
            out = scrub_string(c)
            self.assertIn("[redacted]", out, c)
        self.assertNotIn("10.0.12.7", scrub_string(cases[0]))

    def test_leaves_normal_values(self):
        for s in ("2026-11-10T12:30:45+05:00", "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", "DEV-10",
                  "TERMINAL_EXACT_SOURCE_GATES_NOT_FULL_QA", "src/server/pharmacy/counter.ts", "task-runner",
                  "gpt-6.1-sol", "12:06"):
            self.assertEqual(scrub_string(s), s)

    def test_strips_workspace_paths(self):
        self.assertEqual(scrub_string("/workspace/jobs/J/gates-1110/DEV-14/db.sock"), "J/gates-1110/DEV-14/db.sock")
        self.assertEqual(scrub_string("error at /workspace/jobs/J/x.log line 3"), "error at J/x.log line 3")
        self.assertEqual(sanitize({"/workspace/jobs/J": 1}), {"J": 1})

    def test_depth_guard(self):
        deep = cur = {}
        for _ in range(200):
            cur["a"] = {}
            cur = cur["a"]
        sanitize(deep)  # must not raise RecursionError


if __name__ == "__main__":
    unittest.main()
