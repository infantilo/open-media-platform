#!/usr/bin/env python3
"""Host-AUSFALL (Kapitel 109): Primär-Mischer auf Regie-Host-A, Live-Standby auf Regie-Host-B (simulierte Host-Agents, `make hosts`); der Host wird simuliert ausgefallen (Host-Agent und Mischer hart beendet, kein Exit-Ereignis). Misst Umschalter, Übernahme durch den Orchestrator und Wiederherstellung der Redundanz. Ableitung von workflow_mixer.py:  Live-Prüfung Kapitel 109 A–C mit ECHTEN Bildmischern (omp-video-mixer-me) und CPU-Messung des Standby. [--cold: kalter Standby als Vergleich]. (Ableitung von workflow.py; Beschreibung dort:) Live-Prüfung im vollen Workflow (Orchestrator mit neuem Code nötig). Rollen: p (omp-source, Primär), s (omp-source,
Live-Standby von p), sel (omp-failover, Profil redundancy). Prüft: Start verdrahtet p->sel(Hauptsignal) und s->sel(Notquelle 1); Befehl an p
(Parameter pattern) wird auf s gespiegelt; harter Kill von p -> Umschalter schaltet auf s, Orchestrator übernimmt (Trigger first-exit),
Rolle p zeigt auf die Standby-Instanz, Zustand bleibt. Der Workflow wird am Ende gestoppt und gelöscht. Nur Standardbibliothek."""
import argparse, json, os, signal, time, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://localhost:8000")
ap.add_argument("--user", default="admin")
ap.add_argument("--password", default="adminpass123")
ap.add_argument("--cold", action="store_true")
ap.add_argument("--wait", type=int, default=90)
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
hosts = {h["label"]: h["id"] for h in api("GET", "/api/v1/hosts")}
HA, HB = hosts["Regie-Host-A"], hosts["Regie-Host-B"]
definition = {
    "roles": [
        {"name": "src", "nodeType": "omp-source", "format": fmt},
        {"name": "p", "nodeType": "omp-video-mixer-me", "format": fmt, "hostId": HA, "redundancyGroup": "mix"},
        {"name": "s", "nodeType": "omp-video-mixer-me", "standbyFor": "p", "standbyLive": not args.cold, "format": fmt, "hostId": HB, "redundancyGroup": "mix"},
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

    print("Hosts:", {r: rt[r].get("hostId", "")[:8] for r in rt})
    assert rt["p"].get("hostId") and rt["s"].get("hostId") and rt["p"]["hostId"] != rt["s"]["hostId"], "p und s müssen auf verschiedenen Hosts laufen"
    run_dir = next(d for d in (".run/host1", ".run/host2") if json.load(open(f"{d}/state.json"))["hostId"] == rt["p"]["hostId"])
    print("Host des Primär:", run_dir)
    vs = next(x for x in src_node["senders"] if x["format"].endswith("video"))
    api("POST", f"/api/v1/nodes/{p_node['id']}/methods/crosspoint.take", {"senderId": vs["id"]})
    api("POST", f"/api/v1/nodes/{p_node['id']}/methods/keyer.setEnabled", {"enabled": True})
    time.sleep(3)
    sp_before = json.dumps(state(p_node), sort_keys=True)
    print("Standby == Primär vor dem Ausfall:", sp_before == json.dumps(state(s_node), sort_keys=True))

    # Host A fällt aus: Host-Agent ZUERST hart beenden (kein Exit-Ereignis), dann der Mischer auf diesem Host
    agent = int(open(f"{run_dir}/pid").read())
    out_before = json.loads(param(sel, "videoOut"))
    t0 = time.time()
    os.kill(agent, signal.SIGKILL)
    os.kill(pid_of_instance(rt["p"]["instanceId"]), signal.SIGKILL)
    t_sel = t_role = t_rearm = None
    new_standby = None
    while time.time() - t0 < args.wait:
        if t_sel is None and param(sel, "active") == "n1":
            t_sel = time.time() - t0
        w = api("GET", f"/api/v1/workflows/{wid}")
        if t_role is None and w["runtime"]["p"]["instanceId"] == rt["s"]["instanceId"]:
            t_role = time.time() - t0
        if t_role is not None and w["runtime"]["s"]["instanceId"] != rt["s"]["instanceId"] and t_rearm is None:
            t_rearm = time.time() - t0
            new_standby = w["runtime"]["s"]
        if t_sel is not None and t_rearm is not None:
            break
        time.sleep(0.2)
    fmt_ms = lambda t: "nie" if t is None else f"{t:.1f} s"
    print(f"Host-Ausfall: Umschalter auf Standby nach {fmt_ms(t_sel)}; Orchestrator übernimmt Rolle p nach {fmt_ms(t_role)}; neuer Standby (Redundanz wieder da) nach {fmt_ms(t_rearm)}")
    w = api("GET", f"/api/v1/workflows/{wid}")
    out = json.loads(param(sel, "videoOut"))
    print(f"     Ausgang: Bilder +{out['frames'] - out_before['frames']}, davon ohne frisches Bild der aktiven Quelle +{out['repeats'] - out_before['repeats']}; Status {w['status']}; aktiv {param(sel, 'active')}")
    p2 = {n["id"]: n for n in api("GET", "/api/v1/nodes")}.get(w["runtime"]["p"]["nodeId"])
    st2 = state(p2) if p2 is not None else None
    same = st2 is not None and json.dumps(st2, sort_keys=True) == sp_before
    print("     Zustand der übernommenen Rolle == Zustand vor dem Ausfall:", same)
    if not same and st2 is not None:
        old = json.loads(sp_before)
        for k in sorted(set(old) | set(st2)):
            if json.dumps(old.get(k), sort_keys=True) != json.dumps(st2.get(k), sort_keys=True):
                print("       abweichend:", k, "vorher", str(old.get(k))[:120], "| jetzt", str(st2.get(k))[:120])
    if new_standby:
        print("     neuer Standby auf Host:", new_standby.get("hostId", "")[:8], "(Primär jetzt auf", w["runtime"]["p"].get("hostId", "")[:8] + ")")
finally:
    try:
        api("POST", f"/api/v1/workflows/{wid}/stop")
        wait(lambda: api("GET", f"/api/v1/workflows/{wid}")["status"] == "stopped", "Workflow gestoppt", 60)
        time.sleep(1)
        api("DELETE", f"/api/v1/workflows/{wid}")
    except Exception as e:
        print("Aufräumen:", e)
