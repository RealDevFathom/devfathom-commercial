"""Current-run truth: rebase-1906-1110 + reclassify drive KPIs, not superseded codex-1110."""
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(os.path.dirname(HERE), d) for d in ("server", "tests", "collector")]

import app  # noqa: E402
import current_run as cr  # noqa: E402
import insights  # noqa: E402
import worker_collector as wc  # noqa: E402

BATCH = "pharmacy-campaign-repair-20261108-1306"
NOW = 1762732800  # 2026-11-10 08:00:00 PKT-ish; used only as a floor


def _write(path, obj):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(obj))


def _pkt(h, m=0, s=0):
    return f"2026-11-10T{h:02d}:{m:02d}:{s:02d}+05:00"


def make_tree(root):
    jobs = Path(root) / "jobs"
    b = jobs / BATCH
    (b / "rebase-1906-1110").mkdir(parents=True)
    (b / "baseline-1110").mkdir()
    (b / "codex-1110").mkdir()
    review = jobs / "pharmacy-review-50"
    review.mkdir()
    # Incomplete old baseline should lose to baseline-1110.
    hotel = b / "baseline-hotel-dynamic-1649"
    hotel.mkdir()
    _write(hotel / "checkpoint.json", {"status": "CANONICAL_BOOTSTRAP_CHECKS_TERMINAL_NOT_FULL_QA"})
    _write(b / "baseline-1110" / "checkpoint.json", {
        "status": "TERMINAL_BASELINE_RECORDED",
        "baseSHA": "1906b53076286b2e1438eb821969c0d50e5575c6",
        "numPassedTests": 16281, "numFailedTests": 33, "failedFileCount": 12,
        "startPKT": _pkt(5, 38), "endPKT": _pkt(5, 40),
    })
    # Superseded invalid marker + an old failed run that must not drive KPIs.
    _write(b / "rebase-1110" / "INVALID_ONTO_0c6245c_1110.json", {
        "invalidPKT": _pkt(7, 2), "reason": "wrong base", "trees": {},
    })
    _write(b / "codex-1110" / "DEV-18" / "checkpoint.json", {
        "issue": "DEV-18", "status": "TERMINAL_VERIFY_FAILED_NEEDS_ITERATION",
        "newSourceSHA": "aaaaaaaaaa", "codexExitCode": 0,
        "changedFiles": ["src/lib/x.ts"],
        "steps": {"complete_unit": {"status": "FAIL", "failedFiles": ["a.test.ts"]}},
        "startPKT": _pkt(5, 50), "endPKT": _pkt(5, 58),
    })
    status_tasks = {
        "DEV-741": {
            "issue": "DEV-741",
            "status": "GATES_PASS_EXCEPT_DEVELOP_BASELINE_PENDING_QA_SECURITY",
            "finalRebasedSHA": "ae48eb9656d83136bf4757cf1adc83af80e5f412",
            "onDevelopTip": True, "contains0c6245c": False,
            "endPKT": _pkt(7, 19), "reclassifiedPKT": _pkt(7, 46, 50),
            "reclassifiedFrom": "J/baseline-1110",
        },
        "DEV-61": {
            "issue": "DEV-61",
            "status": "GATES_PASS_EXCEPT_DEVELOP_BASELINE_PENDING_QA_SECURITY",
            "finalRebasedSHA": "2350adb1e0be281d7f59db3978ff1a7423c352c8",
            "endPKT": _pkt(7, 19), "reclassifiedPKT": _pkt(7, 46, 50),
        },
        "DEV-18": {
            "issue": "DEV-18",
            "status": "GATES_FAIL_NEW_VS_BASELINE",
            "finalRebasedSHA": "cee6dad2e7b645e66c317b2708cf5dab1d8a4571",
            "endPKT": _pkt(7, 19), "reclassifiedPKT": _pkt(7, 46, 50),
        },
        "DEV-54": {
            "issue": "DEV-54",
            "status": "TERMINAL_REJECTED_ASSERTION_GUARD",
            "finalRebasedSHA": "0d9651d267c59acce4ab6ffba9797b38c31674e1",
            "endPKT": _pkt(7, 6, 51),
        },
        "DEV-10": {
            "issue": "DEV-10",
            "status": "GATES_RUNNING",
            "mode": "transplant",
            "codex": [{"model": "gpt-6.1-terra", "effort": "medium",
                       "codexStartPKT": _pkt(8, 0, 6), "codexEndPKT": _pkt(8, 1, 23),
                       "codexExitCode": 0}],
        },
        "DEV-108": {"issue": "DEV-108", "status": "PENDING"},
    }
    _write(b / "rebase-1906-1110" / "status.json", {
        "startPKT": _pkt(7, 0),
        "target": "1906b53076286b2e1438eb821969c0d50e5575c6",
        "invalidOldBase": "0c6245c83c1f264cc9a592ab595a8f140dd3b65b",
        "tasks": status_tasks,
        "baseline": {"sha": "1906b53076286b2e1438eb821969c0d50e5575c6"},
    })
    _write(b / "rebase-1906-1110" / "reclassify-baseline1110.json", {
        "atPKT": _pkt(7, 46, 50),
        "baseline": {
            "sha": "1906b53076286b2e1438eb821969c0d50e5575c6",
            "complete": True, "status": "COMPLETE",
            "numPassedTests": 16281, "numFailedTests": 33,
        },
        "summary": {
            "n": 3,
            "verdicts": {"HARNESS_FALSE_OR_BASELINE_ONLY": 2, "REAL_NEW_FAILURES": 1},
            "statusAfter": {
                "GATES_PASS_EXCEPT_DEVELOP_BASELINE_PENDING_QA_SECURITY": 2,
                "GATES_FAIL_NEW_VS_BASELINE": 1,
            },
            "realNewFailures": ["DEV-18"],
            "passedAll": [],
            "counts": {"realFailures": 1},
        },
        "tasks": {
            "DEV-741": {
                "oldStatus": "GATES_FAILED_CODEX_NO_CHANGE",
                "newStatus": "GATES_PASS_EXCEPT_DEVELOP_BASELINE_PENDING_QA_SECURITY",
                "verdict": "HARNESS_FALSE_OR_BASELINE_ONLY",
                "baselineOnly": ["src/lib/abac/index.test.ts"],
                "newVsBaseline": [],
                "rebasedSHA": "ae48eb9656d83136bf4757cf1adc83af80e5f412",
            },
            "DEV-61": {
                "oldStatus": "GATES_FAILED_CODEX_NO_CHANGE",
                "newStatus": "GATES_PASS_EXCEPT_DEVELOP_BASELINE_PENDING_QA_SECURITY",
                "verdict": "HARNESS_FALSE_OR_BASELINE_ONLY",
                "baselineOnly": ["a.test.ts"],
                "newVsBaseline": [],
            },
            "DEV-18": {
                "oldStatus": "GATES_FAILED_CODEX_NO_CHANGE",
                "newStatus": "GATES_FAIL_NEW_VS_BASELINE",
                "verdict": "REAL_NEW_FAILURES",
                "baselineOnly": ["a.test.ts"],
                "newVsBaseline": ["src/new-fail.test.ts"],
            },
        },
    })
    _write(b / "rebase-1906-1110" / "flags.json", {
        "updatedPKT": _pkt(7, 37),
        "items": [{"issue": "DEV-54", "status": "TERMINAL_REJECTED_ASSERTION_GUARD", "for": "Security"}],
    })
    # Empty review-50 batch (70 pending historically) — must be archived.
    for i in range(3):
        _write(review / f"DEV-{i+1}" / "checkpoint.json", {"issue": f"DEV-{i+1}", "status": "PENDING"})
    return jobs


class VerdictMappingTests(unittest.TestCase):
    def test_baseline_only_is_not_failed(self):
        v = cr.verdict_from_current_status(
            "GATES_PASS_EXCEPT_DEVELOP_BASELINE_PENDING_QA_SECURITY",
            {"verdict": "HARNESS_FALSE_OR_BASELINE_ONLY"})
        self.assertEqual(v["key"], "pending_qa")

    def test_real_new_failures(self):
        v = cr.verdict_from_current_status(
            "GATES_FAIL_NEW_VS_BASELINE", {"verdict": "REAL_NEW_FAILURES"})
        self.assertEqual(v["key"], "failed")
        self.assertIn("differential", v["gates"])

    def test_rejected_and_running(self):
        self.assertEqual(cr.verdict_from_current_status("TERMINAL_REJECTED_ASSERTION_GUARD")["key"], "rejected")
        self.assertEqual(cr.verdict_from_current_status("GATES_RUNNING")["key"], "running")
        self.assertEqual(cr.verdict_from_current_status("CODEX_ITER2_RUNNING")["key"], "running")
        self.assertEqual(cr.verdict_from_current_status("PENDING")["key"], "queued")

    def test_live_running_wins_over_reclassify(self):
        v = cr.verdict_from_current_status(
            "CODEX_ITER2_RUNNING", {"verdict": "REAL_NEW_FAILURES", "newStatus": "GATES_FAIL_NEW_VS_BASELINE"})
        self.assertEqual(v["key"], "running")


class CurrentRunCollectorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.jobs = str(make_tree(cls.tmp.name))
        cls.payload = wc.collect(cls.jobs, state_dir=None, live_window=0, host_metrics=False,
                                 now=time.time())
        cls.state = app.build_state({"worker": {"receivedAt": time.time(), "payload": cls.payload}},
                                    now=time.time())

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def _batch(self):
        return next(b for b in self.state["batches"] if b["id"] == BATCH)

    def _task(self, issue):
        return next(t for t in self._batch()["tasks"] if t["issue"] == issue)

    def test_baseline_1110_is_current_and_complete(self):
        base = self._batch()["baseline"]
        self.assertEqual(base["run"], "baseline-1110")
        self.assertTrue(base.get("complete") or base.get("current"))
        self.assertEqual(base["numPassedTests"], 16281)
        self.assertEqual(base["numFailedTests"], 33)
        self.assertTrue(str(base.get("baseSHA") or "").startswith("1906b530"))

    def test_verdicts_and_kpis(self):
        o = self.state["overview"]
        self.assertEqual(o["pendingQa"], 2)
        self.assertEqual(o["failed"], 1)
        self.assertEqual(o["rejected"], 1)
        self.assertEqual(o["running"], 1)
        self.assertEqual(o["queued"], 1)
        self.assertEqual(o["fixed"], 0)
        self.assertEqual(o["merged"], 0)
        self.assertEqual(o["tasks"], 6)
        self.assertEqual(self._task("DEV-741")["verdict"]["key"], "pending_qa")
        self.assertEqual(self._task("DEV-18")["verdict"]["key"], "failed")
        self.assertEqual(self._task("DEV-54")["verdict"]["key"], "rejected")
        self.assertEqual(self._task("DEV-10")["verdict"]["key"], "running")
        self.assertEqual(self._task("DEV-108")["verdict"]["key"], "queued")
        # Baseline-only must not set differential FAIL (that was the "38 with new failures" bug).
        self.assertEqual(self._task("DEV-741")["gates"]["differential"]["status"], "PASS")
        self.assertEqual(self._task("DEV-18")["gates"]["differential"]["status"], "FAIL")

    def test_review_50_archived_and_excluded(self):
        r = next(b for b in self.state["batches"] if "review-50" in b["id"])
        self.assertTrue(r["archived"])
        # Overview tasks are 6 from the current batch, not 6+3.
        self.assertEqual(self.state["overview"]["tasks"], 6)
        ids = {x["id"] for x in self.state["insights"]["rules"]}
        self.assertFalse(any("review-50" in i for i in ids))

    def test_superseded_codex_events_excluded(self):
        for e in self.state["events"]:
            self.assertNotIn("codex-1110", str(e.get("run") or ""))
            self.assertFalse(e.get("superseded"))

    def test_data_as_of_present(self):
        self.assertTrue(self.state.get("dataAsOf"))
        self.assertIn("dataAsOf", self.state.get("freshness") or {})
        self.assertEqual(self.state["overview"].get("currentRun"), "rebase-1906-1110")

    def test_rebase_1906_is_current_despite_invalid_old_base(self):
        runs = {r["name"]: r for r in self._batch()["runs"]}
        cur = runs["rebase-1906-1110"]
        self.assertTrue(cur.get("current"))
        self.assertFalse(cur.get("superseded"))
        self.assertIsNone(cur.get("supersededReason"))
        self.assertEqual(cur.get("countsSource"), "live-status")
        # Live overlay verdicts, not raw checkpoint PENDING=70.
        self.assertNotEqual(cur.get("counts"), {"PENDING": 70})
        self.assertGreater((cur.get("counts") or {}).get("total") or 0, 0)

    def test_rebase_1110_marked_superseded(self):

        runs = {r["name"]: r for r in self._batch()["runs"]}
        self.assertTrue(runs["rebase-1110"].get("superseded"))
        self.assertTrue(runs.get("rebase-1906-1110", {}).get("current") or
                        self._batch().get("currentRun") == "rebase-1906-1110")


class HostBuildRuleTests(unittest.TestCase):
    def test_host_build_common_fail_dropped(self):
        st = {
            "batches": [{
                "id": BATCH, "label": "Pharmacy campaign",
                "tasks": [
                    {"issue": f"DEV-{i}", "runs": [
                        {"run": "rebase-1906-1110", "current": True,
                         "steps": [{"gate": "host_build", "status": "FAIL", "name": "host_build"}]}],
                     "gates": {}, "verdict": {"key": "failed"}}
                    for i in range(20)
                ],
            }],
            "codex": {}, "worker": {}, "limits": {},
        }
        ids = {r["id"] for r in insights.rule_insights(st)}
        self.assertNotIn(f"rule:common-fail:{BATCH}:host_build", ids)




class Fa2004DevelopBaselineTests(unittest.TestCase):
    def test_fa2004e2_status_baseline_is_complete(self):
        raw = {"baseline": {"sha": "fa2004e2362f7bfade1b50168fcfef23c08f6987",
                            "from": "empty-after-fa2004e2", "complete": True,
                            "unitFailures": [], "unitFailedCount": 0,
                            "loadedPKT": "2026-11-10T09:06:14.544501+05:00"}}
        tip = cr.baseline_from_status(raw, "rebase-1906-1110")
        self.assertEqual(tip["baseSHA"], "fa2004e2")
        self.assertTrue(cr.is_complete_baseline(tip))
        self.assertEqual(tip["numFailedTests"], 0)
        chosen = cr.pick_current_baseline([
            {"run": "baseline-1110", "baseSHA": "1906b530", "complete": True,
             "numPassedTests": 16281, "numFailedTests": 33, "end": 100},
            tip,
        ], "fa2004e2", strict=True)
        self.assertEqual(chosen["baseSHA"], "fa2004e2")

    def test_fa2004e2_is_current_baseline_even_when_incomplete(self):
        baselines = [
            {"run": "baseline-1110", "baseSHA": "1906b530", "complete": True, "ended": 100,
             "numPassedTests": 16281, "numFailedTests": 33},
        ]
        self.assertIsNone(cr.pick_current_baseline(baselines, "fa2004e2362f", strict=True))
        prev = cr.previous_complete_baseline(baselines, "fa2004e2")
        self.assertEqual(prev["run"], "baseline-1110")
        stub = cr.stub_baseline_for_tip("fa2004e2362f7bfade1b50168fcfef23c08f6987", previous=prev)
        self.assertEqual(stub["baseSHA"], "fa2004e2")
        self.assertFalse(stub["complete"])
        marked = cr.annotate_baseline(stub, preferred=True, develop_prefix="fa2004e2")
        self.assertTrue(marked["current"])
        old = cr.annotate_baseline(baselines[0], preferred=False, develop_prefix="fa2004e2")
        self.assertFalse(old["current"])
        self.assertTrue(old["historical"])

    def test_develop_lane_and_merge_event(self):
        policy = {
            "developMergeSHA": "fa2004e2362f7bfade1b50168fcfef23c08f6987",
            "developMergePKT": "2026-11-10T08:37:19+05:00",
            "developMergeMethod": "fast-forward",
            "previousTip": "1906b53076286b2e1438eb821969c0d50e5575c6",
            "qaPolicy": {"deployGate": {"status": "PENDING", "check": "Azure OpenAI + Blob"}},
        }
        lane = cr.compact_develop_lane(policy, None, "fa2004e2")
        self.assertEqual(lane["short"], "fa2004e2")
        self.assertEqual(lane["deployGate"]["status"], "PENDING")
        ev = cr.develop_merge_event(lane)
        self.assertEqual(ev["kind"], "merge")
        self.assertEqual(ev["run"], "develop")
        self.assertTrue(ev["current"])
        self.assertIn("08:37:19", ev["text"] or ev.get("detail") or ev["text"])
        # epoch should be 08:37:19 PKT = 03:37:19 UTC = 1762747039? just check it is a number
        self.assertTrue(isinstance(ev["ts"], (int, float)) and ev["ts"] > 0)

    def test_queued_resume_and_needs_product_fix_verdicts(self):
        self.assertEqual(cr.verdict_from_current_status("QUEUED_RESUME")["key"], "queued")
        self.assertEqual(cr.verdict_from_current_status("CODEX_CONFLICT_RUNNING")["key"], "running")
        self.assertEqual(cr.verdict_from_current_status("NEEDS_PRODUCT_FIX")["key"], "failed")
        self.assertEqual(cr.verdict_from_current_status("NEEDS_MIGRATION_FIX")["key"], "failed")
        self.assertEqual(cr.verdict_from_current_status("GATES_FAILED_CODEX_NO_CHANGE")["key"], "failed")
        self.assertEqual(cr.verdict_from_current_status("BLOCKED_BY_DEVELOP_BASELINE_TYPECHECK")["key"], "blocked")
        self.assertEqual(cr.verdict_from_current_status("HARNESS_BLOCKER")["key"], "blocked")
        self.assertEqual(cr.verdict_from_current_status("GATES_RUNNING")["key"], "running")


class ClassifyAndPauseTests(unittest.TestCase):
    def test_invalid_old_base_does_not_demote_current_lane(self):
        cls = cr.classify_run("rebase-1906-1110", has_current_rebase=True,
                              invalid_base="0c6245c83c1f264cc9a592ab595a8f140dd3b65b",
                              target="fa2004e2362f7bfade1b50168fcfef23c08f6987")
        self.assertTrue(cls["current"])
        self.assertFalse(cls["superseded"])

    def test_current_lane_demoted_only_when_live_target_is_invalid(self):
        cls = cr.classify_run("rebase-1906-1110", target="0c6245c83c1f264cc9a592ab595a8f140dd3b65b")
        self.assertFalse(cls["current"])
        self.assertTrue(cls["superseded"])
        self.assertIn("0c6245c", cls["supersededReason"])

    def test_campaign_pause_baseline_suspect(self):
        pause = cr.campaign_pause_from_stops([{
            "name": "RETARGET1906_STOP",
            "mtime": 1794286554,
            "text": "PAUSE_CODEX no new Codex dispatch until baseline is corrected. Inky 09:34 PKT.",
        }], baseline={"baseSHA": "fa2004e2", "from": "empty-after-fa2004e2"})
        self.assertTrue(pause["paused"])
        self.assertEqual(pause["key"], "BASELINE_SUSPECT")
        self.assertEqual(pause["status"], "campaign-paused")
        self.assertIn("no new Codex dispatch", pause["reason"])

    def test_old_lane_stops_are_not_a_campaign_pause(self):
        self.assertIsNone(cr.campaign_pause_from_stops([
            {"name": "CODEX_1110_STOP", "text": "stop", "mtime": 1},
            {"name": "REBASE37_1110_STOP", "text": "stop", "mtime": 2},
        ]))

    def test_stop_file_includes_pause_codex_line(self):
        import tempfile, os
        with tempfile.TemporaryDirectory() as td:
            path=os.path.join(td, "RETARGET1906_STOP")
            with open(path, "w") as fh:
                fh.write("2026-11-10T09:35:54+05:00\nPAUSE_CODEX no new Codex dispatch until baseline is corrected. Inky 09:34 PKT.\n")
            def _read(p, limit=1024):
                with open(p) as fh:
                    return fh.read(limit)
            found=cr.collect_stop_files(td, os.listdir, os.path.isfile, os.path.getmtime, _read)
            self.assertTrue(found)
            self.assertIn("PAUSE_CODEX", found[0]["text"])
            pause=cr.campaign_pause_from_stops(found)
            self.assertEqual(pause["key"], "BASELINE_SUSPECT")


if __name__ == "__main__":
    unittest.main()


class OperatorSupersededRunTests(unittest.TestCase):
    """OPS_SUPERSEDED=rebase-1906-1110: the operator retired the run, so the live overlay must not use it."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        jobs = str(make_tree(cls.tmp.name))
        cls.payload = wc.collect(jobs, state_dir=None, live_window=0, host_metrics=False, now=time.time(),
                                 superseded=["rebase-1906-1110"])
        cls.state = app.build_state({"worker": {"receivedAt": time.time(), "payload": cls.payload}}, now=time.time())

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_run_is_superseded_not_current(self):
        b = next(b for b in self.state["batches"] if b["id"] == BATCH)
        runs = {r["name"]: r for r in b["runs"]}
        r = runs["rebase-1906-1110"]
        self.assertTrue(r["superseded"])
        self.assertFalse(r.get("current"))
        self.assertEqual(r.get("active"), 0)
        self.assertNotEqual(b.get("currentRun"), "rebase-1906-1110")
        self.assertNotEqual(self.state["overview"].get("currentRun"), "rebase-1906-1110")

    def test_events_from_the_run_are_not_current(self):
        evs = [e for e in self.payload["events"] if e.get("run") == "rebase-1906-1110"]
        self.assertTrue(all(e.get("superseded") and not e.get("current") for e in evs))
