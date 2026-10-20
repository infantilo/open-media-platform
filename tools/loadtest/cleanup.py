"""Entfernt alles, was setup.py angelegt hat (Workflows loadtest-*, Test-Benutzer, Rollenbindung)."""
from common import *
import json, os, urllib.error
adm = login(*ADMIN)
state = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".state.json")
if os.path.exists(state):
    wf = json.load(open(state))["wf"]
    try: req("POST", f"/workflows/{wf}/stop?confirm=true", None, adm)
    except Exception as e: print("stop", e)
    for _ in range(30):
        if req("GET", f"/workflows/{wf}", None, adm)["status"] == "stopped": break
        time.sleep(1)
    os.remove(state)
n = 0
for w in req("GET", "/workflows", None, adm):
    if w["name"].startswith("loadtest-"):
        try: req("DELETE", f"/workflows/{w['id']}", None, adm); n += 1
        except urllib.error.HTTPError as e: print("delete", w["name"], e.code)
for b in req("GET", "/admin/role-bindings", None, adm):
    if b["subject"] == TEST_USER[0]: req("DELETE", f"/admin/role-bindings/{b['id']}", None, adm)
try: req("DELETE", f"/auth/users/{TEST_USER[0]}", None, adm)
except Exception as e: print("user", e)
print("entfernt:", n, "Workflows")
