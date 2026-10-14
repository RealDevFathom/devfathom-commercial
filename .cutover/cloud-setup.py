#!/usr/bin/env python3
"""Explicit Cloud setup entry point; no automatic Codex hook is assumed."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
PINS = {
    "package.json": "f8d45a6e31167d76ee47dbbacc0754fb4a29b47fb890e992f4f4ea2302b6d9e7",
    "bun.lock": "a879bb6bb776a37e36c1e28bb4b36fea79ce3aec700847c2073007069553d38b",
}
PACKAGES = {
    "prisma": "7.9.1",
    "@prisma/client": "7.9.1",
    "next": "16.2.12",
    "vitest": "4.1.10",
    "typescript": "5.9.3",
}
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("mode", choices=("preflight", "install"))
parser.add_argument("--node-version")
args = parser.parse_args()

def run(argv):
    return subprocess.check_output(argv, cwd=ROOT, text=True, timeout=20).strip()

def verify_pins():
    for name, expected in PINS.items():
        path = ROOT / name
        if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise SystemExit("Pinned file changed: " + name)

def version(executable):
    path = shutil.which(executable)
    return run([path, "--version"]) if path else None

verify_pins()
receipt = {
    "phase": args.mode,
    "platform": sys.platform,
    "architecture": platform.machine(),
    "libc": platform.libc_ver(),
    "python": platform.python_version(),
    "bun": version("bun"),
    "node": version("node"),
    "head": run(["git", "rev-parse", "HEAD"]),
    "pinned_files_verified": sorted(PINS),
    "application_checks_run": [],
}
print(json.dumps(receipt, sort_keys=True), flush=True)
if args.mode == "preflight":
    raise SystemExit(0)
if sys.platform != "linux":
    raise SystemExit("Install requires Linux.")
if receipt["bun"] != "1.3.14":
    raise SystemExit("Install requires the reviewed Bun 1.3.14 runtime.")
if not args.node_version or not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", args.node_version):
    raise SystemExit("Supply the exact reviewed Node version.")
if receipt["node"] != args.node_version:
    raise SystemExit("Node differs from the reviewed version.")
if run(["git", "diff", "--name-only", "HEAD"]):
    raise SystemExit("Tracked changes exist; review them before installation.")
command = ["bun", "install", "--frozen-lockfile", "--ignore-scripts"]
env = os.environ.copy()
env.update({"CI": "1", "NEXT_TELEMETRY_DISABLED": "1"})
print(json.dumps({"phase": "install_command", "argv": command}), flush=True)
subprocess.run(command, cwd=ROOT, env=env, check=True, timeout=600)
verify_pins()
if run(["git", "diff", "--name-only", "HEAD"]):
    raise SystemExit("Installation changed tracked files; stop and review.")
installed = {}
for name, expected in PACKAGES.items():
    info = json.loads((ROOT / "node_modules" / name / "package.json").read_text())
    installed[name] = info["version"]
    if installed[name] != expected:
        raise SystemExit("Unexpected installed version: " + name)
print(json.dumps({
    "phase": "installation_verified",
    "bun": receipt["bun"],
    "node": receipt["node"],
    "installed_package_versions": installed,
    "pinned_files_unchanged": True,
    "dependency_lifecycle_scripts": "disabled",
    "application_checks_run": [],
}, sort_keys=True), flush=True)
