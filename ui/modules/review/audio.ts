// Ton des Review-Players (Kapitel 43): Spurwahl und Scrub-Ton über Web Audio.
//
// Der Server liefert je Tonspur Blöcke von BLOCK_SEC Sekunden als WAV (Stereo, 48 kHz); Block b beginnt bei b·BLOCK_SEC und ist
// bildgenau zum Proxy. Hier werden die Blöcke dekodiert, gepuffert und zeitgenau eingeplant:
//  - start(t, rate): Wiedergabe ab Medienzeit t, vorwärts oder rückwärts (rückwärts über umgekehrte Pufferkopien). Tonhöhe folgt
//    der Rate (wie bei Bandmaschinen); über MAX_RATE und unter MIN_RATE bleibt der Ton stumm.
//  - grain(t): kurzes Stück ab t beim Einzelbildschritt/Jog — damit lassen sich Toneinsätze und -enden Bild für Bild finden.
// Das Video bleibt stumm (`muted`); der Player gleicht die Position regelmäßig ab (resync).

export const BLOCK_SEC = 10;
export const MAX_RATE = 4;
export const MIN_RATE = 0.25;
/** Länge des Scrub-Stücks pro Bildschritt (Sekunden). */
export const GRAIN_SEC = 0.09;

export interface TrackState {
  on: boolean;
  solo: boolean;
}

/** Teilstück [a,b) (absolute Sekunden) innerhalb genau eines Blocks. */
export interface Piece {
  block: number;
  a: number;
  b: number;
}

/** Zerlegt [a,b) an Blockgrenzen (aufsteigend). */
export function splitByBlocks(a: number, b: number, blockSec = BLOCK_SEC): Piece[] {
  const out: Piece[] = [];
  if (!(b > a)) return out;
  let cur = Math.max(0, a);
  while (cur < b - 1e-9) {
    const block = Math.floor(cur / blockSec + 1e-9);
    const end = Math.min(b, (block + 1) * blockSec);
    out.push({ block, a: cur, b: end });
    cur = end;
  }
  return out;
}

/** Hörbar: Spur an und — wenn irgendeine Spur Solo hat — selbst auf Solo. */
export function audibleTracks(tracks: TrackState[]): boolean[] {
  const anySolo = tracks.some((t) => t.solo);
  return tracks.map((t) => (anySolo ? t.solo : t.on));
}

export function rateAudible(rate: number): boolean {
  const r = Math.abs(rate);
  return r >= MIN_RATE && r <= MAX_RATE;
}

interface Entry {
  buf?: AudioBuffer;
  rev?: AudioBuffer;
  promise?: Promise<AudioBuffer | null>;
  failedAt?: number;
  used: number;
}

export interface AudioSource {
  tracks: number;
  durationSec: number;
  urlFor: (track: number, block: number) => string;
}

export class ReviewAudio {
  readonly state: TrackState[];
  #src: AudioSource;
  #ctx: AudioContext | null = null;
  #master: GainNode | null = null;
  #trackGain: GainNode[] = [];
  #cache = new Map<string, Entry>();
  #clock = 0;
  #run: { gain: GainNode; tracks: GainNode[]; sources: AudioBufferSourceNode[] } | null = null;
  #anchor = { ctx: 0, m: 0, r: 1 };
  #until = 0;
  #timer = 0;
  #grain: { gain: GainNode; src: AudioBufferSourceNode[] } | null = null;
  #grainSeq = 0;
  #volume = 1;

  constructor(src: AudioSource) {
    this.#src = src;
    this.state = Array.from({ length: src.tracks }, () => ({ on: true, solo: false }));
  }

  get tracks(): number {
    return this.#src.tracks;
  }

  /** Aus einer Benutzeraktion aufrufen (Browser erlaubt Ton erst danach). */
  unlock(): void {
    try {
      if (!this.#ctx) {
        const Ctx = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return;
        this.#ctx = new Ctx({ latencyHint: "interactive" });
        this.#master = this.#ctx.createGain();
        this.#master.gain.value = this.#volume;
        this.#master.connect(this.#ctx.destination);
        this.#trackGain = this.state.map(() => {
          const g = this.#ctx!.createGain();
          g.connect(this.#master!);
          return g;
        });
        this.#applyGains();
      }
      if (this.#ctx.state === "suspended") void this.#ctx.resume();
    } catch {
      this.#ctx = null;
    }
  }

  get ready(): boolean {
    return this.#ctx !== null && this.#ctx.state === "running";
  }

  setVolume(v: number): void {
    this.#volume = Math.max(0, Math.min(1.5, v));
    if (this.#master) this.#master.gain.value = this.#volume;
  }

  setTrack(i: number, patch: Partial<TrackState>): void {
    Object.assign(this.state[i], patch);
    this.#applyGains();
  }

  #applyGains(): void {
    if (!this.#ctx) return;
    const aud = audibleTracks(this.state);
    const now = this.#ctx.currentTime;
    this.#trackGain.forEach((g, i) => g.gain.setTargetAtTime(aud[i] ? 1 : 0, now, 0.01));
    this.#run?.tracks.forEach((g, i) => g.gain.setTargetAtTime(aud[i] ? 1 : 0, now, 0.01));
  }

  // ---- Blöcke ------------------------------------------------------------------------------------------------------

  #key(track: number, block: number): string {
    return `${track}:${block}`;
  }

  #block(track: number, block: number): Entry {
    const k = this.#key(track, block);
    let e = this.#cache.get(k);
    if (!e) {
      e = { used: 0 };
      this.#cache.set(k, e);
      // Speicher begrenzen: älteste, nicht benutzte Einträge entfernen (Block ≈ 3,8 MB, rückwärts doppelt)
      if (this.#cache.size > 36) {
        const old = [...this.#cache.entries()].sort((a, b) => a[1].used - b[1].used)[0];
        if (old && old[0] !== k) this.#cache.delete(old[0]);
      }
    }
    e.used = ++this.#clock;
    if (!e.buf && !e.promise && (!e.failedAt || Date.now() - e.failedAt > 4000) && this.#ctx) {
      const ctx = this.#ctx;
      e.promise = (async () => {
        try {
          const res = await fetch(this.#src.urlFor(track, block));
          if (!res.ok) throw new Error(String(res.status));
          const buf = await ctx.decodeAudioData(await res.arrayBuffer());
          e!.buf = buf;
          return buf;
        } catch {
          e!.failedAt = Date.now();
          return null;
        } finally {
          e!.promise = undefined;
        }
      })();
    }
    return e;
  }

  #reversed(e: Entry): AudioBuffer | undefined {
    if (e.rev || !e.buf || !this.#ctx) return e.rev;
    const b = e.buf;
    const r = this.#ctx.createBuffer(b.numberOfChannels, b.length, b.sampleRate);
    for (let c = 0; c < b.numberOfChannels; c++) {
      const src = b.getChannelData(c);
      const dst = r.getChannelData(c);
      for (let i = 0, n = src.length; i < n; i++) dst[i] = src[n - 1 - i];
    }
    e.rev = r;
    return r;
  }

  /** Blöcke rund um t anfordern (vorwärts/rückwärts). */
  prefetch(t: number, dir: 1 | -1 = 1): void {
    if (!this.#ctx) return;
    const b0 = Math.floor(t / BLOCK_SEC);
    const last = Math.max(0, Math.ceil(this.#src.durationSec / BLOCK_SEC) - 1);
    const want = [b0, b0 + dir, b0 + 2 * dir].filter((b) => b >= 0 && b <= last);
    const aud = audibleTracks(this.state);
    for (const b of want) for (let i = 0; i < this.#src.tracks; i++) if (aud[i]) this.#block(i, b);
  }

  // ---- Kurzstück (Einzelbild/Jog) ---------------------------------------------------------------------------------

  /** Spielt ab Medienzeit t ein kurzes Stück (Scrub). Neue Stücke lösen das vorige mit kurzer Blende ab. */
  grain(t: number, dur = GRAIN_SEC): void {
    if (!this.ready || this.#run) return;
    const ctx = this.#ctx!;
    const seq = ++this.#grainSeq;
    const end = Math.min(t + dur, this.#src.durationSec);
    const pieces = splitByBlocks(Math.max(0, t), end);
    const aud = audibleTracks(this.state);
    const need: Array<{ i: number; p: Piece; e: Entry }> = [];
    for (const p of pieces) for (let i = 0; i < this.#src.tracks; i++) if (aud[i]) need.push({ i, p, e: this.#block(i, p.block) });
    this.prefetch(t, 1);
    const play = () => {
      if (seq !== this.#grainSeq) return; // inzwischen neuere Anfrage
      this.#fadeOutGrain();
      const gain = ctx.createGain();
      const t0 = ctx.currentTime + 0.005;
      const total = end - t;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(1, t0 + 0.004);
      gain.gain.setValueAtTime(1, t0 + Math.max(0.005, total - 0.01));
      gain.gain.linearRampToValueAtTime(0, t0 + total);
      const srcs: AudioBufferSourceNode[] = [];
      let when = t0;
      for (const p of pieces) {
        for (const n of need.filter((x) => x.p === p)) {
          if (!n.e.buf) continue;
          const s = ctx.createBufferSource();
          s.buffer = n.e.buf;
          s.connect(gain);
          gain.connect(this.#trackGain[n.i]);
          s.start(when, p.a - p.block * BLOCK_SEC, p.b - p.a);
          srcs.push(s);
        }
        when += p.b - p.a;
      }
      this.#grain = { gain, src: srcs };
    };
    if (need.every((n) => n.e.buf)) play();
    else void Promise.all(need.map((n) => n.e.promise)).then(play);
  }

  #fadeOutGrain(): void {
    const g = this.#grain;
    if (!g || !this.#ctx) return;
    const now = this.#ctx.currentTime;
    g.gain.gain.cancelScheduledValues(now);
    g.gain.gain.setValueAtTime(g.gain.gain.value, now);
    g.gain.gain.linearRampToValueAtTime(0, now + 0.004);
    for (const s of g.src) {
      try {
        s.stop(now + 0.006);
      } catch { /* schon beendet */ }
    }
    this.#grain = null;
  }

  // ---- Dauerwiedergabe ---------------------------------------------------------------------------------------------

  /** Wiedergabe ab Medienzeit t mit Rate r (negativ = rückwärts). */
  start(t: number, rate: number): void {
    this.stop();
    if (!this.ready || !rateAudible(rate)) return;
    const ctx = this.#ctx!;
    this.#fadeOutGrain();
    this.#grainSeq++;
    const gain = ctx.createGain();
    gain.connect(this.#master!);
    // Quelle → Spur-Pegel (Spurwahl/Solo, auch während der Wiedergabe änderbar) → Lauf-Pegel (Ausblendung) → Master
    const aud = audibleTracks(this.state);
    const tracks = this.state.map((_, i) => {
      const g = ctx.createGain();
      g.gain.value = aud[i] ? 1 : 0;
      g.connect(gain);
      return g;
    });
    this.#run = { gain, tracks, sources: [] };
    this.#anchor = { ctx: ctx.currentTime + 0.06, m: t, r: rate };
    this.#until = t;
    this.#tick();
    this.#timer = setInterval(() => this.#tick(), 40) as unknown as number;
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = 0;
    const run = this.#run;
    this.#run = null;
    this.#fadeOutGrain();
    this.#grainSeq++;
    if (run && this.#ctx) {
      const now = this.#ctx.currentTime;
      run.gain.gain.cancelScheduledValues(now);
      run.gain.gain.setValueAtTime(run.gain.gain.value, now);
      run.gain.gain.linearRampToValueAtTime(0, now + 0.01);
      for (const s of run.sources) {
        try {
          s.stop(now + 0.015);
        } catch { /* nicht gestartet/beendet */ }
      }
      setTimeout(() => run.gain.disconnect(), 60);
    }
  }

  get running(): boolean {
    return this.#run !== null;
  }

  /** Aktuelle Medienzeit laut Tonuhr (für den Abgleich mit dem Video). */
  position(): number | null {
    if (!this.#run || !this.#ctx) return null;
    return this.#anchor.m + (this.#ctx.currentTime - this.#anchor.ctx) * this.#anchor.r;
  }

  /** Weicht die Tonuhr um mehr als `tol` Sekunden vom Video ab, neu ansetzen. Rückgabe: ob neu angesetzt wurde. */
  resync(videoT: number, tol = 0.06): boolean {
    const p = this.position();
    if (p === null) return false;
    if (Math.abs(p - videoT) > tol) {
      this.start(videoT, this.#anchor.r);
      return true;
    }
    return false;
  }

  #tick(): void {
    const run = this.#run;
    const ctx = this.#ctx;
    if (!run || !ctx) return;
    const { ctx: c0, m: m0, r } = this.#anchor;
    const fwd = r > 0;
    const nowM = m0 + (ctx.currentTime - c0) * r;
    const ahead = 0.35 * Math.abs(r);
    const total = this.#src.durationSec;
    this.prefetch(nowM, fwd ? 1 : -1);
    if (fwd ? this.#until < nowM : this.#until > nowM) this.#until = nowM; // zu spät: Verpasstes überspringen
    const target = fwd ? Math.min(total, nowM + ahead) : Math.max(0, nowM - ahead);
    const aud = audibleTracks(this.state);
    let guard = 0;
    while ((fwd ? this.#until < target - 1e-6 : this.#until > target + 1e-6) && guard++ < 6) {
      const a = fwd ? this.#until : target;
      const b = fwd ? target : this.#until;
      const pieces = splitByBlocks(a, b);
      const p = fwd ? pieces[0] : pieces[pieces.length - 1];
      if (!p) break;
      const entries = this.state.map((_, i) => (aud[i] ? this.#block(i, p.block) : null));
      if (entries.some((e, i) => aud[i] && !e!.buf)) break; // Block noch nicht da — beim nächsten Takt erneut
      const when = fwd ? c0 + (p.a - m0) / r : c0 + (p.b - m0) / r;
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (!e?.buf) continue;
        const s = ctx.createBufferSource();
        s.playbackRate.value = Math.abs(r);
        let off: number;
        if (fwd) {
          s.buffer = e.buf;
          off = p.a - p.block * BLOCK_SEC;
        } else {
          const rv = this.#reversed(e)!;
          s.buffer = rv;
          off = rv.duration - (p.b - p.block * BLOCK_SEC);
        }
        s.connect(run.tracks[i]);
        s.start(Math.max(when, ctx.currentTime), Math.max(0, off), p.b - p.a);
        run.sources.push(s);
      }
      this.#until = fwd ? p.b : p.a;
      if (run.sources.length > 400) run.sources.splice(0, run.sources.length - 200);
    }
    if (fwd ? nowM >= total : nowM <= 0) this.stop();
  }

  destroy(): void {
    this.stop();
    this.#cache.clear();
    try {
      void this.#ctx?.close();
    } catch { /* ignorieren */ }
    this.#ctx = null;
  }
}
