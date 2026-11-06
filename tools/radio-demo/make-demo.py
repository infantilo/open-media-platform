#!/usr/bin/env python3
"""Erzeugt eine Radio-Demo: synthetische Musikclips (kein fremdes Material, keine Rechte) und ein Demo-Log für die
Radio-Automation (Titel, Jingles, Nachrichten-Platzhalter mit Intro-/Outro-Marken).

  python3 tools/radio-demo/make-demo.py [Zielordner]      (Standard: data/media/radio-demo, liegt in .gitignore)

Ergebnis: <Ziel>/*.wav und <Ziel>/demo-log.json — das Log im Bedienfeld der Radio-Automation über „JSON importieren" laden.
Nur Standardbibliothek; rechnet in reinem Python etwa 4 Minuten.
"""
import array, json, math, random, struct, sys, wave
from pathlib import Path

SR = 48_000
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / "data/media/radio-demo").resolve()
OUT.mkdir(parents=True, exist_ok=True)
NOTE = lambda n: 440.0 * 2 ** ((n - 69) / 12)

def write(name, left, right):
    path = OUT / name
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        buf = array.array("h")
        for l, r in zip(left, right):
            buf.append(max(-32767, min(32767, int(l * 32767)))); buf.append(max(-32767, min(32767, int(r * 32767))))
        w.writeframes(buf.tobytes())
    return int(len(left) / SR * 1000)

def song(name, bpm, root, minor, bars, seed):
    """Intro (2 Takte Bass + Schlagzeug), Hauptteil (Akkorde + Melodie), Ausklang (4 Takte ausdünnend, am Ende leise)."""
    rnd = random.Random(seed)
    beat = 60.0 / bpm; bar = 4 * beat; total = bars * bar
    n = int(total * SR)
    scale = [0, 2, 3, 5, 7, 8, 10] if minor else [0, 2, 4, 5, 7, 9, 11]
    prog = [0, 5, 3, 4] if minor else [0, 4, 5, 3]          # Stufen
    melody = [rnd.choice(range(14)) for _ in range(bars * 8)]
    L = [0.0] * n; R = [0.0] * n
    intro_bars, outro_bars = 2, 4
    for i in range(n):
        t = i / SR; b = t / bar; bi = int(b)
        deg = prog[bi % 4]
        chord = [root + scale[(deg + k) % 7] + 12 * ((deg + k) // 7) for k in (0, 2, 4)]
        ph = (t / beat) % 1.0
        kick = math.sin(2 * math.pi * (50 + 90 * math.exp(-ph * 14)) * ph * beat) * math.exp(-ph * 7) * 0.55
        hat = (rnd.random() * 2 - 1) * math.exp(-(((t / beat) * 2) % 1.0) * 22) * 0.10
        bass = math.sin(2 * math.pi * NOTE(chord[0] - 12) * t) * 0.30 * (0.7 + 0.3 * math.exp(-ph * 4))
        body = bi >= intro_bars and bi < bars - outro_bars
        pad = 0.0
        if bi >= intro_bars:
            pad = sum(math.sin(2 * math.pi * NOTE(c) * t) + 0.4 * math.sin(4 * math.pi * NOTE(c) * t) for c in chord) * 0.045
        mel = 0.0
        if body:
            k = int((t / beat) * 2); e = ((t / beat) * 2) % 1.0
            d = melody[k % len(melody)]; f = NOTE(root + 12 + scale[d % 7] + 12 * (d // 7))
            mel = (math.sin(2 * math.pi * f * t) + 0.3 * math.sin(6 * math.pi * f * t)) * math.exp(-e * 3.2) * 0.16
        # Ausklang: ab Beginn des Ausklangs Schlagzeug aus, Gesamtpegel sinkt
        into_outro = max(0.0, (t - (bars - outro_bars) * bar) / (outro_bars * bar))
        drums = (kick + hat) * (1.0 - min(1.0, into_outro * 1.6))
        env = (1.0 - 0.9 * into_outro ** 1.5) * min(1.0, t / 0.01)
        v = (drums + bass + pad + mel) * env * 0.9
        pan = 0.5 + 0.12 * math.sin(2 * math.pi * 0.2 * t)
        L[i] = v * (1.0 - 0.3 * pan) + mel * 0.1; R[i] = v * (0.7 + 0.3 * pan) - mel * 0.1
    dur = write(name, L, R)
    return dur, int(intro_bars * bar * 1000), int((bars - outro_bars) * bar * 1000)

def jingle(name):
    n = int(4.0 * SR); L = [0.0] * n; R = [0.0] * n
    notes = [72, 76, 79, 84, 88]
    for i in range(n):
        t = i / SR; v = 0.0
        for k, m in enumerate(notes):
            s = 0.18 * k; 
            if t >= s:
                e = t - s; v += (math.sin(2 * math.pi * NOTE(m) * t) + 0.35 * math.sin(4 * math.pi * NOTE(m) * t)) * math.exp(-e * 1.6) * 0.16
        sw = math.sin(2 * math.pi * (200 + 900 * min(1, t / 0.9)) * t) * math.exp(-t * 4) * 0.2
        L[i] = (v + sw) * min(1, (4 - t) * 4); R[i] = L[i]
    return write(name, L, R)

def talk(name, seconds):
    """Platzhalter für Gesprochenes: Silbenfolge aus Brummton mit Formanten (klingt nach Sprecher, ist keiner)."""
    rnd = random.Random(7); n = int(seconds * SR); L = [0.0] * n
    syl = 0.0; f0 = 110.0; form = (700, 1200); a = 0.0; nxt = 0.0
    for i in range(n):
        t = i / SR
        if t >= nxt:
            nxt = t + rnd.uniform(0.12, 0.28); f0 = rnd.uniform(95, 135); form = (rnd.uniform(400, 900), rnd.uniform(1100, 2300))
            a = 0.0 if rnd.random() < 0.12 else 1.0
        ph = (t * f0) % 1.0
        glottal = (ph * 2 - 1) * (1 - ph)
        v = glottal * (0.6 + 0.4 * math.sin(2 * math.pi * form[0] * t)) + 0.3 * glottal * math.sin(2 * math.pi * form[1] * t)
        gate = math.sin(math.pi * min(1.0, max(0.0, (nxt - t) / 0.2))) ** 0.5
        L[i] = v * 0.25 * a * gate * min(1, t / 0.05) * min(1, (seconds - t) / 0.2)
    return write(name, L, L[:])

songs = [("Morgenlicht", 96, 60, False, 28, 1), ("Nachtfahrt", 118, 57, True, 30, 2), ("Strandgut", 104, 64, False, 28, 3),
         ("Neonregen", 124, 62, True, 32, 4), ("Heimweg", 88, 55, False, 24, 5)]
info = {}
for title, bpm, root, minor, bars, seed in songs:
    fn = f"{title.lower()}.wav"; info[title] = (fn, *song(fn, bpm, root, minor, bars, seed)); print("  ", fn, info[title][1] // 1000, "s")
jd = jingle("jingle-sender.wav"); nd = talk("nachrichten-platzhalter.wav", 25); print("   jingle, nachrichten")

def item(i, kind, file, dur, title, intro=None, outro=None, block=None):
    d = {"id": i, "kind": kind, "file": str(OUT / file), "durationMs": dur, "somMs": 0, "introMs": intro, "outroMs": outro,
         "gainDb": 0.0, "optional": False, "fixAtUnixMs": None, "title": title}
    if block: d["block"] = block
    return d
S = lambda t: item(t.lower(), "song", info[t][0], info[t][1], t, info[t][2], info[t][3])
log = {"logId": "radio-demo", "items": [
    S("Morgenlicht"), item("jingle1", "jingle", "jingle-sender.wav", jd, "Senderjingle", None, jd - 500),
    S("Nachtfahrt"), S("Strandgut"),
    item("nachrichten", "speech", "nachrichten-platzhalter.wav", nd, "Nachrichten (Platzhalter)", block="Nachrichten"),
    item("jingle2", "jingle", "jingle-sender.wav", jd, "Senderjingle", None, jd - 500),
    S("Neonregen"), S("Heimweg")], "fillers": [], "blocks": []}
# Der zweite Übergang zeigt die Abweichung des Segue-Editors (RB7): kürzere, lineare Blende, früherer Einsatz.
log["items"][3]["transition"] = {"fadeOutMs": 2000, "fadeInMs": 1500, "curveOut": "linear", "curveIn": "linear", "startShiftMs": -500}
(OUT / "demo-log.json").write_text(json.dumps(log, indent=2, ensure_ascii=False))
print("Fertig:", OUT / "demo-log.json")
