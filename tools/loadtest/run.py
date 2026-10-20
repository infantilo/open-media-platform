from common import *
import threading, statistics, sys, os, http.client, urllib.parse
DUR=float(sys.argv[1]) if len(sys.argv)>1 else 20
st=json.load(open(".state.json"))
op=login(*TEST_USER); adm=login(*ADMIN)
pid=int(open(os.environ.get("OMP_PID_FILE",os.path.join(os.path.dirname(os.path.abspath(__file__)),"../../.run/orchestrator.pid"))).read())
def cpu():
    f=open(f"/proc/{pid}/stat").read().rsplit(")",1)[1].split()
    return (int(f[11])+int(f[12]))/os.sysconf("SC_CLK_TCK")
lat={}; errs={}; lk=threading.Lock(); stop=time.time()+DUR
def worker(name,path,tok,sleep=0,method="GET",body=None):
    c=http.client.HTTPConnection("localhost",8000,timeout=60)
    while time.time()<stop:
        t=time.time()
        try:
            c.request(method,"/api/v1"+path,body=body,headers={"Authorization":"Bearer "+tok,"Content-Type":"application/json"})
            r=c.getresponse(); r.read(); ok=r.status==200
            if not ok: raise Exception(r.status)
            with lk: lat.setdefault(name,[]).append(time.time()-t)
        except Exception as e:
            with lk: errs[(name,str(e)[:40])]=errs.get((name,str(e)[:40]),0)+1
            c.close(); c=http.client.HTTPConnection("localhost",8000,timeout=60)
        if sleep: time.sleep(sleep)
sse_events=[0]
def sse():
    c=http.client.HTTPConnection("localhost",8000,timeout=60)
    c.request("GET","/api/v1/events?access_token="+adm)
    r=c.getresponse()
    while time.time()<stop:
        try:
            l=r.fp.readline()
            if l.startswith(b"data:"): sse_events[0]+=1
        except Exception: break
jobs=[("PATCH param (operator, auth+authz+audit)",f"/nodes/{st['node']}/params/pattern",op,0,"PATCH",json.dumps({"value":"smpte"}))]*20
jobs+=[("me/consoles (operator)","/me/consoles",op,0.05)]*5
jobs+=[("GET /workflows",  "/workflows",adm,0.05)]*3+[("GET /nodes","/nodes",adm,0.05)]*3+[("GET /graph","/graph",adm,0.05)]*3
ths=[threading.Thread(target=worker,args=j) for j in jobs]+[threading.Thread(target=sse) for _ in range(40)]
c0=cpu(); t0=time.time()
for t in ths: t.start()
for t in ths: t.join()
el=time.time()-t0; c1=cpu()
print(f"dauer {el:.1f}s, orchestrator-CPU {(c1-c0)/el*100:.0f}% eines Kerns, sse-events empfangen {sse_events[0]}")
tot=0
for n,v in sorted(lat.items()):
    v.sort(); tot+=len(v)
    print(f"{n:32s} n={len(v):6d} rps={len(v)/el:7.1f} p50={v[len(v)//2]*1000:7.1f}ms p95={v[int(len(v)*.95)]*1000:7.1f}ms max={v[-1]*1000:7.1f}ms")
print("fehler",errs,"gesamt-rps",round(tot/el,1))
