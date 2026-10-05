#!/usr/bin/env python3
"""A/V-Versatz einer aufgenommenen MKV mit PCM-Ton messen (Marker-Quelle, s. docs/decisions.md
„A/V-Versatz"): Marker-Bild (ein weißes Bild je Sekunde) gegen Audio-Tick. Aufnahme mit
`OMP_RECORDER_RAW_AUDIO=1` (unkomprimierter Ton). Ton-Zeitpunkte werden aus den PACKET-Zeitstempeln
rekonstruiert, nicht aus dem zusammengeschobenen Rohstrom — sonst täuschen Zeitlücken im Ton
(z. B. beim Anlauf) einen Versatz vor (so entstand 2026-10-05 ein falscher „−47 ms"-Befund).
Aufruf: analyze_mkv.py <datei.mkv>   (benötigt ffmpeg/ffprobe)
"""
import re,array,subprocess,sys,bisect
import tempfile,os
S=tempfile.mkdtemp(prefix="avmarker-")+"/"
F=sys.argv[1]
raw=len(sys.argv)>2 and sys.argv[2]=="raw"
subprocess.run(f"ffmpeg -y -v error -i {F} -map 0:v -vf signalstats,metadata=print:key=lavfi.signalstats.YAVG:file={S}yavg.txt -f null -",shell=True)
subprocess.run(f"ffmpeg -y -v error -i {F} -map 0:a -ac 1 -f f32le {S}a.raw",shell=True)
ch=int(subprocess.run(f"ffprobe -v error -select_streams a -show_entries stream=channels -of csv=p=0 {F}",shell=True,capture_output=True,text=True).stdout.split()[0])
pk=[]
for l in subprocess.run(f"ffprobe -v error -select_streams a -show_entries packet=pts_time,size -of csv=p=0 {F}",shell=True,capture_output=True,text=True).stdout.split():
    t,sz=l.split(","); pk.append((float(t),int(sz)//(4*ch)))
starts=[];n=0
for t,c in pk: starts.append(n); n+=c
vt=[];cur=None
for l in open(S+"yavg.txt"):
    m=re.search(r"pts_time:([\d.]+)",l)
    if m: cur=float(m.group(1))
    m=re.search(r"YAVG=([\d.]+)",l)
    if m and cur is not None: vt.append((cur,float(m.group(1))))
thr=(max(y for _,y in vt)+min(y for _,y in vt))/2
flips=[t for (t,y),(t0,y0) in zip(vt[1:],vt) if y>thr and y0<=thr]
a=array.array('f'); a.frombytes(open(S+"a.raw","rb").read())
ticks=[];quiet=10**9
for i,x in enumerate(a):
    if abs(x)>0.05:
        if quiet>24000:
            k=bisect.bisect_right(starts,i)-1
            ticks.append(pk[k][0]+(i-starts[k])/48000)
        quiet=0
    else: quiet+=1
d=sorted(x for x in ((t-min(flips,key=lambda f:abs(f-t)))*1000 for t in ticks) if abs(x)<500)
gaps=sum(1 for (t0,c0),(t1,c1) in zip(pk,pk[1:]) if abs((t1-t0)-c0/48000)>0.003)
print(f"Datei: Marker-Bilder={len(flips)} Ticks={len(ticks)} Audio-Lücken={gaps} Median Ta-Tv = {d[len(d)//2]:.1f} ms" if d else "keine Daten")
import re,array,subprocess,sys,bisect
import tempfile,os
S=tempfile.mkdtemp(prefix="avmarker-")+"/"
F=sys.argv[1]
raw=len(sys.argv)>2 and sys.argv[2]=="raw"
subprocess.run(f"ffmpeg -y -v error -i {F} -map 0:v -vf signalstats,metadata=print:key=lavfi.signalstats.YAVG:file={S}yavg.txt -f null -",shell=True)
subprocess.run(f"ffmpeg -y -v error -i {F} -map 0:a -ac 1 -f f32le {S}a.raw",shell=True)
ch=int(subprocess.run(f"ffprobe -v error -select_streams a -show_entries stream=channels -of csv=p=0 {F}",shell=True,capture_output=True,text=True).stdout.split()[0])
pk=[]
for l in subprocess.run(f"ffprobe -v error -select_streams a -show_entries packet=pts_time,size -of csv=p=0 {F}",shell=True,capture_output=True,text=True).stdout.split():
    t,sz=l.split(","); pk.append((float(t),int(sz)//(4*ch)))
starts=[];n=0
for t,c in pk: starts.append(n); n+=c
vt=[];cur=None
for l in open(S+"yavg.txt"):
    m=re.search(r"pts_time:([\d.]+)",l)
    if m: cur=float(m.group(1))
    m=re.search(r"YAVG=([\d.]+)",l)
    if m and cur is not None: vt.append((cur,float(m.group(1))))
thr=(max(y for _,y in vt)+min(y for _,y in vt))/2
flips=[t for (t,y),(t0,y0) in zip(vt[1:],vt) if y>thr and y0<=thr]
a=array.array('f'); a.frombytes(open(S+"a.raw","rb").read())
ticks=[];quiet=10**9
for i,x in enumerate(a):
    if abs(x)>0.05:
        if quiet>24000:
            k=bisect.bisect_right(starts,i)-1
            ticks.append(pk[k][0]+(i-starts[k])/48000)
        quiet=0
    else: quiet+=1
d=sorted(x for x in ((t-min(flips,key=lambda f:abs(f-t)))*1000 for t in ticks) if abs(x)<500)
gaps=sum(1 for (t0,c0),(t1,c1) in zip(pk,pk[1:]) if abs((t1-t0)-c0/48000)>0.003)
print(f"Datei: Marker-Bilder={len(flips)} Ticks={len(ticks)} Audio-Lücken={gaps} Median Ta-Tv = {d[len(d)//2]:.1f} ms" if d else "keine Daten")
