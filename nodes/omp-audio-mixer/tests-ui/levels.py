
def levels(sec=1.0):
    s=socket.create_connection((host,int(port))); s.send(b"GET /levels HTTP/1.0\r\n\r\n"); s.setblocking(False)
    buf=b""; end=time.time()+sec
    while time.time()<end:
        r,_,_=select.select([s],[],[],.2)
        if r: buf+=s.recv(65536)
    s.close()
    out={}
    for m in buf.split(b"\n\n"):
        if m.startswith(b"data: "):
            d=json.loads(m[6:])
            if d.get("type")!="dsp": out[str(d["channelId"])]=round(d["rms"],3)
    return out
print("fresh:",levels())
for i in range(8): call("addChannel",{"label":f"c{i}"})
time.sleep(2); print("8 channels:",levels())
print(call("addAux",{"label":"Monitor","kind":"aux"})); time.sleep(1.5); print("after aux1:",levels())
print(call("addAux",{"label":"N1","kind":"n1"})); time.sleep(1.5); print("after aux2:",levels())
