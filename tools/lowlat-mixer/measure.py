#!/usr/bin/env python3
"""Durchlaufzeit des Studio-Mischers (omp-lowlat-mixer) messen: legt eine Mischer-Instanz („LL …“) an, startet den
Tick-Generator (Beispiel `tick_flow_gen`, schreibt 1-ms-Blöcke — `omp-source` schreibt 10-ms-Blöcke und taugt hier nicht), verbindet
ihn mit Streifen 1, misst mit `through_latency_probe` (Ankunft Ausgang − Eingang je Sekunden-Tick, Auflösung ≈ 1 ms) und liest die
Zähler des Mischers (Rechenzeit, Unterläufe, verpasste Takte). Instanz und Generator werden am Ende beendet. Nur Standardbibliothek.

  set -a; source deploy/dev/mxl.env; set +a
  (cd nodes && cargo build --release -p omp-lowlat-mixer && cargo build --release -p omp-mediaio --features mxl \
      --example tick_flow_gen --example through_latency_probe)
  python3 tools/lowlat-mixer/measure.py [--block 48] [--buffer-ms 1] [--seconds 12] [--rt 50] [--aes] [--alsa hw:0,0]
Kurz und klein halten (`nice`, eine Instanz). Verbindliche Zahlen nur von einem echten Host mit Echtzeit-Rechten.
"""
import argparse, json, os, subprocess, sys, time, urllib.request, uuid

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://localhost:8000")
ap.add_argument("--user", default="admin")
ap.add_argument("--password", default="adminpass123")
ap.add_argument("--block", default="48", choices=["16", "48", "96", "192", "480"])
ap.add_argument("--buffer-ms", default="1")
ap.add_argument("--seconds", type=int, default=12)
ap.add_argument("--rt", default="50", help="OMP_LL_RT_PRIORITY (0 = aus)")
ap.add_argument("--gen-block", default="48", help="Blockgröße des Generators (Rahmen)")
ap.add_argument("--alsa", default="", help="ALSA-Gerät für Ein- und Ausgang (Takt durch die Karte); Streifen 2 liest die Karte")
ap.add_argument("--option", action="append", default=[], help="weitere Optionen KEY=WERT")
ap.add_argument("--nodes-dir", default="nodes/target/release")
args = ap.parse_args()
domain = os.environ.get("OMP_MXL_DOMAIN") or sys.exit("OMP_MXL_DOMAIN fehlt: set -a; source deploy/dev/mxl.env; set +a")


def call(method, url, body=None, token=None):
    req = urllib.request.Request(url, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})})
    with urllib.request.urlopen(req, timeout=30) as r:
        d = r.read()
        return json.loads(d) if d else None


tok = call("POST", f"{args.base}/api/v1/auth/login", {"username": args.user, "password": args.password})["token"]
api = lambda m, p, b=None: call(m, f"{args.base}{p}", b, tok)
created, procs = [], []


def node(label):
    ns = api("GET", "/api/v1/nodes")
    ns = ns if isinstance(ns, list) else ns.get("nodes", [])
    return next((n for n in ns if n["label"] == label and n.get("online") and n.get("senders")), None)


try:
    options = {"OMP_LL_BLOCK": args.block, "OMP_LL_INPUT_BUFFER_MS": args.buffer_ms, "OMP_LL_RT_PRIORITY": args.rt, "OMP_LL_STRIPS": "4", "OMP_LL_BUSES": "2"}
    if args.alsa:
        options.update({"OMP_LL_ALSA_IN": args.alsa, "OMP_LL_ALSA_OUT": args.alsa})
    for kv in args.option:
        k, v = kv.split("=", 1)
        options[k] = v
    r = api("POST", "/api/v1/instances", {"type": "omp-lowlat-mixer", "label": "LL Mischer", "options": options})
    created.append(r["id"])
    mixer = None
    for _ in range(60):
        mixer = node("LL Mischer")
        if mixer:
            break
        time.sleep(1)
    if not mixer:
        sys.exit("Mischer nicht online")
    flow = str(uuid.uuid4())
    gen = subprocess.Popen(["nice", "-n", "5", f"{args.nodes_dir}/examples/tick_flow_gen", flow, args.gen_block, str(args.seconds + 12)], stdout=subprocess.DEVNULL)
    procs.append(gen)
    time.sleep(1.5)
    api("POST", f"/api/v1/nodes/{mixer['id']}/methods/strip.1.setFlow", {"flowId": flow})
    out = next(s for s in mixer["senders"] if s["label"] == "Hauptmix")
    out_flow = call("GET", f"http://127.0.0.1:8010/x-nmos/query/v1.3/senders/{out['id']}")["flow_id"]
    time.sleep(4)
    res = subprocess.run(["nice", "-n", "10", f"{args.nodes_dir}/examples/through_latency_probe", domain, "audio", flow, out_flow, str(args.seconds)], capture_output=True, text=True)
    print(f"== Studio-Mischer: Block {args.block} Rahmen, Eingangs-Reserve {args.buffer_ms} ms, Generator-Block {args.gen_block}, Echtzeit {args.rt}")
    print(res.stdout.strip() or res.stderr.strip())
    for p in ["blockMs", "clockMaster", "realtime", "processUsAvg", "processUsMax", "deadlineMisses", "ringUnderruns", "ringSlips", "ringGrown", "ringShrunk", "mxlOutResyncs", "mxlInResyncs", "alsaIn", "alsaOut", "alsaXruns", "alsaOutDelayMs", "strip.1.state", "strip.1.bufferMs"]:
        try:
            v = api("GET", f"/api/v1/nodes/{mixer['id']}/params/{p}")
            print(f"  {p} = {v.get('value', v) if isinstance(v, dict) else v}")
        except Exception as e:
            print(f"  {p}: {e}")
finally:
    for p in procs:
        p.terminate()
    for i in created:
        try:
            api("DELETE", f"/api/v1/instances/{i}")
        except Exception as e:
            print("Aufräumen:", e, file=sys.stderr)
