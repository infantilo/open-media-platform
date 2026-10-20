from common import *
import sys
adm=login(*ADMIN)
N=int(sys.argv[1]) if len(sys.argv)>1 else 149
for i in range(N):
    roles=[{"name":f"r{k}","nodeType":"omp-source"} for k in range(8)]
    req("POST","/workflows",{"name":f"loadtest-{i:03d}","definition":{"roles":roles,"connections":[]}},adm)
real=req("POST","/workflows",{"name":"loadtest-real","definition":{"roles":[{"name":"src","nodeType":"omp-source"}],"connections":[]}},adm)
print("real",real["id"])
req("POST",f"/workflows/{real['id']}/start",None,adm)
for _ in range(40):
    w=req("GET",f"/workflows/{real['id']}",None,adm)
    if w["status"]=="started": break
    time.sleep(1)
print(w["status"], w.get("runtime"))
try: req("POST","/auth/users",{"username":"claude-loadtest","password":"loadtest-pw-123"},adm)
except Exception as e: print("user",e)
b=req("POST","/admin/role-bindings",{"subject":"claude-loadtest","workflowId":real["id"],"nodeId":"*","verb":"operate"},adm)
print("binding",b)
json.dump({"wf":real["id"],"node":w["runtime"]["src"]["nodeId"]},open(".state.json","w"))
