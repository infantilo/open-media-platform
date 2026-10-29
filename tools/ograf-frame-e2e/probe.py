#!/usr/bin/env python3
"""Frame-Test der Grafik-Einblendung (Kapitel 27/74): zeigt eine Grafik per `show` mit `atUtcMs` (wie die Playout-Automation, 300 ms
Vorlauf) und misst am Fill-Flow des Grafik-Nodes, in welchem Bild sie zuerst erscheint (Test `first_changed_frame` in omp-ograf).
Ausgabe: Abweichung des ersten sichtbaren Bildes von der Sollzeit je Durchlauf, in ms und in Bildern.

Voraussetzung: laufender Stack, ein Grafik-Node mit `OMP_OGRAF_KEEPALIVE=1` (Fluss läuft auch ohne Grafik) und MXL-Umgebung
(`set -a; source deploy/dev/mxl.env; set +a`).

  python3 tools/ograf-frame-e2e/probe.py --label OgTest [--trials 5] [--template subtitle]
"""
import argparse, json, os, re, statistics, subprocess, sys, time, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://localhost:8000")
ap.add_argument("--user", default="admin")
ap.add_argument("--password", default="adminpass123")
ap.add_argument("--label", required=True, help="Bezeichnung des Grafik-Nodes")
ap.add_argument("--trials", type=int, default=5)
ap.add_argument("--template", default="subtitle")
ap.add_argument("--lead-ms", type=int, default=300, help="Vorlauf des Aufrufs vor der Sollzeit (Automation: 300)")
ap.add_argument("--registry", default="http://127.0.0.1:8010")
args = ap.parse_args()


def call(method, url, body=None, token=None):
    req = urllib.request.Request(url, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})})
    with urllib.request.urlopen(req, timeout=30) as r:
        d = r.read()
        return json.loads(d) if d else None


token = call("POST", f"{args.base}/api/v1/auth/login", {"username": args.user, "password": args.password})["token"]
nodes = call("GET", f"{args.base}/api/v1/nodes", token=token)
nodes = nodes if isinstance(nodes, list) else nodes.get("nodes", [])
node = next(n["id"] for n in nodes if n["label"] == args.label)
senders = call("GET", f"{args.registry}/x-nmos/query/v1.3/senders?paging.limit=500")
flow = next(s["flow_id"] for s in senders if s["label"] == f"{args.label} Fill")


def method(name, body):
    return call("POST", f"{args.base}/api/v1/nodes/{node}/methods/{name}", body, token)


def now_ms():
    return time.time() * 1000


results = []
for trial in range(args.trials):
    method("hide", {})
    time.sleep(1.5)
    env = {**os.environ, "OMP_TEST_FLOW": flow, "OMP_TEST_SECONDS": "13"}
    probe = subprocess.Popen(["nice", "cargo", "test", "--release", "-p", "omp-ograf", "--manifest-path", "nodes/Cargo.toml", "--",
                              "--ignored", "--nocapture", "first_changed_frame"], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    time.sleep(5)  # Messung läuft an und hat das Leerbild
    target = int(now_ms() + 3000)
    time.sleep(max(0, (target - args.lead_ms - now_ms()) / 1000))
    method("show", {"templateId": args.template, "layerId": "probe", "data": {"text": f"FRAME TEST {trial + 1}"}, "atUtcMs": target})
    time.sleep(max(0, (target + 2500 - now_ms()) / 1000))
    method("hide", {"layerId": "probe"})
    out, _ = probe.communicate(timeout=60)
    m = re.search(r"FIRST_CHANGE_UTC_MS=([\d.]+) INDEX=(\d+) DIFF=(\d+) FRAME_MS=([\d.]+)", out)
    if not m:
        print(f"  Durchlauf {trial + 1}: keine Messung\n{out[-400:]}")
        continue
    first, frame = float(m.group(1)), float(m.group(4))
    results.append((first - target, frame))
    print(f"  Durchlauf {trial + 1}: erstes verändertes Bild {first - target:+.0f} ms nach der Sollzeit ({(first - target) / frame:+.1f} Bilder)")

if results:
    d = [r[0] for r in results]
    frame = results[0][1]
    print(f"\nMittel {statistics.mean(d):+.0f} ms, Streuung ±{(max(d) - min(d)) / 2:.0f} ms, Bildlänge {frame:.0f} ms")
    print("Kalibrierung: OMP_OGRAF_RENDER_LATENCY_MS am Grafik-Node auf den Mittelwert setzen, wenn er deutlich von 0 abweicht.")
sys.exit(0 if results else 1)
