# Prettier check for files a PR changed; delegates to format-check.mjs (one Node process, Prettier API).
# usage: format-check.py <ref>  -> JSON {ref, checked, unformatted:[{file, alreadyUnformattedOnDevelop}], errors}
import os, subprocess, sys
REPO = os.environ.get("REPO", "/home/user/devfathom-commercial")
H = os.path.dirname(os.path.abspath(__file__))
sys.stdout.write(subprocess.check_output(["node", os.path.join(H, "format-check.mjs"), REPO, sys.argv[1]], text=True))
