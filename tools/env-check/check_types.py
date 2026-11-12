#!/usr/bin/env python3
"""Härtung 98.1: startet jeden Katalogtyp einmal (eigene Instanz "EC <typ>", sofort gelöscht), wartet auf die Anmeldung in der
Registry und prüft /proc/<pid>/environ: keine Plattform-Geheimnisse. Kurz und nacheinander, Standardbibliothek.

  python3 tools/env-check/check_types.py [--only typ1,typ2] [--wait 25]
Die Geheimnisse selbst stehen NIE in der Ausgabe; geprüft wird nur auf Namen und die Werte aus der Umgebung des Orchestrators.
"""
import argparse, json, os, sys, time, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://localhost:8000")
ap.add_argument("--user", default="admin")
ap.add_argument("--password", default="adminpass123")
ap.add_argument("--only", default="")
ap.add_argument("--wait", type=int, default=25)
ap.add_argument("--catalog", default="deploy/catalog.json")
args = ap.parse_args()

# Namen, die nie in einem Node-Environment stehen dürfen (Muster wie envfilter.go).
BAD_EXACT = {"OMP_POSTGRES_URL", "OMP_STORAGE_SECRET_KEY", "OMP_MINIO_SECRET_KEY", "OMP_MINIO_ACCESS_KEY", "OMP_BACKUP_PASSPHRASE",
             "OMP_ALERT_SMTP_PASSWORD", "OMP_ALERT_WEBHOOK_TOKEN", "OMP_HOST_AGENT_BOOTSTRAP_TOKEN", "AWS_SECRET_ACCESS_KEY",
             "AWS_ACCESS_KEY_ID", "AWS_SESSION_TOKEN"}
BAD_PREFIX = ("OMP_CLOUD_", "AWS_")
BAD_SUFFIX = ("_SECRET_KEY", "_ACCESS_KEY", "_PASSWORD", "_PASSPHRASE")


def call(method, url, body=None, token=None):
    req = urllib.request.Request(url, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})})
    with urllib.request.urlopen(req, timeout=30) as r:
        d = r.read()
        return json.loads(d) if d else None


tok = call("POST", f"{args.base}/api/v1/auth/login", {"username": args.user, "password": args.password})["token"]
api = lambda m, p, b=None: call(m, f"{args.base}{p}", b, tok)
cat = json.load(open(args.catalog))
types = [e.get("type") or e.get("id") for e in cat]
if args.only:
    types = [t for t in types if t in args.only.split(",")]


def online(label):
    nodes = api("GET", "/api/v1/nodes")
    nodes = nodes if isinstance(nodes, list) else nodes.get("nodes", [])
    return any(n["label"] == label and n.get("online") for n in nodes)


def bad_names(pid):
    try:
        raw = open(f"/proc/{pid}/environ", "rb").read().split(b"\0")
    except OSError as e:
        return None, str(e)
    names = [r.split(b"=", 1)[0].decode(errors="replace") for r in raw if b"=" in r]
    bad = [n for n in names if n in BAD_EXACT or n.startswith(BAD_PREFIX) or n.endswith(BAD_SUFFIX)]
    return bad, len(names)


fails, notup = 0, []
for t in types:
    label = f"EC {t}"
    iid = None
    try:
        r = api("POST", "/api/v1/instances", {"type": t, "label": label})
        iid, pid = r["id"], r["pid"]
        end, up = time.time() + args.wait, False
        while time.time() < end:
            if online(label):
                up = True
                break
            time.sleep(1)
        bad, n = bad_names(pid)
        status = "online" if up else "NICHT online"
        if not up:
            notup.append(t)
        if bad is None:
            print(f"{t}: {status}; environ nicht lesbar ({n})")
        elif bad:
            fails += 1
            print(f"{t}: {status}; GEHEIMNIS-NAMEN IM ENVIRON: {bad}")
        else:
            print(f"{t}: {status}; environ sauber ({n} Variablen)")
    except Exception as e:
        print(f"{t}: Start fehlgeschlagen: {e}")
        notup.append(t)
    finally:
        if iid:
            try:
                api("DELETE", f"/api/v1/instances/{iid}")
            except Exception as e:
                print("Aufräumen:", e, file=sys.stderr)
    sys.stdout.flush()
print(f"ERGEBNIS: {len(types)} Typen, Geheimnisse gefunden bei {fails}, nicht online: {notup}")
sys.exit(1 if fails else 0)
