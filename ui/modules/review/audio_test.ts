import { assertEquals } from "jsr:@std/assert@1";
import { audibleTracks, BLOCK_SEC, rateAudible, splitByBlocks } from "./audio.ts";

Deno.test("Blockzerlegung: Stücke enden an Blockgrenzen, nichts geht verloren", () => {
  assertEquals(splitByBlocks(1, 2), [{ block: 0, a: 1, b: 2 }]);
  assertEquals(splitByBlocks(9.95, 10.05), [{ block: 0, a: 9.95, b: 10 }, { block: 1, a: 10, b: 10.05 }]);
  assertEquals(splitByBlocks(10, 20), [{ block: 1, a: 10, b: 20 }]);
  assertEquals(splitByBlocks(5, 5), []);
  assertEquals(splitByBlocks(8, 31).map((p) => p.block), [0, 1, 2, 3]);
  const sum = splitByBlocks(3.3, 47.7).reduce((s, p) => s + (p.b - p.a), 0);
  assertEquals(Math.abs(sum - 44.4) < 1e-9, true);
  assertEquals(BLOCK_SEC, 10);
});

Deno.test("Spurwahl: Solo gewinnt gegen Stumm/An, ohne Solo zählt der Schalter", () => {
  assertEquals(audibleTracks([{ on: true, solo: false }, { on: false, solo: false }]), [true, false]);
  assertEquals(audibleTracks([{ on: true, solo: false }, { on: false, solo: true }]), [false, true]);
});

Deno.test("Tempo: Ton nur zwischen 0,25× und 4× (vorwärts wie rückwärts)", () => {
  assertEquals([0.25, 0.5, 1, 2, 4, -1, -4].map(rateAudible), [true, true, true, true, true, true, true]);
  assertEquals([0, 0.1, 8, -8, 5].map(rateAudible), [false, false, false, false, false]);
});

// ---- Planung gegen einen Mock-AudioContext (kein Hören, aber Zeit-/Offset-Rechnung exakt prüfbar) ----

interface Started { track: number; when: number; offset: number; dur: number; rate: number; reversed: boolean }

function mockAudio() {
  const started: Started[] = [];
  const fetched: string[] = [];
  const BLOCK = 10;
  class Param { value = 0; setTargetAtTime(v: number) { this.value = v; } cancelScheduledValues() {} setValueAtTime() {} linearRampToValueAtTime() {} }
  class Gain { gain = new Param(); tag = ""; connect(n: unknown) { (this as unknown as { to: unknown }).to = n; } disconnect() {} }
  const buffers = new WeakMap<object, { reversed: boolean }>();
  class Src {
    buffer: { reversed: boolean; duration: number } | null = null;
    playbackRate = { value: 1 };
    to: unknown;
    connect(n: unknown) { this.to = n; }
    disconnect() {}
    stop() {}
    start(when: number, offset: number, dur: number) {
      // Spur herausfinden: Quelle → Spur-Gain; der Spur-Gain trägt `track`
      started.push({ track: (this.to as { track?: number }).track ?? (this.to as { to?: { track?: number } }).to?.track ?? -1, when, offset, dur, rate: this.playbackRate.value, reversed: this.buffer?.reversed ?? false });
    }
  }
  const ctx = {
    currentTime: 100,
    state: "running",
    destination: {},
    resume() { return Promise.resolve(); },
    close() { return Promise.resolve(); },
    createGain() { const g = new Gain(); return g; },
    createBufferSource() { return new Src(); },
    createBuffer(ch: number, len: number) {
      const data = Array.from({ length: ch }, () => new Float32Array(len));
      const b = { reversed: true, duration: BLOCK, numberOfChannels: ch, length: len, sampleRate: 48000, getChannelData: (c: number) => data[c] };
      buffers.set(b, { reversed: true });
      return b;
    },
    decodeAudioData(_ab: ArrayBuffer) {
      const len = 48000 * BLOCK;
      const data = [new Float32Array(len), new Float32Array(len)];
      return Promise.resolve({ reversed: false, duration: BLOCK, numberOfChannels: 2, length: len, sampleRate: 48000, getChannelData: (c: number) => data[c] });
    },
  };
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = function () { return ctx; } as unknown;
  (globalThis as unknown as { fetch: unknown }).fetch = (u: string) => {
    fetched.push(u);
    return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
  };
  return { ctx, started, fetched, Gain };
}

import { ReviewAudio } from "./audio.ts";

Deno.test("Engine vorwärts: lückenlose, überlappungsfreie Stücke über die Blockgrenze, passende Zeiten und Offsets", async () => {
  const m = mockAudio();
  const a = new ReviewAudio({ tracks: 1, durationSec: 60, urlFor: (t, b) => `/a/${t}/${b}` });
  a.unlock();
  a.prefetch(8.0);
  await new Promise((r) => setTimeout(r, 20)); // Blöcke dekodiert
  a.start(8.0, 1);
  for (let i = 0; i < 14; i++) { // Uhr in Schritten vorstellen (ein großer Sprung gälte als Aussetzer und würde übersprungen)
    m.ctx.currentTime += 0.2;
    await new Promise((r) => setTimeout(r, 45));
  }
  const s = m.started.sort((x, y) => x.when - y.when);
  if (s.length < 2) throw new Error("zu wenige Stücke: " + JSON.stringify(s));
  // Stücke schließen lückenlos aneinander: Ende des einen (when + dur/rate) = Anfang des nächsten
  for (let i = 1; i < s.length; i++) {
    const end = s[i - 1].when + s[i - 1].dur / s[i - 1].rate;
    if (Math.abs(end - s[i].when) > 1e-6) throw new Error(`Lücke/Überlappung bei ${i}: ${end} vs ${s[i].when}`);
  }
  // erstes Stück: Medienzeit 8,0 → Offset 8 im Block 0, Start bei Anker 100,06
  assertEquals(s[0].offset, 8);
  assertEquals(Math.abs(s[0].when - 100.06) < 1e-6, true);
  // Blockwechsel: ein Stück beginnt bei Offset 0 (Block 1)
  assertEquals(s.some((x) => x.offset === 0 && !x.reversed), true);
  assertEquals(m.fetched.some((u) => u === "/a/0/1"), true);
  a.destroy();
});

Deno.test("Engine rückwärts: umgekehrte Puffer, Offset von hinten gerechnet, Start jeweils am späteren Ende", async () => {
  const m = mockAudio();
  const a = new ReviewAudio({ tracks: 1, durationSec: 60, urlFor: (t, b) => `/a/${t}/${b}` });
  a.unlock();
  a.prefetch(12, -1);
  await new Promise((r) => setTimeout(r, 20));
  a.start(12, -1);
  await new Promise((r) => setTimeout(r, 20));
  m.ctx.currentTime = 100.06 + 0.3;
  await new Promise((r) => setTimeout(r, 60));
  const s = m.started.sort((x, y) => x.when - y.when);
  if (!s.length) throw new Error("nichts eingeplant");
  assertEquals(s[0].reversed, true);
  // erstes Stück endet bei Medienzeit 12 (Block 1, lokal 2 s): im umgekehrten Puffer (10 s) beginnt es bei 10−2 = 8
  assertEquals(Math.abs(s[0].offset - 8) < 1e-9, true);
  assertEquals(Math.abs(s[0].when - 100.06) < 1e-6, true);
  a.destroy();
});

Deno.test("Scrub-Stück: spielt genau das Stück ab Bildbeginn; über 4× bleibt Dauerwiedergabe stumm", async () => {
  const m = mockAudio();
  const a = new ReviewAudio({ tracks: 2, durationSec: 60, urlFor: (t, b) => `/a/${t}/${b}` });
  a.unlock();
  a.grain(1.24);
  await new Promise((r) => setTimeout(r, 30));
  const g = m.started.filter((x) => Math.abs(x.offset - 1.24) < 1e-9);
  assertEquals(g.length, 2); // beide Spuren
  assertEquals(g.every((x) => Math.abs(x.dur - 0.09) < 1e-9), true);
  m.started.length = 0;
  a.start(5, 8);
  await new Promise((r) => setTimeout(r, 30));
  assertEquals(m.started.length, 0);
  assertEquals(a.running, false);
  a.destroy();
});

Deno.test("Spur stumm/Solo: nur hörbare Spuren werden geholt und eingeplant", async () => {
  const m = mockAudio();
  const a = new ReviewAudio({ tracks: 3, durationSec: 60, urlFor: (t, b) => `/a/${t}/${b}` });
  a.unlock();
  a.setTrack(0, { on: false });
  a.setTrack(2, { solo: true });
  a.grain(2);
  await new Promise((r) => setTimeout(r, 30));
  assertEquals(m.fetched.filter((u) => u.startsWith("/a/2/")).length > 0, true);
  assertEquals(m.fetched.filter((u) => u.startsWith("/a/0/") || u.startsWith("/a/1/")).length, 0);
  assertEquals(m.started.length, 1);
  a.destroy();
});

import { reduceColumns } from "./waveform.ts";

Deno.test("Wellenform: Spalten nehmen das Maximum ihrer Bilder, nur hörbare Spuren zählen, Stille bleibt 0", () => {
  const a = new Uint8Array(100);
  const b = new Uint8Array(100);
  a.fill(200, 50); // Spur A: Ton ab Bild 50
  b[10] = 255; // Spur B: ein Knall bei Bild 10
  const both = reduceColumns([a, b], [true, true], 10);
  assertEquals([both[0], both[1], both[4], both[5]], [0, 255, 0, 200]); // Spalte = 10 Bilder
  assertEquals(Array.from(reduceColumns([a, b], [true, false], 10)).slice(0, 2), [0, 0]);
  assertEquals(reduceColumns([null, null], [true, true], 5).every((v) => v === 0), true);
  assertEquals(reduceColumns([a], [true], 200).length, 200); // mehr Spalten als Bilder: jede Spalte mindestens ein Bild
});
