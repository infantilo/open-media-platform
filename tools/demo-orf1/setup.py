#!/usr/bin/env python3
"""Demo: kompletter Playout-Workflow für den Kanal „ORF1“.

Legt an (gegen einen LAUFENDEN Stack, nur Standardbibliothek):
  Workflow „ORF1 Playout“  Live-Quelle · Kanal-Player A/B · Bildmischer · Tonmischer · Grafik ·
                           Audio-Monitor · Viewer · Playout-Automation   (720p25, Bildmischer → Viewer)
  Channel „ORF1“           an die Automation-Rolle gebunden (Playlist bleibt über Neustarts erhalten)
  Playlist                 Sendungskennung → MXF-Clip → Live-Schalte (Lower Third) → Werbeblock → Trailer
Mit --start wird der Workflow gestartet und die Playlist befüllt; ohne --start nur angelegt.
Gesendet wird erst mit TAKE (Operator-Konsole / Panel der Automation).

  python3 tools/demo-orf1/setup.py [--base http://localhost:8000] [--start] [--recreate]
"""
import argparse, json, sys, time, urllib.error, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://localhost:8000")
ap.add_argument("--user", default="admin")
ap.add_argument("--password", default="adminpass123")
ap.add_argument("--start", action="store_true")
ap.add_argument("--recreate", action="store_true", help="vorhandenen Workflow/Channel „ORF1“ vorher löschen")
a = ap.parse_args()
BASE, TOKEN = a.base.rstrip("/"), ""
WF_NAME, CH_NAME, AUTO = "ORF1 Playout", "ORF1", "Playout-Automation"


def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {TOKEN}"} if TOKEN else {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            d = r.read()
            return json.loads(d) if d else None
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path} → {e.code}: {e.read().decode()[:300]}")


def wait_for(fn, timeout, what):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(1)
    raise SystemExit(f"Zeitüberschreitung: {what}")


TOKEN = call("POST", "/api/v1/auth/login", {"username": a.user, "password": a.password})["token"]

if a.recreate:
    for c in call("GET", "/api/v1/playout/channels"):
        if c["name"] == CH_NAME:
            call("DELETE", f"/api/v1/playout/channels/{c['id']}")
    for w in call("GET", "/api/v1/workflows"):
        if w["name"] == WF_NAME:
            if w["status"] != "stopped":
                call("POST", f"/api/v1/workflows/{w['id']}/stop?confirm=true")
                wait_for(lambda: call("GET", f"/api/v1/workflows/{w['id']}")["status"] == "stopped", 120, "Workflow gestoppt")
            call("DELETE", f"/api/v1/workflows/{w['id']}")
if any(w["name"] == WF_NAME for w in call("GET", "/api/v1/workflows")):
    raise SystemExit(f"Workflow „{WF_NAME}“ existiert schon (--recreate zum Ersetzen)")

roles = [{"name": n, "nodeType": t} for n, t in [
    ("Live-Quelle", "omp-source"), ("Player A", "omp-channel-player"), ("Player B", "omp-channel-player"),
    ("Bildmischer", "omp-video-mixer-me"), ("Tonmischer", "omp-audio-mixer"), ("Grafik", "omp-ograf"),
    ("Audio-Monitor", "omp-audio-monitor"), ("Viewer", "omp-viewer"), (AUTO, "omp-playout-automation")]]
wf = call("POST", "/api/v1/workflows", {"name": WF_NAME, "definition": {
    "roles": roles, "connections": [{"fromRole": "Bildmischer", "toRole": "Viewer"}],
    "settings": {"programFormat": "720p25"}}})
ch = call("POST", "/api/v1/playout/channels", {"name": CH_NAME, "timezone": "Europe/Vienna", "workflowId": wf["id"], "role": AUTO, "config": {}})
print(f"Workflow {wf['id']} und Channel „{CH_NAME}“ angelegt.")
if not a.start:
    sys.exit(0)

call("POST", f"/api/v1/workflows/{wf['id']}/start")
rt = wait_for(lambda: (lambda w: w["status"] == "started" and all(r in w["runtime"] and w["runtime"][r].get("nodeId") for r in [x["name"] for x in roles]) and w["runtime"])(
    call("GET", f"/api/v1/workflows/{wf['id']}")), 180, "Workflow gestartet")
online = lambda nid: next((n for n in call("GET", "/api/v1/nodes") if n["id"] == nid and n.get("online")), None)
auto = wait_for(lambda: online(rt[AUTO]["nodeId"]), 90, "Automation online")
src = wait_for(lambda: online(rt["Live-Quelle"]["nodeId"]), 90, "Live-Quelle online")
vs = [s for s in src["senders"] if s.get("format", "").endswith("video") and "Lowres" not in s["label"]][0]
call("PUT", f"/api/v1/sources/{vs['id']}/tags", {"tags": ["source.live"]})

nid = auto["id"]
m = lambda name, body: call("POST", f"/api/v1/nodes/{nid}/methods/{name}", body)
wait_for(lambda: call("GET", f"/api/v1/nodes/{nid}/params/channelId")["value"] == ch["id"], 60, "Channel-Bindung")
time.sleep(3)
for lbl, kw in [("Sendungskennung", {"pattern": "smpte", "durationMs": 6000}),
                ("Magazin (MXF-Clip)", {"file": "ORF-Demo-12ch.mxf", "durationMs": 10000}),
                ("Live-Schalte", {"durationMs": 8000, "sourceSelectorJson": json.dumps({"mediaType": "video", "required": ["source.live"]})}),
                ("Werbeblock 1", {"file": "test-smpte-5s.mp4", "durationMs": 5000}),
                ("Werbeblock 2", {"pattern": "ball", "durationMs": 5000}),
                ("Trailer", {"pattern": "snow", "durationMs": 4000})]:
    m("append", {"label": lbl, **kw})
items = {i["label"]: i for i in call("GET", f"/api/v1/nodes/{nid}/params/items")["value"]}
m("setChildren", {"itemId": items["Sendungskennung"]["id"], "childrenJson": json.dumps([
    {"id": "logo", "type": "LOGO", "timing": "FULL_PRIMARY", "templateId": "top-left-digital-clock", "data": {}}])})
m("setChildren", {"itemId": items["Live-Schalte"]["id"], "childrenJson": json.dumps([
    {"id": "lt", "type": "GRAPHIC", "timing": "RELATIVE_TO_START", "delayMs": 1000, "durationMs": 5000,
     "templateId": "lower-third-material-design", "data": {"title": "ORF1 Live", "subtitle": "Schalte ins Studio"}}])})
# ORF-Audioprogrammgruppen: Stereo PT (1-2), 5.1 PT (3-8), Stereo OT (9-10), Stereo AD (11-12)
m("updateItem", {"itemId": items["Magazin (MXF-Clip)"]["id"], "patchJson": json.dumps({"audioMapping": "orf-komplett"})})
m("setTransition", {"itemId": items["Magazin (MXF-Clip)"]["id"], "transition": "mix", "transitionRateFrames": 12})
m("setTransition", {"itemId": items["Werbeblock 1"]["id"], "transition": "vfade", "transitionRateFrames": 25})
# Tonmischer: je ORF-Programmgruppe ein Ausgang (Gruppen-Bus = eigener MXL-Sender) + je Gruppe und
# Player ein Kanalzug (Quelle = Gruppen-Sender des Players, folgt dem Bild: nur der Player im Programm
# ist hörbar). Kanäle gehen NICHT auf den Master, sondern nur auf ihren Ausgang.
GROUPS = [("pt", "stereo", 2, "role.pt"), ("surround51", "5.1", 6, "role.pt51"), ("ot", "stereo", 2, "role.ot"), ("ad", "stereo", 2, "role.ad")]
mx = rt["Tonmischer"]["nodeId"]
mm = lambda name, body: call("POST", f"/api/v1/nodes/{mx}/methods/{name}", body)
mparam = lambda name: call("GET", f"/api/v1/nodes/{mx}/params/{name}")["value"]
wait_for(lambda: online(mx), 90, "Tonmischer online")
labels = {g["id"]: g["label"] for g in call("GET", "/api/v1/audio-rules")["outputProfile"]["groups"]}
buses = {}
for gid, layout, chs, tag in GROUPS:
    mm("addAux", {"kind": "group", "group": gid, "layout": layout, "channels": chs, "label": labels[gid]})
mixstate = lambda: (lambda v: json.loads(v) if isinstance(v, str) else v)(mparam("mixState"))
auxes = lambda: mparam("auxBuses") if not isinstance(mparam("auxBuses"), str) else json.loads(mparam("auxBuses"))
for gid, *_ in GROUPS:
    buses[gid] = next(x["id"] for x in auxes() if x.get("group") == gid and x.get("active", True))
for pl in ("Player A", "Player B"):
    pn = wait_for(lambda pl=pl: online(rt[pl]["nodeId"]), 90, pl + " online")
    for gid, layout, chs, tag in GROUPS:
        snd = wait_for(lambda pn=pn, tag=tag: next((x for x in (online(pn["id"]) or {"senders": []})["senders"] if tag in x.get("discovered_tags", [])), None), 60, f"{pl} {tag}")
        before = {c["id"] for c in mixstate()["channels"]}
        mm("addChannel", {"label": f"{labels[gid]} {pl[-1]}"})
        cid = next(c["id"] for c in mixstate()["channels"] if c["id"] not in before)
        mm(f"channel.{cid}.setSource", {"senderId": snd["id"]})
        mm(f"channel.{cid}.setMainRoute", {"routed": False})
        mm(f"channel.{cid}.setSend", {"auxId": buses[gid], "enabled": True, "levelDb": 0, "post": True})
        mm(f"channel.{cid}.setFollow", {"targetNodeId": pn["id"], "mode": "cut"})
print("Playlist:", [i["label"] for i in call("GET", f"/api/v1/nodes/{nid}/params/items")["value"]])
print("Bereit. Senden: TAKE im Panel der Automation (Node „%s“) bzw. Operator-Konsole; Bild im Viewer." % auto["label"])
