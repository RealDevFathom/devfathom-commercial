import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "collector"))

import worker_collector as wc  # noqa: E402

FIXTURES = os.path.join(ROOT, "fixtures", "jobs")
J = "pharmacy-campaign-repair-20261108-1306"


class DiscoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.batches = {b["id"]: b for b in wc.collect_batches(FIXTURES, live_window=0)}

    def task(self, batch, issue):
        return next(t for t in self.batches[batch]["tasks"] if t["issue"] == issue)

    def test_all_job_roots_are_batches(self):
        self.assertEqual(set(self.batches), {J, "pharmacy-review-50", "pharmacy-counter-v2-20261110-0900"})
        self.assertEqual(self.batches["pharmacy-counter-v2-20261110-0900"]["label"], "Pharmacy counter v2 · 2026-11-10 09:00")

    def test_runs_and_attempts(self):
        b = self.batches[J]
        self.assertEqual(sorted(r["name"] for r in b["runs"]), ["baseline-1110", "codex-1110", "gates-1110"])
        self.assertEqual(b["attemptDirs"], 1)
        self.assertEqual(b["attemptJobs"], 1)
        self.assertEqual(b["baselineJobs"], 1)  # BASE-0001 is not a task
        self.assertNotIn("BASE-0001", [t["issue"] for t in b["tasks"]])
        self.assertEqual(sorted(b["policies"]), ["MERGE_GATE_POLICY_v3.md"])
        self.assertEqual(sorted(f["file"] for f in b["files"]), ["admission.json", "campaign70-handoff-20261108.json"])

    def test_task_states(self):
        self.assertEqual(self.task(J, "DEV-10")["phase"], "running")
        self.assertEqual(self.task(J, "DEV-10")["currentStep"], "typecheck")
        self.assertEqual(self.task(J, "DEV-13")["phase"], "failed")
        self.assertEqual(self.task(J, "DEV-14")["phase"], "blocked")
        self.assertTrue(self.task(J, "DEV-15")["gated"])

    def test_differential_vs_baseline(self):
        t12 = self.task(J, "DEV-12")
        self.assertEqual(t12["gates"]["complete_unit"]["status"], "FAIL")
        self.assertEqual(t12["gates"]["differential"]["status"], "PASS")  # only baseline failures
        self.assertTrue(t12["gated"])
        self.assertEqual(t12["finalSHA"], "c3d4e5f607")
        t13 = self.task(J, "DEV-13")
        self.assertEqual(t13["gates"]["differential"]["status"], "FAIL")
        self.assertEqual(t13["gates"]["differential"]["newFailures"], ["src/server/pharmacy/returns.test.ts"])

    def test_legacy_layout_and_unknown_steps(self):
        t = self.task("pharmacy-review-50", "DEV-21")
        self.assertEqual(t["gates"]["qa_browser"]["status"], "FAIL")
        self.assertIn("db_gates", t["gates"])           # unknown gate -> extra column
        self.assertIn("independent_gates", t["gates"])
        self.assertEqual(t["gates"]["docker"]["status"], "PASS")  # container-image-checkpoint

    def test_new_batch_and_run_dirs_appear_automatically(self):
        tmp = tempfile.mkdtemp()
        try:
            root = os.path.join(tmp, "jobs")
            shutil.copytree(FIXTURES, root)
            run = os.path.join(root, "brand-new-batch-20261111-0800", "gates-1111", "DEV-500")
            os.makedirs(run)
            with open(os.path.join(run, "checkpoint.json"), "w") as fh:
                json.dump({"issue": "DEV-500", "status": "RUNNING", "sourceSHA": "abc",
                           "steps": {"weird_new_step": {"status": "PASS"}}}, fh)
            os.makedirs(os.path.join(root, J, "codex-1111"))
            batches = {b["id"]: b for b in wc.collect_batches(root, live_window=0)}
            self.assertIn("brand-new-batch-20261111-0800", batches)
            t = batches["brand-new-batch-20261111-0800"]["tasks"][0]
            self.assertEqual(t["gates"]["weird_new_step"]["status"], "PASS")
            self.assertIn("codex-1111", [r["name"] for r in batches[J]["runs"]])
        finally:
            shutil.rmtree(tmp)

    def test_usage_resume_file(self):
        u = wc.collect_usage(FIXTURES)
        self.assertFalse(u["stopActive"])
        self.assertEqual(u["weeklyPct"], 72.0)

    def test_collect_payload_is_sanitized_and_complete(self):
        sdir = tempfile.mkdtemp()
        try:
            payload = wc.collect(FIXTURES, sdir, live_window=0, disks=())
            self.assertEqual(payload["codex"]["cap"], 50)
            self.assertEqual(payload["codex"]["activeCount"], 3)
            self.assertIn("system", payload)
            self.assertNotIn("/workspace/jobs/", json.dumps(payload))
            self.assertTrue(os.path.exists(os.path.join(sdir, "state.json")))
            self.assertGreaterEqual(payload["allTime"]["codexJobsSeen"], 5)
        finally:
            shutil.rmtree(sdir)

    def test_status_and_time_parsing(self):
        self.assertEqual(wc.norm_status("TERMINAL_HARNESS_OR_PRECONDITION_BLOCKER"), "BLOCKED")
        self.assertEqual(wc.norm_status("CODEX_RUNNING"), "RUNNING")
        self.assertEqual(wc.norm_status("BROKEN"), "FAIL")
        self.assertEqual(wc.parse_ts("2026-11-10T05:00:00+05:00"), wc.parse_ts("2026-11-10 05:00"))
        self.assertEqual(wc.parse_ts("2026-11-10T00:00:00Z"), wc.parse_ts("2026-11-10T05:00:00 PKT"))

    def test_readonly_command_whitelist(self):
        for argv in (["git", "status"], ["systemctl", "restart", "x"], ["systemctl", "show", "stop"],
                     ["codex", "exec"], ["ip", "netns", "exec", "codex-home", "tailscale", "down"]):
            with self.assertRaises(PermissionError):
                wc.run_ro(argv)

    def test_refuses_state_under_workspace(self):
        with self.assertRaises(SystemExit):
            wc.safe_state_dir("/workspace/state")


class BoxWhitelistTests(unittest.TestCase):
    def test_box_whitelist(self):
        import box_collector as bc
        bc.check_readonly(["aws", "ec2", "describe-instances", "--region", "eu-north-1"])
        bc.check_readonly(["gh", "api", "-X", "GET", "repos/o/r/pulls"])
        bc.check_readonly(["gh", "pr", "list"])
        for argv in (["aws", "ec2", "terminate-instances"], ["aws", "s3", "rm"], ["gh", "api", "repos/o/r"],
                     ["gh", "api", "-X", "POST", "x"], ["gh", "api", "-X", "GET", "-f", "a=b", "x"],
                     ["gh", "pr", "merge", "1"], ["gh", "issue", "close", "1"], ["git", "push"]):
            with self.assertRaises(PermissionError, msg=argv):
                bc.check_readonly(argv)


if __name__ == "__main__":
    unittest.main()
