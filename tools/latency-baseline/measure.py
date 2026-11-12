#!/usr/bin/env python3
"""Messgrundlage Härtung (HAERTUNG-PLAN.md §4.0, Schritt 98.0): startet einen Kanal-Player und einen Bildmischer (eigene Instanzen mit
Label "LB ...", am Ende gelöscht), spielt einen Clip, schaltet den Player auf den Mischer-Programmausgang und misst je Lauf
  - Schreiben→Lesen (Sonde `write_read_latency_probe`, Live-Modus) am Player-Ausgang und am Mischer-PGM,
  - CPU-Ticks (utime+stime aus /proc/<pid>/stat) und Kontextwechsel (/proc/<pid>/status) von Player und Mischer über die Probe.
Kurz und klein halten: `nice`, Standard 3 Läufe × 10 s, Instanzen werden sofort gelöscht. Nur Standardbibliothek.

  set -a; source deploy/dev/mxl.env; set +a
  cargo build --release -p omp-mediaio --features mxl --example write_read_latency_probe   (in nodes/)
  python3 tools/latency-baseline/measure.py --clip /pfad/tccount.mp4 [--seconds 10] [--runs 3]

Verbindliche Zahlen nur von einem echten Host; auf dem Entwicklungsrechner (VM) nur Vorher/Nachher im selben Lauf.
"""
import argparse, json, os, subprocess, sys, time, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://localhost:8000")
ap.add_argument("--user", default="admin")
ap.add_argument("--password", default="adminpass123")
ap.add_argument("--registry", default="http://127.0.0.1:8010")
ap.add_argument("--clip", required=True)
ap.add_argument("--seconds", type=int, default=10)
ap.add_argument("--runs", type=int, default=3)
ap.add_argument("--probe", default="nodes/target/release/examples/write_read_latency_probe")
args = ap.parse_args()


def call(method, url, body=None, token=None):
    req = urllib.request.Request(url, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})})
    with urllib.request.urlopen(req, timeout=30) as r:
        d = r.read()
        return json.loads(d) if d else None


tok = call("POST", f"{args.base}/api/v1/auth/login", {"username": args.user, "password": args.password})["token"]
api = lambda m, p, b=None: call(m, f"{args.base}{p}", b, tok)
created = []


def wait(fn, what, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(1)
    raise RuntimeError(f"Zeitüberschreitung: {what}")


def proc(pid):
    try:
        f = open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()
        ticks = int(f[11]) + int(f[12])
        st = {l.split(":")[0]: int(l.split()[1]) for l in open(f"/proc/{pid}/status") if "ctxt" in l}
        return ticks, st.get("voluntary_ctxt_switches", 0), st.get("nonvoluntary_ctxt_switches", 0)
    except OSError:
        return 0, 0, 0


def probe(flow_id, pids):
    before = {n: proc(p) for n, p in pids.items()}
    out = subprocess.run(["nice", "-n", "10", args.probe, flow_id, str(args.seconds)], capture_output=True, text=True).stdout
    after = {n: proc(p) for n, p in pids.items()}
    lines = [l for l in out.splitlines() if l.startswith(("LATENCY", "COUNT"))]
    for n in pids:
        d = [a - b for a, b in zip(after[n], before[n])]
        lines.append(f"NODE {n} cpu_ticks={d[0]} voluntary_ctxt={d[1]} nonvoluntary_ctxt={d[2]}")
    return "\n".join(lines)


try:
    ids, pids = {}, {}
    for t, l in [("omp-channel-player", "LB Player"), ("omp-video-mixer-me", "LB Mixer")]:
        r = api("POST", "/api/v1/instances", {"type": t, "label": l})
        ids[l] = r["id"]
        pids[l.split()[1]] = r["pid"]
        created.append(r["id"])

    def node(l):
        nodes = api("GET", "/api/v1/nodes")
        nodes = nodes if isinstance(nodes, list) else nodes.get("nodes", [])
        return next((n for n in nodes if n["label"] == l and n.get("online")), None)

    player = wait(lambda: node("LB Player"), "Player online")
    mixer = wait(lambda: node("LB Mixer"), "Mixer online")
    api("POST", f"/api/v1/nodes/{player['id']}/methods/load", {"label": "Zaehler", "file": args.clip})
    time.sleep(6)
    player, mixer = node("LB Player"), node("LB Mixer")
    pvid = next(s for s in player["senders"] if s["format"].endswith("video") and "Lowres" not in s["label"])
    mixer_vid = next(s for s in mixer["senders"] if s["format"].endswith("video") and s["label"].startswith("PGM"))
    api("POST", f"/api/v1/nodes/{mixer['id']}/methods/crosspoint.select", {"senderId": pvid["id"]})
    api("POST", f"/api/v1/nodes/{mixer['id']}/methods/crosspoint.cut", {})
    for run in range(1, args.runs + 1):
        api("POST", f"/api/v1/nodes/{player['id']}/methods/load", {"label": "Zaehler", "file": args.clip})
        time.sleep(7)
        print(f"== Lauf {run}: Player-Ausgang")
        print(probe(pvid["flow_id"], pids))
        print(f"== Lauf {run}: Mischer-PGM")
        print(probe(mixer_vid["flow_id"], pids))
finally:
    for i in created:
        try:
            api("DELETE", f"/api/v1/instances/{i}")
        except Exception as e:
            print("Aufräumen:", e, file=sys.stderr)
