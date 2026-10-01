import json, urllib.request, time
import os
B=os.environ.get("MIXER_NODE","http://127.0.0.1:9791")
def call(m,body=None):
    r=urllib.request.Request(f"{B}/methods/{m}",data=json.dumps(body or {}).encode(),headers={"Content-Type":"application/json"},method="POST")
    try: return urllib.request.urlopen(r).status
    except Exception as e: return str(e)
def get(p): return json.load(urllib.request.urlopen(f"{B}/params/{p}"))["value"]
import sys
N=int(sys.argv[1]) if len(sys.argv)>1 else 8
names=["Host","Gast 1","Gast 2","Gast 3","Kommentator","Stadion","Musik","Remote"]+[f"Kanal {i}" for i in range(9,200)]
for i in range(N): call("addChannel",{"label":names[i]})
time.sleep(2.5)
ids=[c["id"] for c in get("channels")]
if N>=8:
    call("addGroup",{"label":"Studio Mics"}); call("addGroup",{"label":"Kommentar"}); call("addGroup",{"label":"Beds"})
    g=[x["id"] for x in get("groups")]
    for i in ids[:4]: call(f"channel.{i}.setGroup",{"groupId":g[0]}); call(f"channel.{i}.setAutoMix",{"enabled":True})
    call(f"channel.{ids[4]}.setGroup",{"groupId":g[1]})
    for i in ids[5:7]: call(f"channel.{i}.setGroup",{"groupId":g[2]})
    call(f"group.{g[0]}.setAutoMix",{"enabled":True,"detector":"rms"})
    call(f"channel.{ids[0]}.setAutoMix",{"priority":2})
    call("addDuck",{"label":"Kommentar → Beds"}); d=get("duckRules")[0]["id"]
    call(f"duck.{d}.set",{"enabled":True,"keys":ids[4],"targets":"group:"+g[2],"amountDb":-8,"detector":"rms"})
    call(f"channel.{ids[6]}.setMute",{"muted":True}); call(f"channel.{ids[7]}.setMainRoute",{"routed":False})
    call(f"channel.{ids[1]}.setGain",{"db":-7.3}); call(f"channel.{ids[5]}.setGain",{"db":-4})
    call(f"channel.{ids[2]}.setManual",{"manual":True})
    call(f"channel.{ids[6]}.setAutomation",{"enabled":True,"target":"StubPlayer","rules":json.dumps([{"trigger":"unmute","action":"play"},{"trigger":"mute","action":"pause"}])})
    call("addAux",{"label":"Monitor","kind":"aux"}); call("addAux",{"label":"N-1 Kommentator","kind":"n1"})
    a=[x["id"] for x in get("auxBuses") if x["active"]]
    call(f"aux.{a[1]}.setN1",{"exclude":ids[4]})
    call("captureScene",{"label":"Studio"}); call(f"channel.{ids[5]}.setGain",{"db":-12}); call("captureScene",{"label":"Football"})
    call("addContext",{"label":"Cam1","source":"cam1","scene":get("scenes")[0]["id"]})
print("seeded",len(ids))
