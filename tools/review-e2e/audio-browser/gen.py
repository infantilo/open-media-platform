#!/usr/bin/env python3
"""Erzeugt die Testblöcke a/<spur>/<block>.wav im Zielverzeichnis (Argument 1); braucht ffmpeg."""
import struct, subprocess, sys, os
H = sys.argv[1]
def pcm(expr):
    return subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", expr, "-f", "s16le", "-acodec", "pcm_s16le", "-"], capture_output=True, check=True).stdout
def wav(p):
    return b"RIFF" + struct.pack("<I", 36 + len(p)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 2, 48000, 48000 * 4, 4, 16) + b"data" + struct.pack("<I", len(p)) + p
tracks = [pcm("aevalsrc='if(gte(t,1),0.5*sin(2*PI*1000*t),0)|if(gte(t,1),0.25*sin(2*PI*1000*t),0)':s=48000:d=12"),
          pcm("sine=frequency=300:sample_rate=48000:d=12,aformat=channel_layouts=stereo")]
per = 10 * 48000 * 4
for t, raw in enumerate(tracks):
    os.makedirs(f"{H}/a/{t}", exist_ok=True)
    for b in range(2):
        open(f"{H}/a/{t}/{b}.wav", "wb").write(wav(raw[b * per:(b + 1) * per]))
