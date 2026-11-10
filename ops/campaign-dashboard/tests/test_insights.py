import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(os.path.dirname(HERE), d) for d in ("server", "tests", "collector")]

import insights  # noqa: E402
from test_ai import fixture_state  # noqa: E402


class InsightRuleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.state = fixture_state()
        cls.rules = cls.state["insights"]["rules"]
        cls.ids = {r["id"] for r in cls.rules}

    def test_shape(self):
        for r in self.rules:
            self.assertIn(r["severity"], ("crit", "warn", "info"))
            self.assertIn(r["kind"], ("warning", "suggestion"))
            self.assertIn(r["area"], ("overview", "now", "next", "batches", "history", "machine"))
            self.assertTrue(r["title"] and r["reason"] and r["evidence"])
            for e in r["evidence"]:
                self.assertTrue(e["link"].startswith("#"))

    def test_weakened_guards_and_repeat_failures(self):
        b = "pharmacy-campaign-repair-20261108-1306"
        self.assertIn(f"rule:guards:{b}:DEV-13", self.ids)               # touches vitest.config.ts
        self.assertIn(f"rule:repeat-fail:{b}:DEV-13:complete_unit", self.ids)
        self.assertIn(f"rule:tests-drop:{b}:DEV-13", self.ids)           # 4120 passed vs 4175 baseline
        self.assertIn(f"rule:blocked:{b}", self.ids)

    def test_time_based_rules(self):
        later = insights.rule_insights(self.state, now=self.state["serverTime"] + 1794400000)
        ids = {r["id"] for r in later}
        self.assertTrue(any(i.startswith("rule:stall-codex:") for i in ids))
        self.assertTrue(any(i.startswith("rule:idle:") for i in ids))

    def test_pressure_rules(self):
        st = dict(self.state)
        st["worker"] = dict(st["worker"], system={"cores": 4, "mem": {"pct": 93}, "disks": {
            "/workspace": {"pct": 80, "freeBytes": 250 * insights.GiB}}}, usage={"weeklyPct": 90})
        ids = {r["id"]: r for r in insights.rule_insights(st)}
        self.assertEqual(ids["rule:ram"]["severity"], "crit")
        for k in ("rule:disk-soon:/workspace", "rule:reserve-soon", "rule:usage-soon"):
            self.assertIn(k, ids)

    def test_guard_patterns(self):
        hits = dict(insights.guard_hits(["src/a.test.ts", "eslint.config.mjs", "src/lib/auth-guard.ts", "src/app/page.tsx",
                                         ".github/workflows/ci.yml", "src/middleware.ts"]))
        self.assertNotIn("src/app/page.tsx", hits)
        self.assertEqual(len(hits), 5)


if __name__ == "__main__":
    unittest.main()
