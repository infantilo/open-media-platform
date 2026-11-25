#!/usr/bin/env python3
"""Live-Prüfung Kapitel 109 A–C im vollen Workflow (Orchestrator mit neuem Code nötig). Rollen: p (omp-source, Primär), s (omp-source,
Live-Standby von p), sel (omp-failover, Profil redundancy). Prüft: Start verdrahtet p->sel(Hauptsignal) und s->sel(Notquelle 1); Befehl an p
(Parameter pattern) wird auf s gespiegelt; harter Kill von p -> Umschalter schaltet auf s, Orchestrator übernimmt (Trigger first-exit),
Rolle p zeigt auf die Standby-Instanz, Zustand bleibt. Der Workflow wird am Ende gestoppt und gelöscht. Nur Standardbibliothek."""
import argparse, json, os, signal, time, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://localhost:8000")
ap.add_argument("--user", default="admin")
ap.add_argument("--password", default="adminpass123")
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


definition = {
    "roles": [
        {"name": "p", "nodeType": "omp-source", "format": "480p25"},
        {"name": "s", "nodeType": "omp-source", "standbyFor": "p", "standbyLive": True, "format": "480p25"},
        {"name": "sel", "nodeType": "omp-failover", "env": {"OMP_FAILOVER_VIDEO": "1", "OMP_FAILOVER_WIDTH": "848", "OMP_FAILOVER_HEIGHT": "480",
                                                              "OMP_FAILOVER_FPS": "25", "OMP_FAILOVER_PROFILE": "redundancy"}},
    ],
    "connections": [
        {"fromRole": "p", "toRole": "sel", "toReceiver": "Hauptsignal Bild"},
        {"fromRole": "s", "toRole": "sel", "toReceiver": "Notquelle 1 Bild"},
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
    param = lambda n, name: json.loads(json.dumps(api("GET", f"/api/v1/nodes/{n['id']}/params/{name}"))).get("value")
    time.sleep(4)
    srcs = json.loads(param(sel, "sources"))
    print("A/B  Umschalter-Quellen:", [(x["id"], x["state"]) for x in srcs[:2]])
    assert all(x["state"] == "gesund" for x in srcs[:2]), "beide Eingänge müssen gesund sein (Verdrahtung inkl. Standby-Ausgang)"

    # C: Befehl an den Primär wird auf den Standby gespiegelt
    p_node, s_node = nodes[rt["p"]["nodeId"]], nodes[rt["s"]["nodeId"]]
    before = (param(p_node, "pattern"), param(s_node, "pattern"))
    new = "ball" if before[0] != "ball" else "smpte"
    api("PATCH", f"/api/v1/nodes/{p_node['id']}/params/pattern", {"value": new})
    time.sleep(1.5)
    after = (param(p_node, "pattern"), param(s_node, "pattern"))
    print(f"C    pattern vorher {before} -> nachher {after} (erwartet beide '{new}')")
    assert after == (new, new), "Befehl wurde nicht gespiegelt"

    # A/B: harter Kill des Primär
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
    print(f"A/B  Umschalter aktiv auf Standby nach {t_sel and int(t_sel*1000)} ms; Rolle p zeigt auf Standby-Instanz nach {t_role and int(t_role*1000)} ms")
    assert t_sel is not None and t_role is not None
    time.sleep(2)
    p2 = nodes_after = {n["id"]: n for n in api("GET", "/api/v1/nodes")}[api("GET", f"/api/v1/workflows/{wid}")["runtime"]["p"]["nodeId"]]
    print("     Muster der übernommenen Rolle:", param(p2, "pattern"), "(erwartet", new + ")")
    assert param(p2, "pattern") == new
    ev = api("GET", f"/api/v1/workflows/{wid}")
    print("     Status:", ev["status"], "standbyActive:", ev["runtime"]["p"].get("standbyActive"))
finally:
    try:
        api("POST", f"/api/v1/workflows/{wid}/stop")
        wait(lambda: api("GET", f"/api/v1/workflows/{wid}")["status"] == "stopped", "Workflow gestoppt", 60)
        time.sleep(1)
        api("DELETE", f"/api/v1/workflows/{wid}")
    except Exception as e:
        print("Aufräumen:", e)
