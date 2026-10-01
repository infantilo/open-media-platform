import json, re, threading, urllib.request, socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
NODE=os.environ.get("MIXER_NODE","http://127.0.0.1:9791")
PAGE=b"""<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><style>body{margin:0;background:#0b0c0e;color:#e8eaed;font-family:system-ui}</style></head><body><omp-audio-mixer-panel node-id="test"></omp-audio-mixer-panel><script src="/bundle.js"></script></body></html>"""
class H(BaseHTTPRequestHandler):
    protocol_version="HTTP/1.0"
    def log_message(self,*a): pass
    def _send(self,code,body,ct="application/json"):
        self.send_response(code); self.send_header("content-type",ct); self.send_header("Cache-Control","no-store"); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        p=self.path.split("?")[0]
        if p=="/": return self._send(200,PAGE,"text/html")
        if p=="/bundle.js": return self._send(200,urllib.request.urlopen(NODE+"/ui/bundle.js").read(),"text/javascript")
        if p=="/api/v1/nodes": return self._send(200,json.dumps([{"id":"stub-player-id","label":"StubPlayer"},{"id":"cam1","label":"Camera 1"},{"id":"cam2","label":"Camera 2"}]).encode())
        if p=="/api/v1/snapshots": return self._send(200,b"[]")
        m=re.match(r"/api/v1/nodes/test/params/(.+)",p)
        if m:
            try: return self._send(200,urllib.request.urlopen(NODE+"/params/"+m.group(1)).read())
            except Exception as e: return self._send(404,b"{}")
        if p=="/api/v1/nodes/test/stream/levelsUrl":
            url=json.load(urllib.request.urlopen(NODE+"/params/levelsUrl"))["value"]
            self.send_response(200); self.send_header("content-type","text/event-stream"); self.send_header("Cache-Control","no-cache"); self.end_headers()
            try:
                with urllib.request.urlopen(url) as r:
                    while True:
                        ln=r.readline()
                        if not ln: break
                        self.wfile.write(ln); self.wfile.flush()
            except Exception: pass
            return
        self._send(404,b"{}")
    def do_POST(self):
        n=int(self.headers.get("content-length") or 0); b=self.rfile.read(n)
        m=re.match(r"/api/v1/nodes/test/methods/(.+)",self.path)
        if m:
            req=urllib.request.Request(NODE+"/methods/"+m.group(1),data=b,headers={"Content-Type":"application/json"},method="POST")
            try: r=urllib.request.urlopen(req); return self._send(r.status,r.read())
            except urllib.error.HTTPError as e: return self._send(e.code,e.read())
        self._send(200,b"{}")
ThreadingHTTPServer(("127.0.0.1",int(os.environ.get("HARNESS_PORT","18080"))),H).serve_forever()
