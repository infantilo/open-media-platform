#!/usr/bin/env python3
"""Versatz Zeitcode ↔ Bild messen: startet einen Kanal-Player und einen Bildmischer (eigene Instanzen, am Ende gelöscht), spielt einen
Clip mit eingebranntem Bildzähler (`make-clip.sh`) und vergleicht je Grain den Zähler im Bild mit dem Zeitcode — einmal direkt am
Ausgang des Players, einmal am Programmausgang des Mischers (Test `tc_offset` in omp-video-mixer-me). Nur Standardbibliothek.

  set -a; source deploy/dev/mxl.env; set +a
  python3 tools/tc-offset/measure.py --clip /pfad/tccount.mp4 [--seconds 15]
"""
import argparse, json, os, subprocess, sys, time, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://localhost:8000")
ap.add_argument("--user", default="admin")
ap.add_argument("--password", default="adminpass123")
ap.add_argument("--registry", default="http://127.0.0.1:8010")
ap.add_argument("--clip", required=True)
ap.add_argument("--seconds", type=int, default=15)
ap.add_argument("--runs", type=int, default=3, help="Wiederholungen mit frisch geladenem Clip (der Versatz kann je Start schwanken)")
ap.add_argument("--shift", default="", help="OMP_TC_SHIFT_FRAMES des Mischers")
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


def senders():
    return call("GET", f"{args.registry}/x-nmos/query/v1.3/senders?paging.limit=500")


def wait(fn, what, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(1)
    raise RuntimeError(f"Zeitüberschreitung: {what}")


def probe(video_flow, tc_flow):
    env = {**os.environ, "OMP_TEST_VIDEO_FLOW": video_flow, "OMP_TEST_TC_FLOW": tc_flow, "OMP_TEST_SECONDS": str(args.seconds)}
    out = subprocess.run(["nice", "cargo", "test", "--release", "--manifest-path", "nodes/Cargo.toml", "-p", "omp-video-mixer-me", "--",
                          "--ignored", "--nocapture", "tc_offset"], env=env, capture_output=True, text=True).stdout
    return "\n".join(l for l in out.splitlines() if l.startswith(("GRAINS", "OFFSET")))


try:
    ids = {}
    for t, l in [("omp-channel-player", "TCT Player"), ("omp-video-mixer-me", "TCT Mixer")]:
        ids[l] = api("POST", "/api/v1/instances", {"type": t, "label": l})["id"]
        created.append(ids[l])
    def node(l):
        nodes = api("GET", "/api/v1/nodes")
        nodes = nodes if isinstance(nodes, list) else nodes.get("nodes", [])
        return next((n for n in nodes if n["label"] == l and n.get("online")), None)
    player = wait(lambda: node("TCT Player"), "Player online")
    mixer = wait(lambda: node("TCT Mixer"), "Mixer online")
    api("POST", f"/api/v1/nodes/{player['id']}/methods/load", {"label": "Zaehler", "file": args.clip})
    time.sleep(6)
    player, mixer = node("TCT Player"), node("TCT Mixer")
    pvid = next(s for s in player["senders"] if s["format"].endswith("video") and "Lowres" not in s["label"])
    ptc = next(s for s in player["senders"] if s["label"].endswith("Zeitcode (ANC)"))
    mixer_vid = next(s for s in mixer["senders"] if s["format"].endswith("video") and s["label"].startswith("PGM"))
    mixer_tc = next(s for s in mixer["senders"] if s["label"].endswith("Zeitcode (ANC)"))
    api("POST", f"/api/v1/nodes/{mixer['id']}/methods/crosspoint.select", {"senderId": pvid["id"]})
    api("POST", f"/api/v1/nodes/{mixer['id']}/methods/crosspoint.cut", {})
    for run in range(1, args.runs + 1):
        api("POST", f"/api/v1/nodes/{player['id']}/methods/load", {"label": "Zaehler", "file": args.clip})
        time.sleep(7)
        print(f"== Lauf {run}: Player direkt (Bild gegen Zeitcode des Players)")
        print(probe(pvid["flow_id"], ptc["flow_id"]))
        print(f"== Lauf {run}: Mischer-PGM (Bild gegen Zeitcode des PGM)")
        print(probe(mixer_vid["flow_id"], mixer_tc["flow_id"]))
finally:
    for i in created:
        try:
            api("DELETE", f"/api/v1/instances/{i}")
        except Exception as e:
            print("Aufräumen:", e, file=sys.stderr)
