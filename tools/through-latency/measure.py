#!/usr/bin/env python3
"""Durchlaufzeit Eingang → Ausgang von Bild- und/oder Audiomischer messen (Sync-Generator + Sonde).

Legt eine Testquelle (`omp-source` mit Sync-Marker: schwarzes Bild + je Sekunde ein weißes Bild und ein Audio-Tick,
Optionen `OMP_SOURCE_VIDEO_MARKER=1`, `OMP_SOURCE_AUDIO_WAVE=ticks`) und je einen Mischer an (Label „TL …“), verbindet sie,
startet die Sonde `through_latency_probe` (nodes/omp-mediaio/examples) und löscht alle Instanzen wieder. Nur Standardbibliothek.
Die Ausgabe nennt je Marker die echte Durchlaufzeit (Ankunft Ausgang − Eingang) und den Etikett-Versatz im Flow.
Kurz und klein halten: `nice`, ein Eingang, Standard 12 s.

  set -a; source deploy/dev/mxl.env; set +a
  (cd nodes && cargo build --release -p omp-mediaio --features mxl --example through_latency_probe)
  python3 tools/through-latency/measure.py [--target video|audio|both] [--seconds 12] [--runs 1]
Verbindliche Zahlen nur von einem echten Host; auf dem Entwicklungsrechner nur Vorher/Nachher im selben Lauf.
"""
import argparse, json, os, subprocess, sys, time, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://localhost:8000")
ap.add_argument("--user", default="admin")
ap.add_argument("--password", default="adminpass123")
ap.add_argument("--registry", default="http://127.0.0.1:8010")
ap.add_argument("--target", choices=["video", "audio", "both"], default="both")
ap.add_argument("--seconds", type=int, default=12)
ap.add_argument("--runs", type=int, default=1)
ap.add_argument("--mix-latency-ms", type=int, default=None, help="OMP_AUDIO_MIX_LATENCY_MS des Audiomischers (Standard 40)")
ap.add_argument("--probe", default="nodes/target/release/examples/through_latency_probe")
args = ap.parse_args()
domain = os.environ.get("OMP_MXL_DOMAIN")
if not domain:
    sys.exit("OMP_MXL_DOMAIN fehlt: set -a; source deploy/dev/mxl.env; set +a")


def call(method, url, body=None, token=None):
    req = urllib.request.Request(url, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})})
    with urllib.request.urlopen(req, timeout=30) as r:
        d = r.read()
        return json.loads(d) if d else None


tok = call("POST", f"{args.base}/api/v1/auth/login", {"username": args.user, "password": args.password})["token"]
api = lambda m, p, b=None: call(m, f"{args.base}{p}", b, tok)
created = []


def wait(fn, what, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(1)
    raise RuntimeError(f"Zeitüberschreitung: {what}")


def node(label):
    nodes = api("GET", "/api/v1/nodes")
    nodes = nodes if isinstance(nodes, list) else nodes.get("nodes", [])
    return next((n for n in nodes if n["label"] == label and n.get("online") and n.get("senders")), None)


def flow_id(sender_id):
    return call("GET", f"{args.registry}/x-nmos/query/v1.3/senders/{sender_id}")["flow_id"]


def sender(n, fmt, label_ok=lambda l: True):
    return next(s for s in n["senders"] if s["format"].endswith(fmt) and label_ok(s["label"]))


def run_probe(kind, fin, fout):
    for run in range(1, args.runs + 1):
        print(f"== {kind}: Lauf {run}")
        out = subprocess.run(["nice", "-n", "10", args.probe, domain, kind, fin, fout, str(args.seconds)], capture_output=True, text=True)
        print(out.stdout.strip() or out.stderr.strip())


try:
    r = api("POST", "/api/v1/instances", {"type": "omp-source", "label": "TL Quelle", "options": {
        "OMP_SOURCE_PATTERN": "black", "OMP_SOURCE_VIDEO_MARKER": "1", "OMP_SOURCE_AUDIO_WAVE": "ticks",
        "OMP_WIDTH": "640", "OMP_HEIGHT": "360", "OMP_FRAMERATE_NUM": "25", "OMP_FRAMERATE_DEN": "1"}})
    created.append(r["id"])
    mixers = {}
    if args.target in ("video", "both"):
        r = api("POST", "/api/v1/instances", {"type": "omp-video-mixer-me", "label": "TL Bildmischer"})
        created.append(r["id"]); mixers["video"] = "TL Bildmischer"
    if args.target in ("audio", "both"):
        r = api("POST", "/api/v1/instances", {"type": "omp-audio-mixer", "label": "TL Audiomischer", **({"options": {"OMP_AUDIO_MIX_LATENCY_MS": str(args.mix_latency_ms)}} if args.mix_latency_ms is not None else {})})
        created.append(r["id"]); mixers["audio"] = "TL Audiomischer"
    src = wait(lambda: node("TL Quelle"), "Quelle online")
    nodes = {k: wait(lambda l=l: node(l), f"{l} online") for k, l in mixers.items()}
    sv, sa = sender(src, "video"), sender(src, "audio")
    if "video" in nodes:
        m = nodes["video"]["id"]
        api("POST", f"/api/v1/nodes/{m}/methods/crosspoint.select", {"senderId": sv["id"]})
        api("POST", f"/api/v1/nodes/{m}/methods/crosspoint.cut", {})
    if "audio" in nodes:
        m = nodes["audio"]["id"]
        api("POST", f"/api/v1/nodes/{m}/methods/addChannel", {"label": "Test"})
        time.sleep(2)
        api("POST", f"/api/v1/nodes/{m}/methods/channel.ch1.setSource", {"senderId": sa["id"]})
    time.sleep(5)
    if "video" in nodes:
        n = node("TL Bildmischer")
        run_probe("video", flow_id(sv["id"]), flow_id(sender(n, "video", lambda l: l.startswith("PGM"))["id"]))
    if "audio" in nodes:
        n = node("TL Audiomischer")
        run_probe("audio", flow_id(sa["id"]), flow_id(sender(n, "audio", lambda l: "Monitor" not in l)["id"]))
finally:
    for i in created:
        try:
            api("DELETE", f"/api/v1/instances/{i}")
        except Exception as e:
            print("Aufräumen:", e, file=sys.stderr)
