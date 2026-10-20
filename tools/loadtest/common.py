import json, os, urllib.request, time
B=os.environ.get("OMP_URL","http://localhost:8000")+"/api/v1"
ADMIN=(os.environ.get("OMP_ADMIN_USER","admin"),os.environ.get("OMP_ADMIN_PASSWORD","adminpass123"))
TEST_USER=("claude-loadtest","loadtest-pw-123")
def req(method, path, body=None, token=None, timeout=30):
    r=urllib.request.Request(B+path, method=method, data=(json.dumps(body).encode() if body is not None else None))
    r.add_header("content-type","application/json")
    if token: r.add_header("Authorization","Bearer "+token)
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        d=resp.read()
        return json.loads(d) if d else None
def login(u,p):
    return req("POST","/auth/login",{"username":u,"password":p})["token"]
