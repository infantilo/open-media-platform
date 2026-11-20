# Zusatzgrafik 15: TAMS (Time-addressable Media Store, API 8.2) in der Plattform umgesetzt (Kapitel 105).
# Nutzt Hilfsklasse und Farben aus generate.py. THEME=dark -> ./dark/. PNG/PDF: siehe render-15.sh
import os
_src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "generate.py")).read()
exec(_src.split("# ---------- 1:")[0])

s = S("15 · TAMS implemented: record, replay and time-shift",
      "The platform speaks the Time-addressable Media Store API, version 8.2, as a client. Live MXL flows go into the store on a TAI timeline.")

# ---- A: data path ----
s.band(70, 175, 1780, 400, "Data path", "blue")
s.box(110, 235, 300, 110, "Live source", "grey", sub="MXL video and audio flows, TAI time", fs=25)
s.box(500, 215, 360, 150, "TAMS recorder", "tealL", stroke=C["teal"], sub="H.264 / AAC, GOP-aligned segments, one flow per essence, disk queue", fs=27)
s.box(950, 215, 380, 320, "TAMS store", "blueL", stroke=C["blue"], sub="API 8.2. Source > Flow > Segment > Object. Time ranges instead of file names. Objects immutable, reference-counted. Init segments for fragmented MP4.", fs=29)
s.box(1420, 215, 390, 90, "Replay and time-shift", "tealL", stroke=C["teal"], sub="range, 'N seconds ago', follow with delay", fs=24)
s.box(1420, 330, 390, 90, "Clip export", "tealL", stroke=C["teal"], sub="MP4, MKV, TS, MOV; lossless or frame-exact", fs=24)
s.box(1420, 445, 390, 90, "Retention worker", "tealL", stroke=C["teal"], sub="segments, flows, empty flows (AppNote 0019)", fs=24)
s.box(110, 410, 750, 125, "Recording schedule", "amberL", stroke=C["amber"], sub="target 'tams': one metadata copy per show (same objects, no media moved) plus a library reference asset", fs=26)

s.arrow(410, 290, 498, 290, "ink")
s.arrow(860, 290, 948, 290, "teal", w=4.5, label="segments", ly=268)
s.arrow(485, 410, 600, 367, "amber", dash=True)
s.arrow(860, 480, 948, 480, "amber", dash=True, label="copy", ly=458)
s.arrow(1330, 260, 1418, 260, "blue", both=True)
s.arrow(1330, 375, 1418, 375, "blue")
s.arrow(1330, 490, 1418, 490, "blue", both=True)
s.text(1810, 562, "Replay returns as MXL flows to mixer and viewer", 19, "mute", False, "end")

# ---- B: scope and status ----
s.band(70, 605, 1780, 430, "Scope and status", "teal")
feats = [("Time on TAI", "AppNote 0002, 0008. MXL index and timestamp convert bit-exact."),
         ("Independent segments", "AppNote 0005, 0010. Keyframe first, long-lived flows."),
         ("Init segments", "AppNote 0024. Fragmented MP4 with one reused init object."),
         ("Retention", "AppNote 0019. Tags, own worker node, tagged flows only."),
         ("Access", "ADR-0028. Bearer, Basic, URL token. TLS, secrets from file only."),
         ("In the platform", "Scheduled recording, panels, file transfer between hosts.")]
w, g = 270, 14
for i, (a, b) in enumerate(feats):
    x = 110 + (i % 3) * (w + g)
    y = 660 + (i // 3) * 175
    s.box(x, y, w, 160, a, "grey", sub=b, fs=22)
s.box(1010, 655, 380, 340, "", "tealL", stroke=C["teal"])
s.text(1200, 697, "VERIFIED", 21, "teal", True, "middle")
for i, t in enumerate(["Test server that enforces the spec rules", "The specification's own mock server, schemas checked",
                       "End to end with real sources and ffprobe", "Playback into a real MXL domain"]):
    for j, l in enumerate(wrap(t, 340, 20)):
        s.text(1030, 735 + i * 62 + j * 26, ("- " if j == 0 else "  ") + l, 20, "ink")
s.box(1420, 655, 390, 340, "", "amberL", stroke=C["amber"])
s.text(1615, 697, "STILL OPEN", 21, "amber", True, "middle")
for i, t in enumerate(["Run on a production store (partner with access wanted)", "Strict CMAF brands (cmafmux)",
                       "Load at 1080p50 and long-term operation", "Interoperability with other TAMS clients"]):
    for j, l in enumerate(wrap(t, 350, 20)):
        s.text(1440, 735 + i * 62 + j * 26, ("- " if j == 0 else "  ") + l, 20, "ink")
s.save("15-tams-implemented")
