#!/usr/bin/env python3
"""Messung Kapitel 109 Stufe B: Redundanz-Umschalter (omp-failover, Profil "redundancy") mit zwei Testquellen als Stand-in für
aktiven und Standby-Mischer. Startet zwei omp-source (Label "FO A"/"FO B", klein 640x360, am Ende gelöscht) über die API, verbindet
A -> "Hauptsignal Bild", B -> "Notquelle 1 Bild" des bereits laufenden Umschalters (Label "FO Switch", eigener Prozess mit
OMP_FAILOVER_VIDEO=1 OMP_FAILOVER_PROFILE=redundancy), beendet Quelle A hart (SIGKILL) und misst:
  - Zeit von SIGKILL bis zur Umschaltung (Ereignisprotokoll des Umschalters, Wanduhr in ms),
  - wiederholte Bilder am Ausgang (videoOut.repeats) = tatsächlich verlorene Bilder.
Kurz und klein: nice, ein Lauf ~15 s. Nur Standardbibliothek.   python3 tools/failover-live/measure.py [--runs 3]
"""
import argparse, json, os, signal, time, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://localhost:8000")
ap.add_argument("--user", default="admin")
ap.add_argument("--password", default="adminpass123")
ap.add_argument("--runs", type=int, default=3)
args = ap.parse_args()


def call(method, url, body=None, token=None):
    req = urllib.request.Request(url, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})})
    with urllib.request.urlopen(req, timeout=30) as r:
        d = r.read()
        return json.loads(d) if d else None


tok = call("POST", f"{args.base}/api/v1/auth/login", {"username": args.user, "password": args.password})["token"]
api = lambda m, p, b=None: call(m, f"{args.base}{p}", b, tok)


def nodes():
    n = api("GET", "/api/v1/nodes")
    return n if isinstance(n, list) else n.get("nodes", [])


def node(label):
    return next((n for n in nodes() if n["label"] == label and n.get("online")), None)


def wait(fn, what, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(0.5)
    raise RuntimeError(f"Zeitüberschreitung: {what}")


def param(n, name):
    v = api("GET", f"/api/v1/nodes/{n['id']}/params/{name}")
    return v.get("value", v) if isinstance(v, dict) else v


created = []
try:
    sw = wait(lambda: node("FO Switch"), "Umschalter online")
    for run in range(1, args.runs + 1):
        pids = {}
        for l in (f"FO A{run}", f"FO B{run}"):  # eindeutige Labels: ein gelöschter Node steht noch kurz in der Liste
            r = api("POST", "/api/v1/instances", {"type": "omp-source", "label": l, "options": {"OMP_WIDTH": "640", "OMP_HEIGHT": "360"}})
            created.append(r["id"])
            pids[l] = r["pid"]
        a = wait(lambda: node(f"FO A{run}"), "Quelle A")
        b = wait(lambda: node(f"FO B{run}"), "Quelle B")
        sw = node("FO Switch")
        vsend = lambda n: next(s for s in n["senders"] if s["format"].endswith("video"))
        vrecv = lambda lab: next(r for r in sw["receivers"] if r["label"] == lab)
        api("POST", "/api/v1/graph/edges", {"from": vsend(a)["id"], "to": vrecv("Hauptsignal Bild")["id"]})
        api("POST", "/api/v1/graph/edges", {"from": vsend(b)["id"], "to": vrecv("Notquelle 1 Bild")["id"]})
        time.sleep(3)  # beide gesund (healthyMs 200)
        api("POST", f"/api/v1/nodes/{sw['id']}/methods/select", {"source": "main"})  # Ausgangslage: Hauptsignal aktiv
        api("POST", f"/api/v1/nodes/{sw['id']}/methods/auto", {})
        time.sleep(1)
        assert param(sw, "active") == "main", f"aktiv: {param(sw, 'active')}, Quellen: {[(x.get('id'), x.get('state'), x.get('cause')) for x in json.loads(param(sw, 'sources'))[:2]]}"
        pre = [(x.get("id"), x.get("state"), x.get("okMs")) for x in json.loads(param(sw, "sources"))[:2]]
        out0 = json.loads(param(sw, "videoOut"))
        t_kill = time.time()
        os.kill(pids[f"FO A{run}"], signal.SIGKILL)
        t_seen = None
        while time.time() - t_kill < 5:
            if param(sw, "active") == "n1":
                t_seen = time.time()
                break
            time.sleep(0.01)
        time.sleep(1)
        out1 = json.loads(param(sw, "videoOut"))
        ev = json.loads(param(sw, "events"))
        print("   Quellen vor dem Ausfall (id, Zustand, okMs):", pre)
        print(f"== Lauf {run}: Umschaltung erkannt nach {int((t_seen - t_kill) * 1000) if t_seen else 'NIE'} ms (Abfrage-Abstand ~10 ms + HTTP); "
              f"Ausgangsbilder {out1['frames'] - out0['frames']}, davon wiederholt {out1['repeats'] - out0['repeats']}")
        for e in ev[:3]:
            print("   Ereignis:", e)
        # aufräumen für den nächsten Lauf; Umschalter zurück auf Hauptsignal
        for i in created:
            try:
                api("DELETE", f"/api/v1/instances/{i}")
            except Exception as e:
                print("Aufräumen:", e)
        created.clear()
finally:
    for i in created:
        try:
            api("DELETE", f"/api/v1/instances/{i}")
        except Exception as e:
            print("Aufräumen:", e)
