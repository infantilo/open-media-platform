#!/usr/bin/env python3
"""End-to-End-/Abnahmetest der Playout-Automation (Kapitel 27, Spec §210/§271).

Läuft gegen einen LAUFENDEN Gesamtstack (`make start`) und baut sich seine
Instanzen selbst auf (omp-source, 2× omp-channel-player, omp-video-mixer-me,
omp-ograf, 2× omp-playout-automation) und räumt sie wieder ab. Nur Standardbibliothek.

Szenario (Zeiten gekürzt auf Sekunden; kein Medienarchiv nötig):
  Channel „National“:   1 Clip (Testmuster) → 2 Live Remote (Quelle per Tags,
                        Audio „commentator“) → 3 Clip mit Child Events (Logo ganze
                        Dauer, Lower Third +1 s, Channel-Trigger HOLD an „Regional“)
                        → 4 Clip
  Channel „Regional“:   empfängt den Trigger (Regel „National darf Regional steuern“)

Geprüft: Reihenfolge/Endstatus im As-Run, aufgelöste Quelle, Child-Zeilen, Trigger
zugestellt UND ausgeführt, Bedienungseinträge mit Benutzername, Metriken.

  python3 tools/playout-e2e/e2e.py [--base http://localhost:8000] [--keep]
Exit 0 = alle Prüfungen bestanden.
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://localhost:8000")
ap.add_argument("--user", default="admin")
ap.add_argument("--password", default="adminpass123")
ap.add_argument("--keep", action="store_true", help="Instanzen/Channels am Ende nicht entfernen")
args = ap.parse_args()
BASE = args.base.rstrip("/")
TOKEN = ""
FAILS = []


def call(method, path, body=None, raw=False):
    req = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {TOKEN}"} if TOKEN else {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
            return data.decode() if raw else (json.loads(data) if data else None)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {path} → {e.code}: {e.read().decode()[:300]}")


def check(name, ok, detail=""):
    print(("  ✓ " if ok else "  ✗ ") + name + (f"  [{detail}]" if detail and not ok else ""))
    if not ok:
        FAILS.append(name)


def wait_for(fn, timeout, what):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(1)
    raise RuntimeError(f"Zeitüberschreitung: {what}")


TOKEN = call("POST", "/api/v1/auth/login", {"username": args.user, "password": args.password})["token"]
created_instances, created_channels, created_rules = [], [], []


def start(type_, label):
    inst = call("POST", "/api/v1/instances", {"type": type_, "label": label})
    created_instances.append(inst["id"])
    return inst["id"]


def node_by_label(label):
    for n in call("GET", "/api/v1/nodes"):
        if n["label"] == label and n.get("online"):
            return n
    return None


def method(node_id, name, body=None):
    return call("POST", f"/api/v1/nodes/{node_id}/methods/{name}", body or {})


def param(node_id, name):
    return call("GET", f"/api/v1/nodes/{node_id}/params/{name}")["value"]


def setparam(node_id, name, value):
    call("PATCH", f"/api/v1/nodes/{node_id}/params/{name}", {"value": value})


try:
    print("== Aufbau")
    inst_ids = {}
    for t, l in [("omp-source", "E2E Remote Feed X"), ("omp-channel-player", "E2E PlayerA"), ("omp-channel-player", "E2E PlayerB"),
                 ("omp-video-mixer-me", "E2E Mixer"), ("omp-ograf", "E2E Grafik"),
                 ("omp-playout-automation", "E2E National"), ("omp-playout-automation", "E2E Regional")]:
        inst_ids[l] = start(t, l)
    nodes = {}
    for l in inst_ids:
        nodes[l] = wait_for(lambda l=l: node_by_label(l), 90, f"Node {l} online")
    print("  Instanzen online:", ", ".join(nodes))

    # Quelle taggen: Video = Programm, Audio = Kommentar
    src = nodes["E2E Remote Feed X"]
    vs = [s for s in src["senders"] if s.get("format", "").endswith("video") and "Lowres" not in s["label"]][0]
    au = [s for s in src["senders"] if s.get("format", "").endswith("audio")][0]
    call("PUT", f"/api/v1/sources/{vs['id']}/tags", {"tags": ["role.program"]})
    call("PUT", f"/api/v1/sources/{au['id']}/tags", {"tags": ["role.commentator"]})

    # Channels + Regel
    nat_ch = call("POST", "/api/v1/playout/channels", {"name": "E2E National", "timezone": "Europe/Berlin", "instanceId": inst_ids["E2E National"], "config": {}})
    reg_ch = call("POST", "/api/v1/playout/channels", {"name": "E2E Regional", "timezone": "Europe/Berlin", "group": "e2e-regional", "instanceId": inst_ids["E2E Regional"], "config": {}})
    created_channels += [nat_ch["id"], reg_ch["id"]]
    rule = call("POST", "/api/v1/playout/trigger-rules", {"origin": f"channel:{nat_ch['id']}", "target": f"channel:{reg_ch['id']}"})
    created_rules.append(rule["id"])
    nat = nodes["E2E National"]["id"]
    reg = nodes["E2E Regional"]["id"]
    wait_for(lambda: param(nat, "channelId") == nat_ch["id"] and param(reg, "channelId") == reg_ch["id"], 60, "Channel-Bindung")
    for k, v in [("targetPlayerALabel", "E2E PlayerA"), ("targetPlayerBLabel", "E2E PlayerB"), ("targetMixerLabel", "E2E Mixer"), ("targetGraphicsLabel", "E2E Grafik")]:
        setparam(nat, k, v)
    time.sleep(3)

    print("== Playlist National")
    method(nat, "append", {"label": "Clip News", "pattern": "smpte", "durationMs": 4000})
    method(nat, "append", {"label": "Live Remote", "durationMs": 5000, "sourceSelectorJson": json.dumps({"mediaType": "video", "required": ["role.program"]})})
    method(nat, "append", {"label": "Clip mit Kindern", "pattern": "ball", "durationMs": 7000})
    method(nat, "append", {"label": "Clip Ende", "pattern": "snow", "durationMs": 3000})
    items = {i["label"]: i for i in param(nat, "items")}
    method(nat, "setAudio", {"itemId": items["Live Remote"]["id"], "audioJson": json.dumps({"capability": "commentator"})})
    children = [
        {"id": "logo", "type": "LOGO", "timing": "FULL_PRIMARY", "templateId": "top-left-digital-clock", "data": {}},
        {"id": "lt", "type": "GRAPHIC", "timing": "RELATIVE_TO_START", "delayMs": 1000, "durationMs": 3000, "templateId": "lower-third-material-design", "data": {"title": "E2E", "subtitle": "Lower Third"}},
        {"id": "trig", "type": "CHANNEL_TRIGGER", "timing": "RELATIVE_TO_START", "delayMs": 2000, "params": {"event": "CHANNEL_HOLD", "target": {"channel": reg_ch["id"]}}},
    ]
    method(nat, "setChildren", {"itemId": items["Clip mit Kindern"]["id"], "childrenJson": json.dumps(children)})
    items = {i["label"]: i for i in param(nat, "items")}
    live = items["Live Remote"]
    check("Live-Quelle per Tags aufgelöst", bool(live.get("resolvedSenderId")), json.dumps(live)[:200])
    check("Audio-Absicht „commentator“ gewählt", "commentator" in json.dumps(live.get("audio", {})), json.dumps(live.get("audio", {}))[:200])

    print("== Sendung (≈ 25 s)")
    t0 = time.time()
    method(nat, "take")
    def done():
        rows = call("GET", f"/api/v1/playout/channels/{nat_ch['id']}/as-run?limit=500")
        prim = {r["label"]: r for r in rows if r["kind"] == "primary"}
        return rows if prim.get("Clip Ende", {}).get("status") == "COMPLETED" else None
    rows = wait_for(done, 60, "alle Events beendet")
    print(f"  Sendung beendet nach {time.time() - t0:.0f} s")

    print("== Prüfungen")
    prim = sorted([r for r in rows if r["kind"] == "primary"], key=lambda r: r["actualStart"])
    check("4 Primary-Events im As-Run", len(prim) == 4, str([p["label"] for p in prim]))
    check("Reihenfolge wie Playlist", [p["label"] for p in prim] == ["Clip News", "Live Remote", "Clip mit Kindern", "Clip Ende"], str([p["label"] for p in prim]))
    check("alle COMPLETED", all(p["status"] == "COMPLETED" for p in prim), str([p["status"] for p in prim]))
    for p, planned in zip(prim, [4, 5, 7, 3]):
        d = (time.mktime(time.strptime(p["actualEnd"][:19], "%Y-%m-%dT%H:%M:%S")) - time.mktime(time.strptime(p["actualStart"][:19], "%Y-%m-%dT%H:%M:%S")))
        check(f"Dauer „{p['label']}“ ≈ {planned} s (±2)", abs(d - planned) <= 2, f"{d:.0f} s")
    kids = {r["childId"]: r for r in rows if r["kind"] == "child"}
    check("Child Logo gelaufen", kids.get("logo", {}).get("status") in ("COMPLETED", "ACTIVE", "FIRED"), str(kids.get("logo")))
    check("Child Lower Third gelaufen", kids.get("lt", {}).get("status") in ("COMPLETED", "ACTIVE", "FIRED"), str(kids.get("lt")))
    check("Child Channel-Trigger ausgelöst", kids.get("trig", {}).get("status") in ("COMPLETED", "FIRED", "ACTIVE"), str(kids.get("trig")))
    trig = [t for t in call("GET", "/api/v1/playout/triggers?limit=50") if t["targetChannel"] == reg_ch["id"] and t["event"] == "CHANNEL_HOLD"]
    check("Trigger an Regional zugestellt", bool(trig), "kein Trigger-Eintrag")
    check("Trigger von Regional ausgeführt (applied)", any(t["status"] == "applied" for t in trig), str([t["status"] for t in trig]))
    check("Regional steht auf Hold", param(reg, "mode") == "hold", param(reg, "mode"))
    ops = [r for r in rows if r["kind"] == "operator"]
    check("Bedienung mit Benutzername protokolliert", any(o.get("operator") == args.user and o.get("action") == "take" for o in ops), str(ops[:2]))
    csv = call("GET", f"/api/v1/playout/channels/{nat_ch['id']}/as-run?format=csv", raw=True)
    check("CSV-Export enthält alle Events", all(l in csv for l in ["Clip News", "Live Remote", "Clip mit Kindern", "Clip Ende"]))
    metrics = call("GET", "/metrics", raw=True)
    check("Kennzahl events_total für den Channel", f'omp_playout_events_total{{channel="{nat_ch["id"]}",status="COMPLETED"}} 4' in metrics)
finally:
    if not args.keep:
        print("== Aufräumen")
        for rid in created_rules:
            try: call("DELETE", f"/api/v1/playout/trigger-rules/{rid}")
            except Exception as e: print("  Regel:", e)
        for cid in created_channels:
            try: call("DELETE", f"/api/v1/playout/channels/{cid}")
            except Exception as e: print("  Channel:", e)
        for iid in created_instances:
            try: call("DELETE", f"/api/v1/instances/{iid}")
            except Exception as e: print("  Instanz:", e)

print("\nERGEBNIS:", "ALLE PRÜFUNGEN BESTANDEN" if not FAILS else f"{len(FAILS)} FEHLER: {FAILS}")
sys.exit(1 if FAILS else 0)
