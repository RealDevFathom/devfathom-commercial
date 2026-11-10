"""Visual regression and rendering checks (skipped when node + playwright are not available).

Runs the real server in-process with a frozen clock and the fixture payloads, drives Chromium, and checks:
  * no console errors or failed requests (fonts, icons, scripts all served)
  * Geist / Geist Mono everywhere, including SVG chart text; no system monospace fallback
  * no horizontal overflow on a 390 px phone
  * a structural snapshot (KPI values, pipeline counts, status pills, insights) matches tests/visual/baseline/dom.json
  * screenshots match the committed baselines within a small tolerance (pixel diff with a stdlib PNG decoder)

Refresh baselines after an intended visual change:  UPDATE_SNAPSHOTS=1 python3 -m unittest tests.test_visual
"""
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path[:0] = [os.path.join(ROOT, d) for d in ("server", "collector")]

import app  # noqa: E402
import worker_collector as wc  # noqa: E402

BASE = os.path.join(HERE, "visual", "baseline")
FIXED = 1794300000  # 2026-11-10 14:20 PKT, after every fixture timestamp
PIXEL_TOLERANCE = 0.006  # fraction of pixels allowed to differ
CHANNEL_DELTA = 40


def have_playwright():
    if not shutil.which("node"):
        return False
    try:
        return subprocess.run(["node", "-e", "require('playwright')"], capture_output=True, timeout=20).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def read_png(path):
    """Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced) -> (w, h, bytes per pixel, rows)."""
    with open(path, "rb") as fh:
        data = fh.read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, idat, w = 8, b"", None
    while pos < len(data):
        n, ctype = struct.unpack(">I4s", data[pos:pos + 8])
        chunk = data[pos + 8:pos + 8 + n]
        if ctype == b"IHDR":
            w, hgt, depth, color = struct.unpack(">IIBB", chunk[:10])
            assert depth == 8 and color in (2, 6), "unsupported PNG"
            bpp = 4 if color == 6 else 3
        elif ctype == b"IDAT":
            idat += chunk
        pos += 12 + n
    raw = zlib.decompress(idat)
    stride = w * bpp
    rows, prev, i = [], bytearray(stride), 0
    for _ in range(hgt):
        f = raw[i]
        line = bytearray(raw[i + 1:i + 1 + stride])
        i += 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if f == 1:
                line[x] = (line[x] + a) & 255
            elif f == 2:
                line[x] = (line[x] + b) & 255
            elif f == 3:
                line[x] = (line[x] + ((a + b) >> 1)) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(bytes(line))
        prev = line
    return w, hgt, bpp, rows


def diff_ratio(a_path, b_path):
    aw, ah, abpp, arows = read_png(a_path)
    bw, bh, bbpp, brows = read_png(b_path)
    if (aw, ah) != (bw, bh):
        return 1.0
    bad = 0
    for ra, rb in zip(arows, brows):
        if ra == rb:
            continue
        for x in range(aw):
            pa, pb = x * abpp, x * bbpp
            if max(abs(ra[pa + k] - rb[pb + k]) for k in range(3)) > CHANNEL_DELTA:
                bad += 1
    return bad / float(aw * ah)


@unittest.skipUnless(have_playwright(), "node + playwright not available")
class VisualTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cfg = {"user": "ops", "password": "visual-test", "token": "tok", "trust_proxy": False}
        env_key = os.environ.pop("ANTHROPIC_API_KEY", None)
        srv = app.make_server("127.0.0.1", 0, cfg, cls.tmp)
        if env_key is not None:
            os.environ["ANTHROPIC_API_KEY"] = env_key
        # copy fixtures and pin file mtimes so mtime-derived values (ledger age, last activity) are deterministic
        jobs = os.path.join(cls.tmp, "jobs")
        shutil.copytree(os.path.join(ROOT, "fixtures", "jobs"), jobs)
        for dirpath, dirnames, filenames in os.walk(jobs):
            for n in dirnames + filenames:
                os.utime(os.path.join(dirpath, n), (FIXED - 900, FIXED - 900))
        worker = wc.collect(jobs, None, live_window=0, host_metrics=False, now=FIXED, superseded=["wave0-old-20261109"])
        with open(os.path.join(ROOT, "fixtures", "box.json")) as fh:
            box = json.load(fh)
        srv.store.put("worker", worker, now=FIXED - 20)
        srv.store.put("box", box, now=FIXED - 40)
        srv.state = lambda: app.build_state(srv.store.snapshot(), now=FIXED, ai=None)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        cls.srv = srv
        cls.out = os.path.join(cls.tmp, "shots")
        os.makedirs(cls.out)
        proc = subprocess.run(["node", os.path.join(HERE, "visual", "snap.js"), f"http://127.0.0.1:{srv.server_address[1]}/",
                               cls.out, str(FIXED * 1000)], capture_output=True, text=True, timeout=180)
        cls.result = json.loads(proc.stdout or "{}")
        fatal = cls.result.get("fatal", "")
        if "Executable doesn't exist" in fatal or "browserType.launch" in fatal:
            cls.tearDownClass()
            raise unittest.SkipTest("no Chromium available for playwright")

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_renders_without_errors(self):
        self.assertNotIn("fatal", self.result, self.result.get("fatal"))
        self.assertEqual(self.result["errors"], [])

    def test_fonts_everywhere(self):
        f = self.result["fonts"]
        self.assertTrue(f["geist"] and f["mono"], f)
        self.assertEqual(f["offenders"], [], "elements not rendered in Geist")
        self.assertTrue(f["svgText"])
        for fam in f["svgText"]:
            self.assertIn(fam.strip('"'), ("Geist", "Geist Mono"))

    def test_mobile_has_no_horizontal_overflow(self):
        self.assertLessEqual(self.result["mobileScrollWidth"], 390, self.result.get("mobileOverflowers"))

    def test_structure_snapshot(self):
        path = os.path.join(BASE, "dom.json")
        dom = self.result["dom"]
        if os.environ.get("UPDATE_SNAPSHOTS") or not os.path.exists(path):
            os.makedirs(BASE, exist_ok=True)
            with open(path, "w") as fh:
                json.dump(dom, fh, indent=1, sort_keys=True)
                fh.write("\n")
        with open(path) as fh:
            self.assertEqual(json.loads(json.dumps(dom)), json.load(fh))

    def test_screenshots_match_baseline(self):
        for name in self.result["shots"]:
            got = os.path.join(self.out, name)
            want = os.path.join(BASE, name)
            if os.environ.get("UPDATE_SNAPSHOTS") or not os.path.exists(want):
                shutil.copy(got, want)
                continue
            ratio = diff_ratio(got, want)
            if ratio > PIXEL_TOLERANCE:
                keep = os.path.join(BASE, f"FAILED-{name}")
                shutil.copy(got, keep)
                self.fail(f"{name} differs from baseline in {ratio:.2%} of pixels (new render saved to {keep})")


if __name__ == "__main__":
    unittest.main()
