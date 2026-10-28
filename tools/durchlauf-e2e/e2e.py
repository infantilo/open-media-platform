#!/usr/bin/env python3
"""Voll-Durchlauf (Kapitel 74): neue Datei → Eingang (automatische QC) → Freigabe → Playlist (zuerst „fehlt/gesperrt“)
→ Sendung → Secondary Record → Vergleich Original ↔ Aufnahme.

Läuft gegen einen LAUFENDEN Stack (`make start`). Legt einen dauerhaften Workflow „Durchlauf Playout“, den Channel
„Durchlauf“ und den Prozess „Durchlauf Eingang“ an und RÄUMT NICHTS AUF — alles bleibt für manuelles Testen stehen
(erneuter Lauf nutzt vorhandene Objekte). Nur Standardbibliothek + ffmpeg.

  python3 tools/durchlauf-e2e/e2e.py [--base http://localhost:8000] [--phase setup|run|all]
"""
import argparse, json, os, subprocess, sys, time, urllib.error, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://localhost:8000")
ap.add_argument("--user", default="admin")
ap.add_argument("--password", default="adminpass123")
ap.add_argument("--phase", default="all", choices=["setup", "run", "all"])
ap.add_argument("--media", default="data/media", help="Medienverzeichnis (= Importverzeichnis des Eingangs)")
args = ap.parse_args()
BASE = args.base.rstrip("/")
TOKEN, FAILS = "", []
WF_NAME, CH_NAME, PROC_NAME = "Durchlauf Playout", "Durchlauf", "Durchlauf Eingang"
NEW_FILE = "durchlauf_neu.mxf"


def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {TOKEN}"} if TOKEN else {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            d = r.read()
            return json.loads(d) if d else None
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {path} → {e.code}: {e.read().decode()[:300]}")


def check(name, ok, detail=""):
    print(("  ✓ " if ok else "  ✗ ") + name + (f"  [{detail}]" if detail else ""))
    if not ok:
        FAILS.append(name)


def wait_for(fn, timeout, what, step=1.0):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(step)
    raise RuntimeError(f"Zeitüberschreitung: {what}")


TOKEN = call("POST", "/api/v1/auth/login", {"username": args.user, "password": args.password})["token"]


def method(nid, name, body=None):
    return call("POST", f"/api/v1/nodes/{nid}/methods/{name}", body or {})


def param(nid, name):
    return call("GET", f"/api/v1/nodes/{nid}/params/{name}")["value"]


def setparam(nid, name, v):
    call("PATCH", f"/api/v1/nodes/{nid}/params/{name}", {"value": v})


def wf_list():
    d = call("GET", "/api/v1/workflows")
    return d if isinstance(d, list) else d.get("workflows", [])


def ffmpeg_clip(path, seconds, freq, label):
    """Kleiner MPEG-2-MXF-Clip mit Bild (Testbild + Laufzeit-Text) und Ton, wenig CPU."""
    cmd = ["nice", "-n", "15", "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-threads", "1",
           "-f", "lavfi", "-i", f"testsrc2=size=640x360:rate=25:duration={seconds},format=yuv422p",
           "-f", "lavfi", "-i", f"sine=frequency={freq}:sample_rate=48000:duration={seconds},volume=-23dB",
           "-t", str(seconds), "-c:v", "mpeg2video", "-pix_fmt", "yuv422p", "-b:v", "8M", "-g", "12", "-bf", "0",
           "-c:a", "pcm_s24le", "-timecode", "01:00:00:00", "-f", "mxf", path + ".tmp"]
    subprocess.run(cmd, check=True)
    os.replace(path + ".tmp", path)  # atomar: nie eine halbe Datei im Importverzeichnis


def setup():
    print("== Setup (bleibt bestehen)")
    # Prozess
    defs = call("GET", "/api/v1/process-definitions")
    defs = defs if isinstance(defs, list) else defs.get("definitions", defs.get("items", []))
    pd = next((d for d in defs if d["name"] == PROC_NAME), None)
    if not pd:
        pd = call("POST", "/api/v1/process-definitions", {"name": PROC_NAME, "category": "playout",
                  "description": "Neue Datei im Eingang: benachrichtigen, manuell kontrollieren (Segmente abstecken), freigeben, Playlist informieren."})
        ver = call("POST", f"/api/v1/process-definitions/{pd['id']}/versions", {
            "startStepId": "melden",
            "triggers": [{"subject": "omp.asset.*.registered"}],
            "steps": [
                {"id": "melden", "type": "notification", "name": "Neue Datei erkannt", "config": {"subject": "omp.durchlauf.neue-datei"}, "next": ["kontrolle"]},
                {"id": "kontrolle", "type": "human_task", "name": "Datei manuell kontrollieren, Segmente abstecken, freigeben",
                 "config": {"title": "Eingangskontrolle", "description": "QC-Bericht prüfen, im Review-Player Segmente abstecken und freigeben.", "priority": "normal"}, "next": ["freigegeben"]},
                {"id": "freigegeben", "type": "notification", "name": "Freigegeben", "config": {"subject": "omp.durchlauf.freigegeben"}},
            ]})
        try:
            call("POST", f"/api/v1/process-versions/{ver['id']}/publish")
        except RuntimeError as e:
            print("  (Veröffentlichen:", e, ")")
        print("  Prozess angelegt:", pd["id"])
    else:
        print("  Prozess vorhanden:", pd["id"])
    # Workflow
    wf = next((w for w in wf_list() if w["name"] == WF_NAME), None)
    if not wf:
        wf = call("POST", "/api/v1/workflows", {"name": WF_NAME, "definition": {
            "roles": [{"name": "Player A", "nodeType": "omp-channel-player"}, {"name": "Player B", "nodeType": "omp-channel-player"},
                      {"name": "Bildmischer", "nodeType": "omp-video-mixer-me"}, {"name": "Tonmischer", "nodeType": "omp-audio-mixer"},
                      {"name": "Recorder", "nodeType": "omp-recorder"},
                      {"name": "Playout-Automation", "nodeType": "omp-playout-automation"}],
            "connections": [{"fromRole": "Bildmischer", "toRole": "Recorder"}, {"fromRole": "Tonmischer", "toRole": "Recorder"}],
            "settings": {"programFormat": "720p25"}}})
        print("  Workflow angelegt:", wf["id"])
    else:
        roles = [r["name"] for r in wf["definition"].get("roles", [])]
        if "Tonmischer" not in roles:  # älterer Stand des Durchlauf-Workflows: Ton für die Aufnahme ergänzen
            if wf.get("status") not in ("stopped", None):
                call("POST", f"/api/v1/workflows/{wf['id']}/stop")
                time.sleep(5)
            d = wf["definition"]
            d["roles"].insert(3, {"name": "Tonmischer", "nodeType": "omp-audio-mixer"})
            d["connections"].append({"fromRole": "Tonmischer", "toRole": "Recorder"})
            wf = call("PUT", f"/api/v1/workflows/{wf['id']}", {"name": wf["name"], "definition": d})
            print("  Workflow um Tonmischer ergänzt")
        print("  Workflow vorhanden:", wf["id"])
    chs = call("GET", "/api/v1/playout/channels")
    ch = next((c for c in chs if c["name"] == CH_NAME), None)
    if not ch:
        ch = call("POST", "/api/v1/playout/channels", {"name": CH_NAME, "timezone": "Europe/Vienna", "workflowId": wf["id"], "role": "Playout-Automation", "config": {}})
        print("  Channel angelegt:", ch["id"])
    return wf, ch


def run(wf, ch):
    print("== Workflow starten")
    w = next(x for x in wf_list() if x["id"] == wf["id"])
    print("  Zustand:", w.get("status"))
    if (w.get("status") or "") == "stopped":
        call("POST", f"/api/v1/workflows/{wf['id']}/start")
    time.sleep(3)

    def nodes_of(typ):
        return [n for n in call("GET", "/api/v1/nodes") if n.get("online") and typ in json.dumps(n.get("tags", n)) ]
    # Automation-Node: der Node, dessen channelId zum Channel passt
    def find_auto():
        for n in call("GET", "/api/v1/nodes"):
            if not n.get("online"):
                continue
            try:
                if param(n["id"], "channelId") == ch["id"]:
                    return n
            except Exception:
                pass
    auto = wait_for(find_auto, 120, "Automation-Node des Channels online", 3)
    nid = auto["id"]
    print("  Automation:", auto["label"])
    # Ziele und Freigabe
    time.sleep(5)
    print("  Ziele:", [param(nid, k) for k in ("targetPlayerALabel", "targetPlayerBLabel", "targetMixerLabel")])
    setparam(nid, "requireRelease", True)

    print("== 1. Playlist: Event mit noch fehlender Datei")
    media = args.media
    os.makedirs(media, exist_ok=True)
    new_path = os.path.join(media, NEW_FILE)
    if os.path.exists(new_path):
        os.remove(new_path)  # Wiederholung: Datei kommt erneut „neu“ an
    method(nid, "load", {"itemsJson": "[]"})
    method(nid, "append", {"label": "Vorlauf Testbild", "pattern": "smpte", "durationMs": 4000})
    method(nid, "append", {"label": "Neue Datei (Freigabe verlangt)", "file": NEW_FILE, "durationMs": 6000})
    method(nid, "append", {"label": "Nachlauf Testbild", "pattern": "ball", "durationMs": 3000})
    items = {i["label"]: i for i in param(nid, "items")}
    it = items["Neue Datei (Freigabe verlangt)"]
    try:  # die Dateiliste des Players aktualisiert sich im Takt, eine zuvor gelöschte Datei verschwindet erst dann
        wait_for(lambda: next(i for i in param(nid, "items") if i["id"] == it["id"]).get("available") is False, 30, "Datei fehlt", 2)
    except RuntimeError:
        pass
    check("Event fehlt zunächst (nicht verfügbar)", next(i for i in param(nid, "items") if i["id"] == it["id"]).get("available") is False)
    try:
        wait_for(lambda: (next(i for i in param(nid, "items") if i["id"] == it["id"]).get("release") or {}).get("checkedMs"), 40, "Freigabe-Auskunft des Eingangs", 2)
    except RuntimeError as e:
        print("  ", e)
    cur = next(i for i in param(nid, "items") if i["id"] == it["id"])
    check("Freigabe verlangt und gesperrt (Datei nicht im Eingang)", cur["release"].get("blocked"), str(cur.get("release")))
    err = None
    try:
        method(nid, "cue", {"itemId": it["id"]})
    except RuntimeError as e:
        err = str(e)
    check("Cue/Take wird abgelehnt", err is not None, err or "")

    print("== 2. Datei kommt an → Eingang erkennt, QC läuft automatisch")
    ffmpeg_clip(new_path, 6, 440, "neu")
    imp = call("POST", "/api/v1/review/import", {"path": NEW_FILE, "title": "Durchlauf neue Datei"})
    aid = (imp.get("item") or imp).get("assetId") or imp.get("assetId")
    check("Datei im Eingang registriert", bool(aid), json.dumps(imp)[:200])

    def un(d):
        return d.get("item", d) if isinstance(d, dict) else d

    def item():
        return un(call("GET", f"/api/v1/review/items/{aid}"))
    wait_for(lambda: item().get("qcStatus") in ("pass", "warning", "fail"), 120, "QC fertig", 3)
    ri = item()
    print("  QC:", ri["qcStatus"], "Zustand:", ri["state"])
    check("QC lief automatisch", ri["qcStatus"] in ("pass", "warning", "fail"))

    print("== 3. Manuelle Kontrolle: Segment abstecken, einreichen, freigeben")
    ri = un(call("POST", f"/api/v1/review/items/{aid}/claim", {}))
    try:
        ri = item()
        tl = ri.get("timeline") or {}
        frames = tl.get("durationFrames") or 150
        print("  Zeitachse:", json.dumps(tl)[:160])
        call("PUT", f"/api/v1/review/items/{aid}/conform", {"expectedRevision": ri.get("revision", 0), "segments": [{"label": "Programm", "in": 0, "out": int(frames)}],
                                                                       "assetMetadata": {"title": "Durchlauf neue Datei", "source": "Durchlauf-Test"}})
        print("  Segment gesetzt")
    except RuntimeError as e:
        print("  (Conform:", e, ")")
    ri = item()
    for step in ("submit", "approve"):
        try:
            ri = un(call("POST", f"/api/v1/review/items/{aid}/{step}", {"expectedRevision": ri["revision"], "note": "Durchlauf-Test"}))
        except RuntimeError as e:
            print(f"  ({step}:", e, ")")
            ri = item()
    ri = item()
    check("Datei freigegeben (QC grün oder manuell genehmigt)", ri["state"] == "approved" or ri["qcStatus"] == "pass", f"{ri['state']}/{ri['qcStatus']}")

    print("== 4. Playlist: Event wird freigegeben und lief an")
    wait_for(lambda: next(i for i in param(nid, "items") if i["id"] == it["id"]).get("available"), 30, "Datei im Medienverzeichnis erkannt", 2)
    wait_for(lambda: not next(i for i in param(nid, "items") if i["id"] == it["id"]).get("release", {}).get("blocked"), 40, "Sperre aufgehoben", 2)
    check("Sperre aufgehoben, Event verfügbar", True)

    print("== 5. Sendung mit Secondary Record")
    rec = None
    for n in call("GET", "/api/v1/nodes"):
        if n.get("online") and "ecord" in n["label"]:
            rec = n
    if rec:
        check("Recorder online", True, rec["label"])
        rec_name = "durchlauf_record.mxf"
        rp = os.path.join(os.path.dirname(os.path.normpath(media)), rec_name)  # der Recorder schreibt nach data/
        for q in (rp, os.path.join(media, rec_name)):
            if os.path.exists(q):
                os.remove(q)
        children = [{"id": "rec", "type": "NODE_COMMAND", "timing": "RELATIVE_TO_START", "delayMs": 500, "target": rec["label"],
                     "method": "record.start", "params": {"fileName": rec_name}, "stopMethod": "record.stop", "stopParams": {}}]
        try:
            method(nid, "setChildren", {"itemId": it["id"], "childrenJson": json.dumps(children)})
        except RuntimeError as e:
            print("  (setChildren:", e, ")")
    method(nid, "cue", {"itemId": it["id"]})
    method(nid, "take", {})
    time.sleep(9)
    st = [i for i in param(nid, "items") if i["id"] == it["id"]][0]
    print("  Event-Zustand:", st.get("state") or st.get("status"))
    method(nid, "stop", {})

    if rec:
        print("== 6. Vergleich Original ↔ Aufnahme")
        rp = os.path.join(os.path.dirname(os.path.normpath(media)), "durchlauf_record.mxf")
        wait_for(lambda: os.path.exists(rp) and os.path.getsize(rp) > 0, 30, "Aufnahmedatei", 2)
        time.sleep(3)  # Recorder hat gestoppt und fertig geschrieben
        os.replace(rp, os.path.join(media, "durchlauf_record.mxf"))  # ins Importverzeichnis des Eingangs
        imp2 = call("POST", "/api/v1/review/import", {"path": "durchlauf_record.mxf", "title": "Durchlauf Aufnahme"})
        aid2 = (imp2.get("item") or imp2).get("assetId") or imp2.get("assetId")
        rep = call("POST", f"/api/v1/review/items/{aid}/compare", {"recordedAssetId": aid2, "options": {"durationTolMs": 1500, "ssimMin": 0.9, "offsetSec": 0.5}})
        for c in rep["checks"]:
            print(f"  {c['status']:7} {c['label']}: {c.get('original','')} ↔ {c.get('recorded','')}  {c['message']}")
        check("Vergleich erstellt", rep["overall"] in ("pass", "warning", "fail"), rep["overall"])
    print("\nErgebnis:", "ALLES BESTANDEN" if not FAILS else f"{len(FAILS)} Prüfung(en) fehlgeschlagen: {FAILS}")
    return not FAILS


wf = ch = None
if args.phase in ("setup", "all"):
    wf, ch = setup()
if args.phase in ("run", "all"):
    if wf is None:
        wf = next(w for w in wf_list() if w["name"] == WF_NAME)
        ch = next(c for c in call("GET", "/api/v1/playout/channels") if c["name"] == CH_NAME)
    sys.exit(0 if run(wf, ch) else 1)
