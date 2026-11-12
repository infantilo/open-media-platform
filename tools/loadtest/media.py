"""Medienpfad-Lasttest: N Browser-Clients mit je T Vorschau-Kacheln (Einzelbild-Polling wie ui/graph/flow-canvas.ts,
alle 500 ms) ueber den Orchestrator-Stream-Proxy auf einen echten omp-viewer (omp-source -> omp-viewer).
  nice python3 media.py setup | run <Sekunden> <Clients> [Kacheln=4] | cleanup"""
from common import *
import sys, os, threading, http.client, random
ST=os.path.join(os.path.dirname(os.path.abspath(__file__)),".media.json")
def pidcpu(pid):
    f=open(f"/proc/{pid}/stat").read().rsplit(")",1)[1].split(); return (int(f[11])+int(f[12]))/os.sysconf("SC_CLK_TCK")
def setup():
    adm=login(*ADMIN)
    d={"roles":[{"name":"src","nodeType":"omp-source"},{"name":"viewer","nodeType":"omp-viewer"}],"connections":[{"fromRole":"src","toRole":"viewer","toReceiver":"Receiver 1"}]}
    wf=req("POST","/workflows",{"name":"loadtest-media","definition":d},adm)
    req("POST",f"/workflows/{wf['id']}/start",None,adm)
    for _ in range(60):
        w=req("GET",f"/workflows/{wf['id']}",None,adm)
        if w["status"] in("started","failed"): break
        time.sleep(1)
    print(w["status"],w.get("error")); json.dump({"wf":wf["id"],"viewer":w["runtime"]["viewer"]["nodeId"],"inst":w["runtime"]["viewer"]["instanceId"]},open(ST,"w"))
def cleanup():
    adm=login(*ADMIN); s=json.load(open(ST))
    try: req("POST",f"/workflows/{s['wf']}/stop?confirm=true",None,adm)
    except Exception as e: print(e)
    for _ in range(30):
        if req("GET",f"/workflows/{s['wf']}",None,adm)["status"]=="stopped": break
        time.sleep(1)
    req("DELETE",f"/workflows/{s['wf']}",None,adm); os.remove(ST); print("weg")
def run(dur,clients,tiles):
    s=json.load(open(ST)); adm=login(*ADMIN)
    opid=int(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),"../../.run/orchestrator.pid")).read())
    vpid=int(os.popen("pgrep -f 'omp-viewer' | head -1").read() or 0)
    lat=[];errs={};lk=threading.Lock();stop=time.time()+dur;size=[0]
    def tile():
        c=http.client.HTTPConnection("localhost",8000,timeout=30); time.sleep(random.random()*.5)
        while time.time()<stop:
            t=time.time()
            try:
                c.request("GET",f"/api/v1/nodes/{s['viewer']}/stream/previewUrl?t={t}",headers={"Authorization":"Bearer "+adm})
                r=c.getresponse(); b=r.read()
                if r.status!=200: raise Exception(r.status)
                with lk: lat.append(time.time()-t); size[0]=len(b)
            except Exception as e:
                with lk: errs[str(e)[:30]]=errs.get(str(e)[:30],0)+1
                c.close(); c=http.client.HTTPConnection("localhost",8000,timeout=30)
            time.sleep(max(0,.5-(time.time()-t)))
    ths=[threading.Thread(target=tile) for _ in range(clients*tiles)]
    o0=pidcpu(opid); v0=pidcpu(vpid) if vpid else 0; t0=time.time()
    for t in ths: t.start()
    for t in ths: t.join()
    el=time.time()-t0; lat.sort(); gen=time.process_time()/el*100
    if lat: print(f"{clients} Clients x {tiles} Kacheln = {clients*tiles} Poller, bild {size[0]}B: n={len(lat)} rps={len(lat)/el:.0f} p50={lat[len(lat)//2]*1000:.1f}ms p95={lat[int(len(lat)*.95)]*1000:.1f}ms max={lat[-1]*1000:.0f}ms orch-CPU={(pidcpu(opid)-o0)/el*100:.0f}% Generator-CPU={gen:.0f}% viewer-CPU={((pidcpu(vpid)-v0)/el*100 if vpid else -1):.0f}% fehler={errs}")
    else: print("keine Antworten",errs)
a=sys.argv[1:]
{"setup":setup,"cleanup":cleanup}.get(a[0],lambda:run(float(a[1]),int(a[2]),int(a[3]) if len(a)>3 else 4))()
