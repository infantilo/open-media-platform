import os
OUT=os.path.dirname(os.path.abspath(__file__))
W,H=1920,1080
C=dict(bg="#ffffff",ink="#14213d",mute="#5c677d",line="#9aa5b8",
 blue="#2563eb",blueL="#e0eaff",teal="#0d9488",tealL="#d5f5f0",amber="#d97706",amberL="#fdecc8",
 red="#dc2626",redL="#fde2e2",violet="#7c3aed",violetL="#ece4ff",grey="#eef1f6")
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
        for k in ("ink","blue","teal","amber","red","violet","mute"):
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
s.band(70,850,1780,170,"Media exchange (the only place pictures and sound travel)","violet")
s.box(110,895,520,95,"MXL  ·  same host","violetL",sub="zero-copy shared memory, no NIC, no encoding",fs=26)
s.box(700,895,520,95,"SMPTE ST 2110 / 2022-7  ·  LAN","violetL",sub="uncompressed over IP, PTP time (ST 2059)",fs=26)
s.box(1290,895,520,95,"SRT / RIST  ·  WAN & cloud","violetL",sub="gateway node bridges 2110 inside the facility",fs=26)
s.arrow(960,310,960,400,"blue",both=True); s.arrow(960,570,960,680,"teal",both=True,dash=True)
s.text(985,368,"REST / SSE",20,"blue",True); s.text(985,640,"IS-04/05/12/14, commands",20,"teal",True)
s.arrow(1550,795,1550,895,"violet",both=True)
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
s.arrow(615,950,1215,950,"violet",both=True,w=6,label="SMPTE ST 2110 / 2022-7 between hosts",ly=935)
s.arrow(1215,985,1815,985,"violet",both=True,w=6,dash=True,label="SRT / RIST over WAN",ly=1010)
s.text(70,1010,"Solid violet = media.  Dashed teal = control.  Nothing in the teal layer ever carries media.",22,"mute")
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
    s.text(x,812,t,20,"violet",True,"middle")
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
s.box(740,355,290,150,"3 · Media I/O","violetL",stroke=C["violet"],sub="MXL flows / ST 2110",fs=24)
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
cols=[("Open exchange","MXL + ST 2110: any compliant function can connect to any other","violet"),
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
