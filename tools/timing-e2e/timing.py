#!/usr/bin/env python3
"""Event-Timing-Test (Kapitel 74/27): Kind-Events ABSOLUTE, RELATIVE_TO_START, RELATIVE_TO_END, FULL_PRIMARY sowie
manueller Take und fester Start (fixtime). Soll gegen Ist aus dem As-Run-Protokoll des Orchestrators.

Läuft gegen einen LAUFENDEN Stack mit gestartetem Workflow „Durchlauf Playout“ (tools/durchlauf-e2e/e2e.py legt ihn an).
Als Sonde dient die harmlose Methode `monitor.resetCountersAndMessages` des Recorders. Die Test-Events werden am Ende
wieder aus der Playlist entfernt. Nur Standardbibliothek.

  python3 tools/timing-e2e/timing.py [--base http://localhost:8000] [--tol-ms 400]
"""
import argparse, datetime as dt, json, sys, time, urllib.error, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://localhost:8000")
ap.add_argument("--user", default="admin")
ap.add_argument("--password", default="adminpass123")
ap.add_argument("--tol-ms", type=int, default=400, help="erlaubte Abweichung Soll/Ist je Zeitpunkt")
ap.add_argument("--channel", default="Durchlauf")
ap.add_argument("--automation", default="Playout-Automation")
ap.add_argument("--probe-target", default="Recorder")
args = ap.parse_args()
BASE, FAILS, TOKEN = args.base.rstrip("/"), [], ""
PROBE = "monitor.resetCountersAndMessages"


def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {TOKEN}"} if TOKEN else {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            d = r.read()
            return json.loads(d) if d else None
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {path} → {e.code}: {e.read().decode()[:300]}")


def parse(ts):
    return dt.datetime.fromisoformat(ts).timestamp() * 1000


def check(name, ok, info=""):
    print(f"  {'✓' if ok else '✗'} {name}  {info}")
    if not ok:
        FAILS.append(name)


TOKEN = call("POST", "/api/v1/auth/login", {"username": args.user, "password": args.password})["token"]
nodes = call("GET", "/api/v1/nodes")
nodes = nodes if isinstance(nodes, list) else nodes.get("nodes", [])
auto = next(n["id"] for n in nodes if n["label"] == args.automation)
chans = call("GET", "/api/v1/playout/channels")
chans = chans if isinstance(chans, list) else chans.get("channels", [])
ch = next(c["id"] for c in chans if c["name"] == args.channel)


def method(name, body=None):
    return call("POST", f"/api/v1/nodes/{auto}/methods/{name}", body or {})


def items():
    return call("GET", f"/api/v1/nodes/{auto}/params/items")["value"]


def child(cid, timing, delay=0, dur=0, **extra):
    return {"id": cid, "type": "NODE_COMMAND", "target": args.probe_target, "method": PROBE, "stopMethod": PROBE, "params": {}, "stopParams": {},
            "timing": timing, "delayMs": delay, "durationMs": dur, "failurePolicy": "WARN", "required": False, "retryCount": 0, "retryDelayMs": 1000, **extra}


def asrun(kind):
    return call("GET", f"/api/v1/playout/channels/{ch}/as-run?kind={kind}&limit=200")


def wait_items(pred, timeout, what):
    end = time.time() + timeout
    while time.time() < end:
        v = pred()
        if v:
            return v
        time.sleep(0.25)
    raise RuntimeError(f"Zeitüberschreitung: {what}")


before = {i["id"] for i in items()}
added = []
try:
    print("== Test-Events anlegen")
    method("append", {"label": "TIMING Probe", "pattern": "smpte", "durationMs": 12000})
    probe = next(i for i in items() if i["id"] not in before and i["label"] == "TIMING Probe")["id"]
    added.append(probe)
    now = time.time()
    abs_at = dt.datetime.fromtimestamp(now + 9, dt.timezone.utc).astimezone()
    abs_iso = abs_at.isoformat(timespec="milliseconds")
    kids = [
        child("c_start", "RELATIVE_TO_START", 2000, 3000),
        child("c_end", "RELATIVE_TO_END", 4000, 0),
        child("c_full", "FULL_PRIMARY"),
        child("c_abs", "ABSOLUTE", 0, 2000, atUtc=abs_iso),
    ]
    method("updateItem", {"itemId": probe, "patchJson": json.dumps({"children": kids})})
    # Fester Start: Folge-Event mit fixtime, ca. 8 s nach dem Ende des Probe-Events
    fix_at = dt.datetime.fromtimestamp(now + 3 + 12 + 8, dt.timezone.utc).astimezone()
    method("append", {"label": "TIMING Fix", "pattern": "smpte", "durationMs": 3000})
    fix = next(i for i in items() if i["id"] not in before and i["label"] == "TIMING Fix")["id"]
    added.append(fix)
    method("updateItem", {"itemId": fix, "patchJson": json.dumps({"startType": "fixtime", "fixtimeHms": fix_at.strftime("%H:%M:%S")})})

    print("== Manueller Take")
    method("cue", {"itemId": probe})
    time.sleep(3 - (time.time() - now))
    t_take = time.time() * 1000
    method("take")
    wait_items(lambda: next((r for r in asrun("child") if r.get("eventId") == probe and r.get("childId") == "c_full" and r.get("actualStart")), None), 15, "c_full gestartet")
    # Primary-Ende + Nachlauf des Fix-Events abwarten
    wait_items(lambda: next((r for r in asrun("primary") if r.get("eventId") == fix and r.get("actualStart")), None), 60, "Fix-Event gestartet")
    time.sleep(4.5)

    recs = {}
    for r in asrun("child"):
        if r.get("eventId") == probe:
            m = recs.setdefault(r["childId"], {})
            m.update({k: v for k, v in r.items() if v not in (None, "")})
    ev = {r["eventId"]: r for r in asrun("primary")}
    p_start = parse(ev[probe]["actualStart"]) if probe in ev else t_take
    print(f"  Primary-Start {p_start - t_take:+.0f} ms nach take()-Aufruf")
    check("Manueller Take: Primary beginnt sofort", abs(p_start - t_take) <= 1500, f"{p_start - t_take:+.0f} ms")
    p_end = parse(ev[probe]["actualEnd"]) if probe in ev and ev[probe].get("actualEnd") else p_start + 12000

    def expect(cid, start_off, end_off, label):
        r = recs.get(cid)
        if not r or not r.get("actualStart"):
            check(f"{label}: gestartet", False, "kein As-Run-Eintrag")
            return
        s = parse(r["actualStart"]) - p_start
        e = parse(r["actualEnd"]) - p_start if r.get("actualEnd") else None
        check(f"{label}: Start bei +{start_off} ms", abs(s - start_off) <= args.tol_ms, f"Ist {s:+.0f} ms")
        if end_off is None:
            return
        check(f"{label}: Ende bei +{end_off} ms", e is not None and abs(e - end_off) <= args.tol_ms, f"Ist {e if e is None else round(e):+} ms")

    print("== Kind-Events")
    prim = p_end - p_start
    expect("c_start", 2000, 5000, "RELATIVE_TO_START (2 s, Dauer 3 s)")
    expect("c_end", 8000, round(prim), "RELATIVE_TO_END (4 s vor Ende)")
    expect("c_full", 0, round(prim), "FULL_PRIMARY")
    r = recs.get("c_abs")
    if r and r.get("actualStart"):
        s = parse(r["actualStart"])
        check("ABSOLUTE: Start zur festen Uhrzeit", abs(s - abs_at.timestamp() * 1000) <= args.tol_ms, f"Ist {s - abs_at.timestamp() * 1000:+.0f} ms gegen atUtc")
        e = parse(r["actualEnd"]) if r.get("actualEnd") else None
        check("ABSOLUTE: Dauer 2 s", e is not None and abs((e - s) - 2000) <= args.tol_ms, f"Ist {None if e is None else round(e - s)} ms")
    else:
        check("ABSOLUTE: gestartet", False, "kein As-Run-Eintrag")

    print("== Fester Start (fixtime)")
    if fix in ev and ev[fix].get("actualStart"):
        s = parse(ev[fix]["actualStart"])
        # fixtimeHms hat Sekunden-Auflösung: Soll = volle Sekunde; der Schnitt muss auf der Bildgrenze liegen (±½ Bild bei 25 fps)
        want = fix_at.replace(microsecond=0).timestamp() * 1000
        check("Fester Start bildgenau zur eingestellten Uhrzeit", abs(s - want) <= 20, f"Ist {s - want:+.0f} ms gegen {fix_at.strftime('%H:%M:%S')}")
    else:
        check("Fester Start: Event lief an", False, "kein As-Run-Eintrag")
finally:
    try:
        method("stop")
    except Exception:
        pass
    for i in added:
        try:
            method("remove", {"itemId": i})
        except Exception as e:
            print(f"  Aufräumen {i}: {e}")
    print("  Test-Events entfernt")

print("\nErgebnis:", "ALLES BESTANDEN" if not FAILS else f"{len(FAILS)} FEHLER: {FAILS}")
sys.exit(1 if FAILS else 0)
