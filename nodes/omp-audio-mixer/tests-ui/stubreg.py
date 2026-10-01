import json
from http.server import BaseHTTPRequestHandler, HTTPServer
LOG='/tmp/claude-1000/stub_calls.log'
NODE={"id":"stub-player-id","version":"1:0","label":"StubPlayer","description":"","tags":{},"href":"","caps":{},"api":{"versions":["v1.3"],"endpoints":[]},"services":[],"clocks":[],"interfaces":[]}
class H(BaseHTTPRequestHandler):
    def _r(self):
        n=int(self.headers.get('content-length') or 0); b=self.rfile.read(n) if n else b''
        out=b'[]' if self.command=='GET' else (b or b'{}'); code=201 if self.command=='POST' else 200
        if self.command=='GET' and '/x-nmos/query/v1.3/nodes' in self.path: out=json.dumps([NODE]).encode()
        elif '/service-token' in self.path: out=b'{"token":"stub"}'; code=200
        elif self.command=='GET' and self.path.endswith('/descriptor'): out=json.dumps({"methods":[{"name":"play"},{"name":"stop"},{"name":"setRate"}]}).encode()
        elif '/api/v1/nodes/' in self.path and '/methods/' in self.path:
            open(LOG,'a').write(f"{self.path} {b.decode()} auth={self.headers.get('Authorization')}\n"); out=b'{"ok":true}'; code=200
        self.send_response(code); self.send_header('content-type','application/json'); self.end_headers(); self.wfile.write(out)
    do_GET=do_POST=do_PUT=do_DELETE=_r
    def log_message(self,*a): pass
HTTPServer(('127.0.0.1',18010),H).serve_forever()
