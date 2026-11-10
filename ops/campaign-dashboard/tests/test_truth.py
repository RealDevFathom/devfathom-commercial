"""Truthfulness rules: PASSED only on the exact final SHA, FAILED names the gate,
MERGED only when this task's own SHA was merged into develop during the campaign, Linear titles win."""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(os.path.dirname(HERE), d) for d in ("server", "tests", "collector")]

import app  # noqa: E402
from test_ai import fixture_state  # noqa: E402

J = "pharmacy-campaign-repair-20261108-1306"
R = "pharmacy-review-50"


def task(state, batch, issue):
    b = next(b for b in state["batches"] if b["id"] == batch)
    return next(t for t in b["tasks"] if t["issue"] == issue)


class TruthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.s = fixture_state()

    def test_failed_gate_is_named(self):
        v = task(self.s, J, "DEV-13")["verdict"]
        self.assertEqual(v["key"], "failed")
        self.assertIn("differential", v["gates"])
        self.assertIn("Unit", v["label"])  # complete_unit fails with new failures, so Unit is named
        v21 = task(self.s, R, "DEV-21")["verdict"]  # QA failed although required gates passed
        self.assertEqual((v21["key"], v21["gates"]), ("failed", ["qa_browser"]))
        self.assertEqual(v21["label"], "Failed: QA")

    def test_baseline_only_unit_failures_do_not_fail(self):
        t = task(self.s, J, "DEV-12")
        self.assertEqual(t["gates"]["complete_unit"]["status"], "FAIL")
        self.assertEqual(t["verdict"]["key"], "passed")

    def test_passed_requires_final_sha(self):
        t = {"gated": True, "gates": {k: {"status": "PASS"} for k in app.REQUIRED_GATES} | {"final_sha": {"status": "PENDING"}}}
        self.assertNotIn(app.verdict(t)["key"], ("passed", "merged", "done"))
        t["gates"]["final_sha"]["status"] = "PASS"
        self.assertEqual(app.verdict(t)["key"], "passed")

    def test_merge_must_match_final_sha(self):
        t12 = task(self.s, J, "DEV-12")  # PR #985 references DEV-12 but merged another SHA
        self.assertFalse(t12["merged"])
        self.assertIsNone(t12["merge"])
        self.assertEqual(t12["mergeMismatch"]["number"], 985)
        self.assertIn("not counted", t12["gates"]["merged"]["note"])
        t15 = task(self.s, J, "DEV-15")
        self.assertTrue(t15["merged"])
        self.assertEqual(t15["merge"]["number"], 994)
        self.assertEqual(t15["verdict"]["key"], "done")

    def test_merge_window_and_unknown_head(self):
        prs = [{"number": 1, "mergedAt": 100, "headSha": "abcdef1234"}]
        m, mm = app.match_merge(prs, "abcdef1234", since=200)
        self.assertIsNone(m)
        self.assertIn("before this batch", mm["reason"])
        m, mm = app.match_merge([{"number": 2, "mergedAt": 300}], "abcdef1234", since=200)
        self.assertIsNone(m)
        self.assertIn("head SHA unknown", mm["reason"])
        m, _ = app.match_merge([{"number": 3, "mergedAt": 300, "headSha": "ABCDEF1234ffff"}], "abcdef1234", since=200)
        self.assertEqual(m["number"], 3)
        self.assertFalse(app._sha_match("abc", "abc"))  # too short to trust

    def test_linear_titles_win(self):
        self.assertEqual(task(self.s, J, "DEV-15")["title"], "Purchasing procedures lack capability checks")
        self.assertEqual(task(self.s, J, "DEV-14")["title"], "Supplier link page crashes without a DB")

    def test_overview_counts_follow_truth(self):
        o = self.s["overview"]
        # pharmacy-review-50 (DEV-20) is archived, so live KPIs only count the current batch.
        self.assertEqual(o["merged"], 1)   # DEV-15 only; PR #985 does not count; DEV-20 is archived
        self.assertEqual(o["done"], 1)
        self.assertEqual(o["gated"], 2)    # passed on final SHA: DEV-12, DEV-15 (DEV-20 is in the archive)


if __name__ == "__main__":
    unittest.main()
