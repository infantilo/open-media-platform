# Zusatzgrafik 14 (nicht in der Praesentation): was die Normen nicht abdecken + tag-basiertes Schalten.
# Nutzt Hilfsklasse und Farben aus generate.py (alles vor Diagramm 1). THEME=dark -> ./dark/
import os
_src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "generate.py")).read()
exec(_src.split("# ---------- 1:")[0])

s = S("14 · What the standards do not cover", "Standards define parts and single connections. Our own bricks, led by the orchestrator, turn them into one working facility.")

# ---- A: own bricks ----
s.band(70, 175, 1780, 360, "Our own bricks: the gaps", "amber")
cols = [
 ("Placement", "which host runs which node, by load and network", "No standard decides where a function runs."),
 ("Workflows", "start, stop and save whole chains as one unit", "NMOS knows connections, not productions."),
 ("Make-before-break", "start the replacement, hand state over, then switch", "No standard moves a running function without a gap."),
 ("Roles and operating", "web shell, role-scoped consoles, rights, audit", "NMOS has no operator or rights model."),
 ("Gateways, host agent", "bridge SRT, SDI, ST 2110; start nodes", "Standards describe the wire, not the bridge."),
]
w, g, x0 = 330, 22, 91
for i, (a, b, c) in enumerate(cols):
    x = x0 + i * (w + g)
    s.box(x, 222, w, 120, a, "amberL", stroke=C["amber"], sub=b, fs=25)
    s.text(x + w / 2, 372, "GAP", 17, "amber", True, "middle")
    s.para(x + w / 2, 400, w - 20, c, 20, "mute")
s.box(110, 468, 1740 - 40, 52, "Underneath, only published standards: IS-04 · IS-05 · IS-12/14 · IS-10 · BCP-008 · MXL. No private contract between orchestrator and node.", "grey", stroke=C["line"], fs=21, bold=False)

# ---- B: tag-based switching ----
s.band(70, 555, 1780, 470, "Tag-based switching", "teal")
srcs = [("Studio camera · video", "role.program  video.camera"),
        ("Studio camera · audio", "role.program  audio.stereo"),
        ("Commentary mic · audio", "role.commentator  audio.stereo")]
snks = [("Monitor · audio in 1", "role.commentator"),
        ("Monitor · video in", "role.program"),
        ("Monitor · audio in 2", "role.program")]
pair = [(0, 1), (1, 2), (2, 0)]          # source row -> sink row
ys = [630 + i * 92 for i in range(3)]
s.text(325, 618, "SOURCES carry tags", 18, "mute", True, "middle")
s.text(1595, 618, "SINKS carry tags", 18, "mute", True, "middle")
for a, b in pair:                        # lines first, boxes on top
    s.arrow(540, ys[a] + 36, 1380, ys[b] + 36, "teal", w=4)
for i, (l, t) in enumerate(srcs): s.box(110, ys[i], 430, 72, l, "tealL", stroke=C["teal"], sub=t, fs=21)
for i, (l, t) in enumerate(snks): s.box(1380, ys[i], 430, 72, l, "tealL", stroke=C["teal"], sub=t, fs=21)
s.box(700, 640, 520, 250, "", "amberL", stroke=C["amber"])
s.text(960, 676, "Orchestrator matches", 24, "ink", True, "middle")
for i, t in enumerate(["1  same media type (video, audio, data)",
                       "2  a shared tag, e.g. role.commentator",
                       "3  media.* tags do not count",
                       "4  optional: leftovers one to one, in order"]):
    s.text(730, 722 + i * 34, t, 20, "ink")
s.text(960, 876, "then it makes the IS-05 connection", 19, "teal", True, "middle")
s.text(960, 906, "", 1)
# uses
s.text(110, 950, "The same rule is used in:", 20, "ink", True)
for i, t in enumerate(["X/Y panel: all ports of a node", "Bouquets: saved tag rule", "Playout: live source by tag", "Mixer: strip follows the tag"]):
    s.box(110 + i * 430, 962, 410, 46, t, "grey", stroke=C["line"], fs=19, bold=False)
s.text(1850 - 20, 1048 + 0, "", 1)
s.save("14-gaps-orchestrator-and-tags")
