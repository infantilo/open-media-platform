#!/usr/bin/env python3
"""Live-Prüfung Kapitel 109 A–C mit ECHTEN Bildmischern (omp-video-mixer-me) und CPU-Messung des Standby. [--cold: kalter Standby als Vergleich]. (Ableitung von workflow.py; Beschreibung dort:) Live-Prüfung im vollen Workflow (Orchestrator mit neuem Code nötig). Rollen: p (omp-source, Primär), s (omp-source,
Live-Standby von p), sel (omp-failover, Profil redundancy). Prüft: Start verdrahtet p->sel(Hauptsignal) und s->sel(Notquelle 1); Befehl an p
(Parameter pattern) wird auf s gespiegelt; harter Kill von p -> Umschalter schaltet auf s, Orchestrator übernimmt (Trigger first-exit),
Rolle p zeigt auf die Standby-Instanz, Zustand bleibt. Der Workflow wird am Ende gestoppt und gelöscht. Nur Standardbibliothek."""
import argparse, json, os, signal, time, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://localhost:8000")
ap.add_argument("--user", default="admin")
ap.add_argument("--password", default="adminpass123")
ap.add_argument("--cold", action="store_true")
ap.add_argument("--kill", action="store_true", help="danach Primär hart beenden und Umschaltung messen")
args = ap.parse_args()


def call(method, url, body=None, token=None):
    req = urllib.request.Request(url, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = r.read()
        return json.loads(d) if d else None


tok = call("POST", f"{args.base}/api/v1/auth/login", {"username": args.user, "password": args.password})["token"]
api = lambda m, p, b=None: call(m, f"{args.base}{p}", b, tok)


def wait(fn, what, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        try:
            v = fn()
        except Exception:
            v = None
        if v:
            return v
        time.sleep(0.3)
    raise RuntimeError(f"Zeitüberschreitung: {what}")


def pid_of_instance(instance_id):
    for d in os.listdir("/proc"):
        if d.isdigit():
            try:
                if f"OMP_INSTANCE_ID={instance_id}".encode() in open(f"/proc/{d}/environ", "rb").read().split(b"\0"):
                    return int(d)
            except OSError:
                pass
    return None


fmt = "480p25"
definition = {
    "roles": [
        {"name": "src", "nodeType": "omp-source", "format": fmt},
        {"name": "p", "nodeType": "omp-video-mixer-me", "format": fmt},
        {"name": "s", "nodeType": "omp-video-mixer-me", "standbyFor": "p", "standbyLive": not args.cold, "format": fmt},
        {"name": "sel", "nodeType": "omp-failover", "env": {"OMP_FAILOVER_VIDEO": "1", "OMP_FAILOVER_WIDTH": "848", "OMP_FAILOVER_HEIGHT": "480",
                                                              "OMP_FAILOVER_FPS": "25", "OMP_FAILOVER_PROFILE": "redundancy"}},
    ],
    "connections": [
        {"fromRole": "src", "toRole": "p"},
        {"fromRole": "p", "fromSender": "PGM", "toRole": "sel", "toReceiver": "Hauptsignal Bild"},
        {"fromRole": "s", "fromSender": "PGM", "toRole": "sel", "toReceiver": "Notquelle 1 Bild"},
    ],
}
wf = api("POST", "/api/v1/workflows", {"name": "FO Live-Test 109", "definition": definition})
wid = wf["id"]
try:
    api("POST", f"/api/v1/workflows/{wid}/start")
    wf = wait(lambda: (lambda w: w if w["status"] == "started" else None)(api("GET", f"/api/v1/workflows/{wid}")), "Workflow gestartet", 120)
    rt = wf["runtime"]
    print("Start ok; Instanzen:", {r: v["instanceId"][:8] for r, v in rt.items()})
    nodes = {n["id"]: n for n in api("GET", "/api/v1/nodes")}
    sel = nodes[rt["sel"]["nodeId"]]
    param = lambda n, name: api("GET", f"/api/v1/nodes/{n['id']}/params/{name}").get("value")
    state = lambda n: api("GET", f"/api/v1/nodes/{n['id']}/state").get("state")
    time.sleep(5)
    srcs = json.loads(param(sel, "sources"))
    print("Umschalter-Quellen:", [(x["id"], x["state"]) for x in srcs[:2]])
    p_node, s_node, src_node = nodes[rt["p"]["nodeId"]], nodes[rt["s"]["nodeId"]], nodes[rt["src"]["nodeId"]]

    # C: Bedienbefehl am Primär (Quelle auf PGM nehmen) — der Standby muss folgen
    st0 = json.dumps(state(p_node), sort_keys=True)
    vs = next(x for x in src_node["senders"] if x["format"].endswith("video"))
    api("POST", f"/api/v1/nodes/{p_node['id']}/methods/crosspoint.take", {"senderId": vs["id"]})
    time.sleep(2)
    sp, ss = state(p_node), state(s_node)
    same = json.dumps(sp, sort_keys=True) == json.dumps(ss, sort_keys=True)
    diff = [k for k in set(sp) | set(ss) if json.dumps(sp.get(k), sort_keys=True) != json.dumps(ss.get(k), sort_keys=True)] if isinstance(sp, dict) and isinstance(ss, dict) else "?"
    print(f"C    Zustand Primär == Standby nach crosspoint.take: {same} (Zustand hat sich durch den Befehl geändert: {json.dumps(sp, sort_keys=True) != st0})" + ("" if same else f" (abweichende Felder: {diff})"))

    # C (eindeutig): ein Befehl, der den Zustand wirklich ändert — Keyer einschalten, nur am Primär abgesetzt
    st1 = json.dumps(state(p_node), sort_keys=True)
    api("POST", f"/api/v1/nodes/{p_node['id']}/methods/keyer.setEnabled", {"enabled": True})
    time.sleep(2)
    sp, ss = state(p_node), state(s_node)
    print(f"C    keyer.setEnabled nur am Primär: Primär geändert: {json.dumps(sp, sort_keys=True) != st1}; Standby == Primär: {json.dumps(sp, sort_keys=True) == json.dumps(ss, sort_keys=True)}" + ("" if args.cold else ""))

    # CPU: 10 s Probe der Prozesse
    def ticks(iid):
        pid = pid_of_instance(iid)
        f = open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()
        return int(f[11]) + int(f[12])
    names = ["src", "p", "s", "sel"]
    t0 = {n: ticks(rt[n]["instanceId"]) for n in names}
    time.sleep(10)
    t1 = {n: ticks(rt[n]["instanceId"]) for n in names}
    cpu = {n: round((t1[n] - t0[n]) / 10.0, 1) for n in names}  # Ticks/s bei 100 Hz = Prozent eines Kerns
    print(f"CPU  (% eines Kerns, 10 s, Standby {'KALT' if args.cold else 'LIVE'}): {cpu}")

    if args.kill and not args.cold:
        sp_before = json.dumps(state(p_node), sort_keys=True)
        out_before = json.loads(param(sel, "videoOut"))
        ppid = pid_of_instance(rt["p"]["instanceId"])
        t0 = time.time()
        os.kill(ppid, signal.SIGKILL)
        t_sel = t_role = None
        while time.time() - t0 < 30:
            if t_sel is None and param(sel, "active") == "n1":
                t_sel = time.time() - t0
            w = api("GET", f"/api/v1/workflows/{wid}")
            if t_role is None and w["runtime"]["p"]["instanceId"] == rt["s"]["instanceId"]:
                t_role = time.time() - t0
            if t_sel is not None and t_role is not None:
                break
            time.sleep(0.02)
        print(f"A/B  Umschalter auf Standby nach {t_sel and int(t_sel*1000)} ms; Rolle p -> Standby-Instanz nach {t_role and int(t_role*1000)} ms")
        time.sleep(3)
        w = api("GET", f"/api/v1/workflows/{wid}")
        p2 = {n["id"]: n for n in api("GET", "/api/v1/nodes")}[w["runtime"]["p"]["nodeId"]]
        print("     Zustand der übernommenen Rolle == Zustand des alten Primär vor dem Kill:", json.dumps(state(p2), sort_keys=True) == sp_before)
        out = json.loads(param(sel, "videoOut"))
        print(f"     Umschalter-Ausgang rund um den Kill: Bilder +{out['frames'] - out_before['frames']}, davon ohne frisches Bild der aktiven Quelle +{out['repeats'] - out_before['repeats']};", "| Status:", w["status"], "| aktiv:", param(sel, "active"))
finally:
    try:
        api("POST", f"/api/v1/workflows/{wid}/stop")
        wait(lambda: api("GET", f"/api/v1/workflows/{wid}")["status"] == "stopped", "Workflow gestoppt", 60)
        time.sleep(1)
        api("DELETE", f"/api/v1/workflows/{wid}")
    except Exception as e:
        print("Aufräumen:", e)
