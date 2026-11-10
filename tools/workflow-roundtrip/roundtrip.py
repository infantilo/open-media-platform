#!/usr/bin/env python3
"""Stop/Start-Rundreise eines Workflows: Zustand und Verbindungen dürfen sich nicht ändern.

Nimmt vor dem Stop einen Schnappschuss (/state jedes Workflow-Nodes, Graph-Kanten), stoppt, startet,
wartet bis alle Rollen wieder registriert sind und die Wiederherstellung durch ist, nimmt erneut auf und
vergleicht. Alle IDs (Node, Sender, Empfänger, Gerät, Flow) werden vor dem Vergleich durch Labels ersetzt,
weil sie bei jedem Start neu vergeben werden. Ausgabe: jeder Unterschied mit Pfad; Exit-Code 1 bei Abweichung.

Läuft gegen einen LAUFENDEN Stack. Der Workflow wird dabei gestoppt und gestartet (Sendebetrieb stört das!).
Nur Standardbibliothek.

  python3 tools/workflow-roundtrip/roundtrip.py --workflow "Durchlauf Playout" [--base http://localhost:8000]
  python3 tools/workflow-roundtrip/roundtrip.py --workflow ... --snapshot-only out.json   # nur sichern
  python3 tools/workflow-roundtrip/roundtrip.py --workflow ... --compare out.json         # gegen Datei vergleichen
"""
import argparse, json, os, re, subprocess, sys, time, urllib.error, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://localhost:8000")
ap.add_argument("--user", default="admin")
ap.add_argument("--password", default="adminpass123")
ap.add_argument("--workflow", required=True, help="Name oder ID")
ap.add_argument("--snapshot-only", metavar="FILE")
ap.add_argument("--compare", metavar="FILE", help="gegen gespeicherten Schnappschuss vergleichen (kein Stop/Start)")
ap.add_argument("--settle", type=float, default=90, help="max. Sekunden Wartezeit nach dem Start")
ap.add_argument("--no-health", action="store_true", help="PGM-Flow-Gesundheitsprüfung nach dem Start auslassen")
ap.add_argument("--ignore", default="", help="zusätzliche, kommagetrennte Schlüsselnamen (flüchtige Werte)")
args = ap.parse_args()
BASE = args.base.rstrip("/")
# Flüchtige Messwerte, die sich ohnehin ständig ändern.
VOLATILE = {"level", "levels", "peak", "peakDb", "rms", "meters", "meter", "timestamp", "time", "now", "uptime",
            "lastUpdate", "updatedAt", "heartbeat", "fps", "currentFps", "tc", "timecode", "position", "connectionStatus"}
VOLATILE |= {k for k in args.ignore.split(",") if k}
TOKEN = ""


def call(method, path, body=None, timeout=15):
    req = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"content-type": "application/json", **({"Authorization": "Bearer " + TOKEN} if TOKEN else {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")[:200]
    except Exception as e:  # noqa: BLE001
        return 0, str(e)


def find_workflow():
    st, wfs = call("GET", "/api/v1/workflows")
    if st != 200:
        sys.exit(f"Workflows nicht lesbar: {st} {wfs}")
    for w in wfs:
        if args.workflow in (w["id"], w["name"]):
            return w
    sys.exit(f"Workflow {args.workflow!r} nicht gefunden")


def label_index(nodes):
    idx = {}
    for n in nodes:
        idx[n["id"]] = n["label"]
        for d in n.get("devices", []) or []:
            idx[d["id"]] = f"{n['label']}/device"
        for s in n.get("senders", []) or []:
            idx[s["id"]] = f"{n['label']}/S:{s['label']}"
            if s.get("flow_id"):
                idx[s["flow_id"]] = f"{n['label']}/F:{s['label']}"
        for r in n.get("receivers", []) or []:
            idx[r["id"]] = f"{n['label']}/R:{r['label']}"
    return idx


def relabel(v, idx):
    if isinstance(v, str):
        return idx.get(v, v)
    if isinstance(v, list):
        items = [relabel(x, idx) for x in v]
        # Listen aus Objekten mit Kennung (z. B. sends[].auxId) haben keine feste Reihenfolge: nach Kennung ordnen.
        for key in ("id", "auxId", "name"):
            if items and all(isinstance(x, dict) and isinstance(x.get(key), str) for x in items):
                return sorted(items, key=lambda x: x[key])
        return items
    if isinstance(v, dict):
        return {k: relabel(x, idx) for k, x in v.items() if k not in VOLATILE}
    return v


def snapshot(wf):
    st, nodes = call("GET", "/api/v1/nodes")
    if st != 200:
        sys.exit(f"Nodes nicht lesbar: {st}")
    roles = {r["name"] for r in wf["definition"].get("roles", [])}
    idx = label_index(nodes)
    out = {"states": {}, "edges": [], "roles": sorted(roles)}
    for n in nodes:
        if n["label"] not in roles:
            continue
        st, s = call("GET", f"/api/v1/nodes/{n['id']}/state")
        out["states"][n["label"]] = relabel(s, idx) if st == 200 else f"<nicht lesbar: HTTP {st}>"
    st, g = call("GET", "/api/v1/graph")
    if st == 200:
        out["edges"] = sorted(json.dumps(relabel(e, idx), sort_keys=True) for e in g.get("edges", []))
    return out


def diff(a, b, path=""):
    d = []
    if type(a) is not type(b):
        return [f"{path}: {json.dumps(a)[:80]} -> {json.dumps(b)[:80]}"]
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a:
                d.append(f"{path}/{k}: fehlt vorher, jetzt {json.dumps(b[k])[:80]}")
            elif k not in b:
                d.append(f"{path}/{k}: vorher {json.dumps(a[k])[:80]}, jetzt FEHLT")
            else:
                d += diff(a[k], b[k], f"{path}/{k}")
    elif isinstance(a, list):
        if len(a) != len(b):
            d.append(f"{path}: Länge {len(a)} -> {len(b)}")
        for i, (x, y) in enumerate(zip(a, b)):
            d += diff(x, y, f"{path}[{i}]")
    elif a != b:
        d.append(f"{path}: {json.dumps(a)[:80]} -> {json.dumps(b)[:80]}")
    return d


MXL_INFO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "third_party", "mxl", "build",
                        "Linux-GCC-Release", "tools", "mxl-info", "mxl-info")


def head_index(flow_id):
    try:
        out = subprocess.run([MXL_INFO, "-d", os.environ.get("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl"), "-f", flow_id],
                             capture_output=True, text=True, timeout=10).stdout
    except Exception:  # noqa: BLE001
        return None
    m = re.search(r"Head index:\s*(\d+)", out)
    return int(m.group(1)) if m else None


def health_problems():
    """Jeder Video-Sender „PGM*“ muss laufen: Head-Index > 0 und wachsend (Hänger vom 2026-11-10: Ausgang blieb bei 0)."""
    if args.no_health or not os.path.exists(MXL_INFO):
        return []
    st, nodes = call("GET", "/api/v1/nodes")
    flows = {}
    for n in nodes if st == 200 else []:
        for sd in n.get("senders", []) or []:
            if sd["label"].startswith("PGM") and sd.get("format", "").endswith(":video") and sd.get("flow_id"):
                flows[f"{n['label']}/{sd['label']}"] = sd["flow_id"]
    first = {k: head_index(v) for k, v in flows.items()}
    time.sleep(2)
    problems = []
    for k, v in flows.items():
        a, b = first[k], head_index(v)
        if not a or not b or b <= a:
            problems.append(f"{k}: Head-Index {a} -> {b} (Ausgang läuft nicht)")
    return problems


def wait_status(wf_id, want, timeout):
    end = time.time() + timeout
    while time.time() < end:
        st, w = call("GET", f"/api/v1/workflows/{wf_id}")
        if st == 200 and w["status"] == want:
            return True
        time.sleep(1)
    return False


def main():
    global TOKEN
    st, r = call("POST", "/api/v1/auth/login", {"username": args.user, "password": args.password})
    if st != 200:
        sys.exit(f"Login fehlgeschlagen: {st} {r}")
    TOKEN = r["token"]
    wf = find_workflow()
    if args.compare:
        before = json.load(open(args.compare))
    else:
        if wf["status"] != "started":
            sys.exit(f"Workflow läuft nicht (Status {wf['status']}); erst starten, dann Schnappschuss.")
        before = snapshot(wf)
        if args.snapshot_only:
            json.dump(before, open(args.snapshot_only, "w"), indent=1, sort_keys=True)
            print(f"Schnappschuss: {len(before['states'])} Rollen, {len(before['edges'])} Kanten -> {args.snapshot_only}")
            return
        json.dump(before, open("/tmp/workflow-roundtrip-before.json", "w"), indent=1, sort_keys=True)
        print(f"Vorher: {len(before['states'])} Rollen, {len(before['edges'])} Kanten (gesichert in /tmp/workflow-roundtrip-before.json). Stoppe …")
        st, r = call("POST", f"/api/v1/workflows/{wf['id']}/stop", timeout=120)
        if st >= 300 or not wait_status(wf["id"], "stopped", 120):
            sys.exit(f"Stop fehlgeschlagen: {st} {r}")
        print("Starte …")
        st, r = call("POST", f"/api/v1/workflows/{wf['id']}/start", timeout=120)
        if st >= 300 or not wait_status(wf["id"], "started", args.settle):
            sys.exit(f"Start fehlgeschlagen: {st} {r}")
    # Wiederherstellung läuft nach „started“ weiter (Retry, Mischer-Pipeline): bis zur Übereinstimmung warten.
    end, diffs = time.time() + args.settle, ["noch nicht gelesen"]
    while time.time() < end and diffs:
        time.sleep(3)
        diffs = diff(before, snapshot(find_workflow()))
    problems = health_problems()
    if diffs:
        print(f"ABWEICHUNG nach {args.settle:.0f}s ({len(diffs)}):")
        for x in diffs[:60]:
            print("  ", x)
        print("Hinweis: Rollen mit „Im Workflow speichern“ (gepinnter Startzustand) starten bewusst mit dem GESPEICHERTEN Stand, "
              "nicht mit dem letzten Live-Stand; Abweichungen dort sind gewollt (erneut speichern, dann stimmt der Vergleich).")
        for x in problems:
            print("GESUNDHEIT:", x)
        sys.exit(1)
    if problems:
        print("GESUNDHEIT:")
        for x in problems:
            print("  ", x)
        sys.exit(2)
    print("OK: Zustand und Verbindungen identisch, PGM-Ausgänge laufen.")


main()
