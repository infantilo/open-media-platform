import os
OUT=os.path.dirname(os.path.abspath(__file__))
W,H=1920,1080
C=dict(bg="#ffffff",ink="#14213d",mute="#5c677d",line="#9aa5b8",
 blue="#2563eb",blueL="#e0eaff",teal="#0d9488",tealL="#d5f5f0",amber="#d97706",amberL="#fdecc8",
 red="#dc2626",redL="#fde2e2",violet="#7c3aed",violetL="#ece4ff",pink="#db2777",pinkL="#fce7f3",grey="#eef1f6")
def wrap(t,w,fs,k=0.56):
    n=max(8,int(w/(fs*k))); out=[]; cur=""
    for wd in t.split():
        if cur and len(cur)+1+len(wd)>n: out.append(cur); cur=wd
        else: cur=(cur+" "+wd).strip()
    if cur: out.append(cur)
    return out
def esc(s): return s.replace("&","&amp;").replace("<","&lt;")
class S:
    def __init__(s,title,sub):
        s.e=[]; s.title=title; s.sub=sub
        s.e.append(f'<rect width="{W}" height="{H}" fill="{C["bg"]}"/>')
        s.e.append(f'<text x="70" y="85" font-size="44" font-weight="700" fill="{C["ink"]}">{esc(title)}</text>')
        s.e.append(f'<text x="70" y="128" font-size="24" fill="{C["mute"]}">{esc(sub)}</text>')
        s.e.append(f'<rect x="70" y="146" width="120" height="5" rx="2" fill="{C["blue"]}"/>')
    def box(s,x,y,w,h,label,fill="grey",stroke=None,sub=None,fs=24,bold=True,dash=False,r=14,lines=None):
        st=stroke or ({"grey":C["line"]}.get(fill) or C[fill[:-1]])
        d=' stroke-dasharray="10 7"' if dash else ''
        s.e.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{C[fill]}" stroke="{st}" stroke-width="2.5"{d}/>')
        if not label and not sub: return
        sfs=int(fs*0.78)
        ll=wrap(label,w-24,fs,0.62 if bold else 0.56) if label else []
        sl=wrap(sub,w-28,sfs,0.56) if sub else []
        lh=fs*1.25; slh=sfs*1.3
        total=len(ll)*lh+(len(sl)*slh+6 if sl else 0)
        yy=y+h/2-total/2
        for t in ll:
            yy+=lh; s.e.append(f'<text x="{x+w/2}" y="{yy-lh*0.22}" text-anchor="middle" font-size="{fs}" font-weight="{700 if bold else 400}" fill="{C["ink"]}">{esc(t)}</text>')
        yy+=6
        for t in sl:
            yy+=slh; s.e.append(f'<text x="{x+w/2}" y="{yy-slh*0.22}" text-anchor="middle" font-size="{sfs}" fill="{C["mute"]}">{esc(t)}</text>')
    def para(s,cx,y,w,t,fs=20,color="ink"):
        for i,l in enumerate(wrap(t,w,fs,0.56)):
            s.e.append(f'<text x="{cx}" y="{y+i*fs*1.35}" text-anchor="middle" font-size="{fs}" fill="{C[color]}">{esc(l)}</text>')
    def band(s,x,y,w,h,label,color):
        s.e.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="18" fill="{C[color+"L"]}" fill-opacity="0.45" stroke="{C[color]}" stroke-width="2" stroke-dasharray="3 0"/>')
        s.e.append(f'<text x="{x+22}" y="{y+34}" font-size="23" font-weight="700" fill="{C[color]}" letter-spacing="1">{esc(label.upper())}</text>')
    def text(s,x,y,t,fs=22,color="ink",bold=False,anchor="start"):
        s.e.append(f'<text x="{x}" y="{y}" text-anchor="{anchor}" font-size="{fs}" font-weight="{700 if bold else 400}" fill="{C[color]}">{esc(t)}</text>')
    def arrow(s,x1,y1,x2,y2,color="ink",dash=False,w=3.5,label=None,both=False,lx=None,ly=None):
        d=' stroke-dasharray="11 8"' if dash else ''
        mid="url(#a_%s)"%color
        st=f' marker-start="url(#as_{color})"' if both else ''
        s.e.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{C[color]}" stroke-width="{w}"{d} marker-end="{mid}"{st}/>')
        if label:
            s.e.append(f'<text x="{lx if lx is not None else (x1+x2)/2}" y="{ly if ly is not None else (y1+y2)/2-10}" text-anchor="middle" font-size="20" fill="{C[color]}" font-weight="600">{esc(label)}</text>')
    def save(s,name):
        defs="<defs>"
        for k in ("ink","blue","teal","amber","red","violet","mute","pink"):
            defs+=f'<marker id="a_{k}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{C[k]}"/></marker>'
            defs+=f'<marker id="as_{k}" viewBox="0 0 10 10" refX="1.5" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M10,0 L0,5 L10,10 z" fill="{C[k]}"/></marker>'
        defs+="</defs>"
        s.e.append(f'<text x="{W-70}" y="{H-16}" text-anchor="end" font-size="17" fill="{C["mute"]}">OpenMediaPlatform · open architecture based on EBU DMF, MXL, NMOS, SMPTE ST 2110</text>')
        svg=f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="DejaVu Sans, Helvetica, Arial, sans-serif">{defs}'+"".join(s.e)+"</svg>"
        open(f"{OUT}/{name}.svg","w").write(svg)

# ---------- 1: layered architecture ----------
s=S("1 · Architecture at a glance","Every function is a replaceable node. The orchestrator knows no vendor and no node type, only standards.")
s.band(70,180,1780,150,"Operator layer","blue")
s.box(110,222,520,95,"Web UI shell","blueL",sub="role-scoped operator consoles in the browser",fs=24)
s.box(670,222,520,95,"Node UI fragments","blueL",sub="each node ships its own UI, loaded at runtime",fs=24)
s.box(1230,222,580,95,"Panels & hardware control","blueL",sub="touch consoles, control surfaces via gateways",fs=24)
s.band(70,350,1780,260,"Control plane (HA, no media passes through here)","teal")
s.box(110,400,360,170,"Orchestrator core","tealL",sub="registry · connections · lifecycle · placement · workflows",fs=26)
s.box(510,400,300,170,"Control framework","tealL",sub="NMOS IS-12/14: nodes self-describe parameters",fs=24)
s.box(850,400,300,170,"Event bus","tealL",sub="tally · alarms · state changes (durable streams)",fs=24)
s.box(1190,400,300,170,"Clustering","tealL",sub="consensus between orchestrators, replicated database",fs=24)
s.box(1530,400,280,170,"AuthN / AuthZ","tealL",sub="NMOS IS-10 · roles · audit",fs=24)
s.band(70,630,1780,200,"Media functions (nodes)","amber")
names=[("Players","playout, clips"),("Audio mixer","dynamic channels"),("Video mixer","M/E banks"),("Graphics","OGraf engine"),("Gateways","SRT / RIST / ST 2110"),("3rd-party nodes","same contract")]
x=110
for n,sb in names:
    s.box(x,680,265,115,n,"amberL" if n!="3rd-party nodes" else "violetL",stroke=None if n!="3rd-party nodes" else C["violet"],sub=sb,fs=23,dash=(n=="3rd-party nodes"))
    x+=282
s.band(70,850,1780,170,"Media exchange","violet")
bx=[(110,"MXL  ·  same host","zero-copy shared memory, no NIC, no encoding","violetL",C["violet"]),
    (545,"MXL Fabrics  ·  RDMA","host-to-host one-sided RDMA write (libfabric), lowest CPU load","pinkL",C["pink"]),
    (980,"SMPTE ST 2110  ·  LAN","uncompressed over IP, PTP (ST 2059)","violetL",C["violet"]),
    (1415,"SRT / RIST  ·  WAN & cloud","gateway node bridges 2110 inside the facility","violetL",C["violet"])]
for x0,t,sb,f,st in bx: s.box(x0,895,400,105,t,f,stroke=st,sub=sb,fs=22)
s.arrow(960,310,960,400,"blue",both=True); s.arrow(960,570,960,680,"teal",both=True,dash=True)
s.text(985,368,"REST / SSE",20,"blue",True); s.text(985,640,"IS-04/05/12/14, commands",20,"teal",True)
s.arrow(1000,795,1000,895,"violet",both=True)
s.save("1-architecture-overview")

# ---------- 2: control plane vs media plane across hosts ----------
s=S("2 · Control plane and media plane are separate","Orchestrators steer; media flows node-to-node. Losing an orchestrator never interrupts a picture.")
s.band(70,180,1780,310,"Control plane (3 orchestrators, one active leader, state replicated)","teal")
for i,(lab,sub) in enumerate([("Orchestrator A","leader"),("Orchestrator B","follower"),("Orchestrator C","follower")]):
    s.box(130+i*330,235,290,110,lab,"tealL",sub=sub,fs=26)
s.box(130,375,950,85,"Replicated database  ·  workflows, instances, role state, audit","tealL",stroke=C["teal"],fs=22)
s.arrow(275,345,275,375,"teal"); s.arrow(605,345,605,375,"teal"); s.arrow(935,345,935,375,"teal")

s.box(1140,235,330,225,"Event bus","tealL",sub="durable streams, replicated",fs=26)
s.box(1500,235,310,225,"NMOS registry","tealL",sub="IS-04 discovery, IS-05 connections, IS-12/14 control",fs=24)
s.arrow(1080,300,1140,300,"teal",both=True)
# hosts
hy=560
for i,(lab) in enumerate(["Host 1","Host 2","Host 3  (cloud / remote)"]):
    x=70+i*600
    s.band(x,hy,570,330,lab,"amber")
    s.box(x+30,hy+55,510,62,"Host agent","amberL",sub="starts / stops nodes, reports inventory + load",fs=22)
    s.box(x+30,hy+140,150,90,"Node","amberL",fs=22); s.box(x+210,hy+140,150,90,"Node","amberL",fs=22); s.box(x+390,hy+140,150,90,"Node","amberL",fs=22)
    if i<2:
        s.arrow(x+105,hy+230,x+105,hy+285,"violet",both=True,w=5); s.arrow(x+285,hy+230,x+285,hy+285,"violet",both=True,w=5); s.arrow(x+465,hy+230,x+465,hy+285,"violet",both=True,w=5)
        s.box(x+30,hy+285,510,34,"MXL domain (shared memory)","violetL",fs=18,r=8)
    else:
        s.arrow(x+105,hy+230,x+105,hy+285,"violet",both=True,w=5); s.arrow(x+285,hy+230,x+285,hy+285,"violet",both=True,w=5); s.arrow(x+465,hy+230,x+465,hy+285,"violet",both=True,w=5)
        s.box(x+30,hy+285,510,34,"MXL domain (shared memory)","violetL",fs=18,r=8)
for i in range(3):
    x=70+i*600+450
    s.arrow(x,490,x,hy+55,"teal",dash=True,w=3)
s.text(820,530,"commands + telemetry (dashed)",20,"teal",True,"middle")
for gx0,gx1 in ((610,700),(1210,1270)):
    pass
s.arrow(615,hy+291,695,hy+291,"pink",both=True,w=3); s.text(655,hy+270,"RDMA",15,"pink",True,"middle")
s.arrow(615,hy+311,695,hy+311,"violet",both=True,w=3)
s.arrow(1215,hy+302,1265,hy+302,"violet",both=True,w=3,dash=True)
ly0=935
s.arrow(70,ly0,190,ly0,"pink",both=True,w=3); s.text(215,ly0+7,"MXL Fabrics: one-sided RDMA write between hosts (RoCEv2 / libfabric), for uncompressed UHD at minimal CPU cost",21,"ink")
s.arrow(70,ly0+42,190,ly0+42,"violet",both=True,w=3); s.text(215,ly0+49,"SMPTE ST 2110 / 2022-7 over the LAN (PTP time)",21,"ink")
s.arrow(70,ly0+84,190,ly0+84,"violet",both=True,w=3,dash=True); s.text(215,ly0+91,"SRT / RIST over WAN and to cloud hosts",21,"ink")
s.text(1850,1030,"Dashed teal = control. Nothing in the teal layer ever carries media.",19,"mute",False,"end")
s.save("2-control-vs-media-plane")

# ---------- 3: resilience ----------
s=S("3 · Failure handling: make-before-break wherever possible","A problem with a node, a host or an orchestrator is solved by moving work, not by stopping the programme.")
cases=[("Node crash","Host agent / launcher sees the exit","Restart with back-off · state re-applied · connections re-wired","short gap (seconds) unless a standby exists","amber"),
 ("Hot standby","Standby runs in parallel, same inputs","Switch on loss or on demand · standby rebuilt afterwards","near-zero gap","teal"),
 ("Planned move / maintenance","Operator drains a host or moves a node","New instance started first · state copied · outputs switched · old one stopped last","no gap (make-before-break), roll back on failure","blue"),
 ("Host failure","No telemetry for 45 s (not for a planned goodbye)","Roles relocate to another host by placement rules · old instance fenced off, stopped when host returns","gap = detection time + start","red")]
y=180
for lab,det,act,res,col in cases:
    s.box(70,y,290,180,lab,col+"L",stroke=C[col],fs=26)
    s.box(400,y,420,180,"Detect","grey",stroke=C[col],sub=det,fs=24)
    s.box(850,y,620,180,"Act","grey",stroke=C[col],sub=act.replace(" · ","; "),fs=24)
    s.box(1500,y,350,180,"Result","grey",stroke=C[col],sub=res,fs=24)
    s.arrow(360,y+90,400,y+90,col,w=3); s.arrow(820,y+90,850,y+90,col,w=3); s.arrow(1470,y+90,1500,y+90,col,w=3)
    y+=205
s.text(70,1030,"Orchestrator failure: another orchestrator takes over (consensus); running nodes keep running and are re-adopted. Media never depends on the control plane.",19,"mute")
s.save("3-failure-handling")

# ---------- 4: make-before-break timeline ----------
s=S("4 · Make-before-break migration of a live node","The old instance keeps producing until the new one is proven ready. Only then is the output switched.")
s.text(70,200,"Time →",22,"mute",True)
lanes=[("Host 1\nold instance",260,"amber"),("Host 2\nnew instance",420,"teal"),("Downstream\nreceiver",580,"blue"),("Orchestrator",740,"violet")]
for lab,y,col in lanes:
    s.box(70,y,230,110,lab.split("\n")[0],col+"L",stroke=C[col],sub=lab.split("\n")[1] if "\n" in lab else None,fs=24)
    s.e.append(f'<line x1="330" y1="{y+55}" x2="1850" y2="{y+55}" stroke="{C["line"]}" stroke-width="2" stroke-dasharray="4 8"/>')
# bars
s.box(330,285,1230,60,"on air","amberL",stroke=C["amber"],fs=22,r=10)
s.box(330,285+0,0,0,"","grey") if False else None
s.box(560,445,1000,60,"start → restore state → media-ready","tealL",stroke=C["teal"],fs=21,r=10)
s.box(1560,445,290,60,"on air","tealL",stroke=C["teal"],fs=22,r=10)
s.box(330,605,1230,60,"receives old instance","blueL",stroke=C["blue"],fs=22,r=10)
s.box(1560,605,290,60,"receives new","blueL",stroke=C["blue"],fs=22,r=10)
steps=[(560,"1 · choose target host"),(870,"2 · start new instance"),(1250,"3 · copy parameter state"),(1560,"4 · switch connection")]
for x,t in steps:
    s.arrow(x,770,x,700,"violet",w=3)
    s.text(x,826,t,20,"violet",True,"middle")
s.arrow(1560,345,1560,420,"red",dash=True,w=3); s.text(1590,385,"5 · stop old instance",20,"red",True)
s.box(70,880,1780,140,"If any step fails: the new instance is torn down and the old one carries on. No half-state on air.","grey",stroke=C["line"],fs=26,bold=False)
s.text(960,1000,"Gate: the switch happens only after the new node reports 'media ready' (it actually produces / consumes media).",22,"mute",False,"middle")
s.save("4-make-before-break")

# ---------- 5: third-party integration ----------
s=S("5 · How a third-party MXL / DMF-compatible product joins","Same contract as our own nodes: register, describe, exchange media over MXL or ST 2110. No fork, no special code.")
s.band(70,180,1000,520,"Third-party product","violet")
s.box(110,235,920,95,"Product core, e.g. a software audio mixer or a vision engine","violetL",stroke=C["violet"],fs=24,dash=True)
s.box(110,355,290,150,"1 · Register","violetL",stroke=C["violet"],sub="NMOS IS-04",fs=24)
s.box(425,355,290,150,"2 · Describe","violetL",stroke=C["violet"],sub="NMOS IS-12/14",fs=24)
s.box(740,355,290,150,"3 · Media I/O","violetL",stroke=C["violet"],sub="MXL, ST 2110, optional RDMA",fs=24)
s.box(110,540,920,125,"Optional: UI bundle + manifest","violetL",stroke=C["violet"],fs=24,sub="orchestrator loads it into the operator console")
s.band(1130,180,720,520,"OpenMediaPlatform","teal")
s.box(1170,235,640,95,"Orchestrator","tealL",fs=26,sub="discovers, connects, monitors, places")
s.box(1170,355,640,95,"Generic control UI","tealL",fs=24,sub="built automatically from the IS-12/14 description")
s.box(1170,475,640,95,"Placement, failover, migration","tealL",fs=24,sub="applies to the product like to any node")
s.box(1170,595,640,80,"Existing nodes: players, mixers, gateways","amberL",fs=22,stroke=C["amber"])
s.arrow(1030,400,1170,282,"teal",both=True,w=3.5)
s.arrow(1030,430,1170,402,"teal",both=True,w=3.5)
s.arrow(1030,480,1170,635,"violet",both=True,w=5)
s.text(1490,722,"violet = media   ·   teal = control",19,"mute",True,"middle")
s.box(70,730,1780,70,"Integration depth — the vendor chooses, each level already gives value","grey",fs=24,bold=True)
lv=[("Level A","Register + MXL / 2110","Appears in the registry, can be routed and monitored. Drop-in for any workflow.","amber"),
    ("Level B","+ control description","Orchestrator and consoles control it without vendor-specific code.","teal"),
    ("Level C","+ placement / state contract","Export / import state and media-ready signal: can be moved and failed over without a gap.","blue")]
for i,(a,b,c,col) in enumerate(lv):
    x=70+i*600
    s.box(x,820,580,200,"",col+"L",stroke=C[col]); s.text(x+290,865,a+" · "+b,25,"ink",True,"middle")
    s.para(x+290,920,520,c,21)
s.save("5-third-party-integration")

# ---------- 6: why ----------
s=S("6 · Why this design: from appliances to orchestrated functions","What a broadcaster and a vendor each gain from the common contract.")
s.box(70,190,540,230,"Today: appliance chain","redL",stroke=C["red"],fs=30,sub="fixed function per box, SDI cabling, fixed capacity, vendor-specific control, 1+1 hardware for every redundancy")

s.arrow(620,305,780,305,"ink",w=6)
s.box(790,190,1060,230,"Dynamic media facility","tealL",stroke=C["teal"],fs=30,sub="functions start where capacity exists; media is shared on the same host or over IP; one control model for all; redundancy by software where it matters")
cols=[("Open exchange","MXL, ST 2110 and RDMA fabrics: any function that implements them can connect to any other","violet"),
      ("Self-describing nodes","IS-04 / IS-12/14: no per-vendor control code, no orchestrator release","teal"),
      ("Replaceable parts","swap or add a function without touching the rest; no lock-in","blue"),
      ("Elastic resources","place, move and scale across on-prem and cloud hosts","amber")]
for i,(a,b,col) in enumerate(cols):
    x=70+i*450
    s.box(x,470,425,200,"",col+"L",stroke=C[col]); s.text(x+212,515,a,27,"ink",True,"middle")
    s.para(x+212,575,390,b,21)
s.box(70,710,880,290,"","grey",stroke=C["line"]); s.text(100,760,"For broadcasters",29,"ink",True)
for k,t in enumerate(["• Pick best-of-breed per function, mix vendors","• Run 24/7 and maintain without taking programme off air","• Reuse hardware across studios, events and cloud","• Plan capacity over time, not for the peak of every box"]):
    s.text(100,815+k*46,t,23,"ink")
s.box(970,710,880,290,"","grey",stroke=C["line"]); s.text(1000,760,"For vendors",29,"ink",True)
for k,t in enumerate(["• One integration surface instead of one per customer","• Sell the function (software), not only the box","• Start at Level A, move up to Level C when ready","• Compete on quality of the function, not on lock-in"]):
    s.text(1000,815+k*46,t,23,"ink")
s.save("6-why-open-contract")

# ---------- 7: media path selection ----------
s=S("7 · Choosing the media path between two functions","One rule set, applied automatically at placement time. The signal is never lost: acceleration is optional, a fallback always exists.")
s.box(70,190,420,120,"Two functions\nneed to exchange media".split("\n")[0],"grey",stroke=C["ink"],sub="two functions need to exchange media",fs=28)
q=[(560,"Same host?","yes","MXL shared memory","zero-copy, no NIC, no encoding","violet"),
   (560,"Same RDMA-capable fabric segment?","yes","MXL Fabrics over RDMA","RoCEv2 / EFA, one-sided write, lowest CPU load; reserved like an I/O card","pink"),
   (560,"Same LAN with multicast and PTP?","yes","SMPTE ST 2110 / 2022-7","uncompressed, PTP time, redundant paths","violet"),
   (560,"Otherwise (WAN, cloud, no multicast)","","SRT / RIST via gateway node","unicast, FEC; 2110 stays inside the facility","amber")]
y=200
for i,(x0,qq,yn,res,sb,col) in enumerate(q):
    yy=190+i*190
    s.box(560,yy,520,120,qq,"grey",stroke=C["ink"],fs=26)
    s.box(1280,yy,570,120,res,col+"L",stroke=C[col],sub=sb,fs=26)
    s.arrow(1080,yy+60,1280,yy+60,col,w=5,label=(yn or "else"),ly=yy+48)
    if i<3:
        s.arrow(820,yy+120,820,yy+190,"ink",w=4); s.text(840,yy+162,"no",21,"mute",True)
s.arrow(490,250,560,250,"ink",w=4)
s.box(70,350,420,330,"","blueL",stroke=C["blue"])
s.text(280,395,"Fallback is soft",26,"ink",True,"middle")
s.para(280,435,380,"If an accelerated path cannot be provided at placement time, the connection falls back to the next option automatically, with an advisory. The programme is never stopped for lack of acceleration.",21)
s.box(70,710,420,250,"","grey",stroke=C["line"])
s.text(280,752,"Status",24,"ink",True,"middle")
s.para(280,790,380,"RDMA path implemented on the libfabric software provider and verified end to end. Validation on RoCEv2 hardware is planned.",20,"mute")
s.save("7-media-path-selection")

# ---------- 8: what each system asks ----------
s=S("8 · Kubernetes and a media facility ask different questions","Kubernetes is excellent at the first column. A live facility lives in the second. The gap is why we do not simply adopt it.")
s.band(70,180,840,360,"What Kubernetes' scheduler knows","blue")
s.band(1010,180,840,360,"What a live media facility must know","teal")
kq=["Which node has 2 CPU and 4 GB free?","Is the pod ready (probe passed)?","Are N replicas running?","Which pods belong to one service?"]
mq=["Which functions exchange media: can they share one host?","What is on air right now, may it be touched?","Is there PTP + multicast, or an RDMA path, to the other host?","Can the replacement take over without a visible glitch?"]
for i,t in enumerate(kq):
    s.box(100+(i%2)*400,230+(i//2)*150,380,125,t,"blueL",stroke=C["blue"],fs=22,bold=False)
for i,t in enumerate(mq):
    s.box(1040+(i%2)*400,230+(i//2)*150,380,125,t,"tealL",stroke=C["teal"],fs=22,bold=False)
s.arrow(915,360,1005,360,"red",w=6,dash=True)
s.text(960,335,"gap",22,"red",True,"middle")
s.text(960,580,"Three ways to close the gap",28,"ink",True,"middle")
opts=[("A · Kubernetes as is","blue","Generic placement and restarts. Media locality, on-air state and glitch-free hand-over are not part of its model. Fine for non-live services (databases, web UI, batch jobs)."),
      ("B · Kubernetes + our media layer","amber","We would still build the operator, NMOS glue, state hand-over and a scheduler extension. Result: two control planes to run and keep consistent."),
      ("C · Media-aware orchestrator (today)","teal","One control plane that already speaks NMOS and knows flows, roles and on-air state. A thin host agent starts the processes. Kubernetes stays possible as a runner backend.")]
for i,(a,col,b) in enumerate(opts):
    x=70+i*600
    s.box(x,620,580,300,"",col+"L",stroke=C[col]); s.text(x+290,670,a,26,"ink",True,"middle")
    s.para(x+290,725,520,b,22)
s.save("8-kubernetes-question-gap")

# ---------- 9: honest comparison ----------
s=S("9 · Kubernetes vs. our approach: an honest comparison","Kubernetes wins where it is general and mature. We win where live media needs specific knowledge. We pay for it in maturity.")
cx=[70,390,970,1550]; cw=[300,560,560,300]
hd=["Topic","Kubernetes","OpenMediaPlatform","Verdict"]
for x,w,t,col in zip(cx,cw,hd,["ink","blue","teal","ink"]):
    s.e.append(f'<rect x="{x}" y="180" width="{w}" height="46" rx="10" fill="{C["grey"] if col=="ink" else C[col+"L"]}" stroke="{C["line"] if col=="ink" else C[col]}" stroke-width="2"/>')
    s.text(x+w/2,211,t,24,"ink",True,"middle")
rows=[("General scheduling, bin-packing","Mature, rich policies, proven on thousands of nodes","Own placement scorer: CPU, RAM, GPU plus media locality; sized for tens of hosts","K","Kubernetes ahead"),
 ("Media awareness","Knows containers and resources. No flows, no on-air state, no MXL domain","Placement knows who exchanges media with whom and what is on air","O","We are ahead"),
 ("Self-healing","Restarts pods, reschedules on node loss; generic and very well tested","Restart, re-wire, re-apply state; lost host: standalone instances move automatically","E","Even: theirs better tested"),
 ("Moving a running function","Rolling update: new pod up, old pod down. No state hand-over, no media-ready cue","Make-before-break: state export / import, media-ready signal, then switch","O","We are ahead for live media"),
 ("Same-host media exchange","Pods are isolated; sharing memory across pods needs workarounds and co-location rules","MXL shared memory between nodes on one host, zero-copy; placement keeps pairs together","O","We are ahead"),
 ("Multicast, PTP, RDMA networks","Possible with secondary CNI, SR-IOV, device plugins; real effort to set up and keep stable","Host NICs used directly; RDMA path reserved like an I/O card; fewer layers","D","Depends: Kubernetes can, with effort"),
 ("Ecosystem, maturity","Huge: tooling, operators, managed services, audits, documentation, hiring pool","Small and ours alone: we maintain scheduler, updates and hardening","K","Kubernetes clearly ahead"),
 ("Scale and elasticity","Autoscaling, cluster tooling, cloud-native at any size","Hosts can be added incl. cloud; far less proven; not meant for thousands of nodes","K","Kubernetes ahead"),
 ("Operating effort, 2 to 5 hosts","etcd, CNI, ingress, certificates, upgrades: a skill set of its own","Orchestrator + host agent + message bus + database under systemd: still several parts, fewer layers","O","We are ahead, modestly")]
vc={"K":("blue","blueL"),"O":("teal","tealL"),"E":("line","grey"),"D":("amber","amberL")}
for i,(a,b,c,v,vt) in enumerate(rows):
    y=236+i*86
    for x,w,t,fillc,bold in ((cx[0],cw[0],a,"grey",True),(cx[1],cw[1],b,"grey",False),(cx[2],cw[2],c,"grey",False)):
        s.e.append(f'<rect x="{x}" y="{y}" width="{w}" height="78" rx="10" fill="{C["grey"]}" stroke="{C["line"]}" stroke-width="1.5"/>')
        fs=21 if bold else 19
        ls=wrap(t,w-24,fs,0.58 if bold else 0.55)[:3]
        yy=y+39-(len(ls)-1)*fs*0.65+fs*0.35
        for j,l in enumerate(ls): s.text(x+14,yy+j*fs*1.3,l,fs,"ink",bold)
    st,fl=vc[v]
    s.e.append(f'<rect x="{cx[3]}" y="{y}" width="{cw[3]}" height="78" rx="10" fill="{C[fl]}" stroke="{C[st]}" stroke-width="2.5"/>')
    ls=wrap(vt,cw[3]-24,20,0.6)[:3]
    yy=y+39-(len(ls)-1)*13+7
    for j,l in enumerate(ls): s.text(cx[3]+cw[3]/2,yy+j*26,l,20,"ink",True,"middle")
s.save("9-kubernetes-comparison")

# ---------- 10: costs, triggers, door stays open ----------
s=S("10 · What our choice costs, and when we would revisit it","Not a religious decision: a trade-off for today's target (24/7 broadcast centres, tens of hosts) that the design keeps reversible.")
s.box(70,190,880,330,"","redL",stroke=C["red"]); s.text(100,238,"What our choice costs us",29,"ink",True)
for k,t in enumerate(["• We maintain scheduler, updater and hardening ourselves","• Fewer eyes and less field time than a widely used platform","• Smaller hiring pool; operators must learn a new tool","• Large-scale and autoscaling behaviour is unproven","• Integrations with generic cloud tooling are ours to build"]):
    s.text(100,290+k*42,t,22,"ink")
s.box(970,190,880,330,"","amberL",stroke=C["amber"]); s.text(1000,238,"Triggers to revisit the decision",29,"ink",True)
for k,t in enumerate(["• Cloud deployments of dozens of hosts with autoscaling","• A customer standardises on Kubernetes for all workloads","• Pods can share memory and media devices as a routine feature","• Our own scheduler becomes the bottleneck in operations","• A shared, maintained media operator appears in the community"]):
    s.text(1000,290+k*42,t,22,"ink")
s.text(960,572,"How the design keeps the door open",28,"ink",True,"middle")
s.band(70,590,1780,430,"The node contract stays identical, only the runner below it changes","teal")
s.box(110,640,520,100,"Orchestrator","tealL",sub="placement, workflows, connections, state",fs=26)
s.box(110,790,520,100,"Node contract","violetL",stroke=C["violet"],sub="IS-04/05, IS-12/14, state export / import",fs=26)
s.arrow(370,740,370,790,"teal",both=True)
s.box(700,640,540,100,"Runner: host agent","amberL",sub="starts processes and OCI images, reports load",fs=26)
s.box(1310,640,500,100,"Runner: Kubernetes (optional)","blueL",stroke=C["blue"],dash=True,sub="planned for cloud (k3s / managed)",fs=24)
s.arrow(630,690,700,690,"teal",w=4)
s.arrow(1240,690,1310,690,"ink",w=3,dash=True)
s.box(700,790,1110,100,"The same nodes, whichever runner starts them","amberL",stroke=C["amber"],sub="media-aware placement and make-before-break stay in the orchestrator",fs=24)
s.arrow(970,740,970,790,"amber",w=3); s.arrow(1560,740,1560,790,"blue",w=3,dash=True)
s.para(960,945,1600,"Rule of thumb we apply: generic services (databases, web, batch) may run on any platform, including Kubernetes. Live media functions are placed by something that knows the signal path.",22)
s.save("10-kubernetes-outlook")

# ---------- 11: what this PoC is and is not ----------
s=S("11 · What this proof of concept is, and what it is not","A working open reference for the DMF idea: strong for learning, experiments and development, not a drop-in for a certified plant.")
s.band(70,175,865,430,"What you can do with it","teal")
s.band(985,175,865,430,"What you should not rely on it for","red")
can=[("Experiment with MXL, NMOS and ST 2110 hands-on","flows, connections, timing on running software; no licence needed"),
     ("Develop your own functions as nodes","self-describing contract, node SDK, tutorial; try integration Level A, B and C"),
     ("Learn and teach the DMF idea end to end","control vs media plane, placement, failure handling: all visible"),
     ("Run small productions and lab set-ups","playout, mixing, graphics, recording, radio; read the open points first"),
     ("Audit and change everything","open source (Apache-2.0), standards first, no lock-in")]
cant=[("Replace a certified 24/7 plant today","short field record; several paths not yet run on real hardware"),
      ("Come with support, SLA or indemnity","no vendor behind it; no patent or codec licence coverage; no warranty"),
      ("Cover every format and device","no NDI gateway; capture cards not verified on hardware"),
      ("Claim certification","standards implemented and checked, but not formally certified"),
      ("Scale to hundreds of hosts or full MAM / traffic / ad","sized for tens of hosts; asset management, traffic and billing are out of scope")]
for i,(a,b) in enumerate(can):
    s.box(95,222+i*76,815,68,a,"tealL",stroke=C["teal"],sub=b,fs=22)
for i,(a,b) in enumerate(cant):
    s.box(1010,222+i*76,815,68,a,"redL",stroke=C["red"],sub=b,fs=22)
cx=[70,370,950,1530]; cw=[280,560,560,320]
for x,w,t,col in zip(cx,cw,["Dimension","Large commercial products","This proof of concept","Who is ahead"],["ink","amber","teal","ink"]):
    s.e.append(f'<rect x="{x}" y="630" width="{w}" height="40" rx="10" fill="{C["grey"] if col=="ink" else C[col+"L"]}" stroke="{C["line"] if col=="ink" else C[col]}" stroke-width="2"/>')
    s.text(x+w/2,658,t,22,"ink",True,"middle")
rows=[("Openness and standards","Mix of proprietary and standards-based parts; control often vendor-specific","Standards first (DMF, MXL, NMOS, ST 2110), open source, any node can join","P","PoC ahead"),
      ("Breadth of functions","Complete families: MAM, traffic, ad, QC, many codecs and devices","Core live functions plus some file tools; deliberately narrow","C","Commercial ahead"),
      ("Maturity and certification","Years in the field, certified, hardened, audited","Young; verified in lab and CI; open points documented","C","Commercial ahead"),
      ("Support and liability","Contracts, SLAs, indemnity, training, roadmap commitments","Community and own effort; you carry integration and responsibility","C","Commercial ahead"),
      ("Experimentation and development","Licensed, closed; sandbox on request, limited insight","Install on a normal Linux machine or VM, read and change the source","P","PoC ahead")]
for i,(a,b,c,v,vt) in enumerate(rows):
    y=678+i*68
    for x,w,t,bold in ((cx[0],cw[0],a,True),(cx[1],cw[1],b,False),(cx[2],cw[2],c,False)):
        s.e.append(f'<rect x="{x}" y="{y}" width="{w}" height="62" rx="10" fill="{C["grey"]}" stroke="{C["line"]}" stroke-width="1.5"/>')
        fs=21 if bold else 19
        ls=wrap(t,w-24,fs,0.58 if bold else 0.55)[:2]
        yy=y+31-(len(ls)-1)*fs*0.65+fs*0.35
        for j,l in enumerate(ls): s.text(x+14,yy+j*fs*1.3,l,fs,"ink",bold)
    st,fl=(("teal","tealL") if v=="P" else ("amber","amberL"))
    s.e.append(f'<rect x="{cx[3]}" y="{y}" width="{cw[3]}" height="62" rx="10" fill="{C[fl]}" stroke="{C[st]}" stroke-width="2.5"/>')
    s.text(cx[3]+cw[3]/2,y+39,vt,21,"ink",True,"middle")
s.save("11-poc-scope-vs-commercial")

# ---------- 12: how it is built ----------
s=S("12 · How it is built: instructions, decisions, verification","AI-assisted development under written rules: the owner decides, the assistant implements, every step must be checkable.")
s.band(70,175,890,525,"Where things are written","blue")
docs=[("CLAUDE.md","project rules, loaded every session, points to the other documents","blueL","blue"),
      ("ARCHITECTURE.md","what and why: standards, stack, node contract, phases  ·  4.6k lines","blueL","blue"),
      ("UMSETZUNG.md","how: steps with their checks, working rules, status checklist  ·  6.6k lines","tealL","teal"),
      ("docs/decisions.md","append-only log: each decision, options, reasons  ·  30.8k lines","amberL","amber"),
      ("docs/ (44 files)","feature designs, node contracts, manuals, norm assessments","greyL" if False else "grey","line"),
      ("Session memory (outside the repo)","pitfalls and the owner's standing rules, carried between sessions","violetL","violet")]
for i,(a,b,f,st) in enumerate(docs):
    s.box(95,222+i*79,840,71,a,f,stroke=C[st],sub=b,fs=22)
s.band(985,175,865,525,"One step per session","teal")
steps=[("1  Read","rules, the plan section for this step, the status checklist"),
       ("2  Do exactly one step","sized for one session; no features taken early"),
       ("3  Build","norm first (read the text, name the version), fewest dependencies"),
       ("4  Verify","the step's listed checks must pass; if not, fix, do not move on"),
       ("5  Record","tick the checklist, log decisions, update the manual"),
       ("6  Commit","message starts with the step ID; push only when the owner asks")]
for i,(a,b) in enumerate(steps):
    s.box(1010,222+i*65,815,58,a,"tealL",stroke=C["teal"],sub=b,fs=21)
s.box(1010,622,815,62,"Blocked or unclear?","amberL",stroke=C["amber"],sub="write 2 to 3 options with a recommendation; the owner decides",fs=21)
def bullets(x,y,w,items,fs=18):
    yy=y
    for t in items:
        ls=wrap(t,w-30,fs,0.55)
        for j,l in enumerate(ls):
            s.text(x,yy,("• " if j==0 else "   ")+l,fs,"ink"); yy+=fs*1.3
        yy+=6
for x,w,title,col,items in ((70,580,"Why several documents","blue",
   ["A model reads a limited window: small fixed rules, then only the section needed",
    "What/why, status and history change at different speeds",
    "The plan defines 'done' before work starts",
    "Append-only decisions keep provenance",
    "Cost: the documents grow large and need discipline"]),
  (670,580,"Every step must be verifiable","teal",
   ["Each step lists its checks before it starts",
    "About 3.9k automated tests (Go, Rust, Deno)",
    "Official AMWA NMOS test tool in CI",
    "Live run in the real stack; browser click-through for UI",
    "Untested paths are labelled 'not verified on hardware'"]),
  (1270,580,"Scale (measured 16 Nov 2026)","amber",
   ["About 430k lines incl. tests: Go 171k, Rust 138k, TypeScript/JS 113k",
    "1,385 commits since 3 July 2026",
    "Core documents: about 47k lines",
    "AI usage in the retained logs, 19 Oct to 16 Nov: 13.7k requests, 13.3M output tokens (earlier sessions not kept)"])):
    s.e.append(f'<rect x="{x}" y="725" width="{w}" height="295" rx="14" fill="{C[col+"L"]}" fill-opacity="0.5" stroke="{C[col]}" stroke-width="2"/>')
    s.text(x+20,762,title,24,"ink",True)
    bullets(x+20,800,w-20,items)
s.save("12-how-it-is-built")
