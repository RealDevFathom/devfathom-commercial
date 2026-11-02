import json,os,sys
S="/tmp/claude-0/-home-user-devfathom-commercial/1e96b9b3-08d2-5173-abc1-832d8f57aab3/scratchpad"
w=json.load(open(sys.argv[1]))["result"]
L=json.load(open(f"{S}/ledger.json")) if os.path.exists(f"{S}/ledger.json") else {}
for r in w:
    c=json.load(open(f"{S}/comments/{r['n']}.json"))
    L[str(r["n"])]=dict(c,posted=r["posted"],url=r.get("url"),reason=r["reason"])
json.dump(L,open(f"{S}/ledger.json","w"),indent=1)
print(len(L),"in ledger; not posted:",[k for k,v in L.items() if not v["posted"]])
