import json,sys,os
p="/tmp/claude-0/-home-user-devfathom-commercial/1e96b9b3-08d2-5173-abc1-832d8f57aab3/scratchpad/mc-notes.json"
d=json.load(open(p)) if os.path.exists(p) else {}
d.setdefault(sys.argv[1],[]).append(sys.argv[2]); json.dump(d,open(p,"w"),indent=1)
