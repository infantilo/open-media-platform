// Review-Player (Kapitel 43): Wiedergabe des Review-Proxys mit framegenauer Navigation.
//
// Grundsätze:
//  - Position ist ein ganzzahliger Frame-Index der ORIGINALDATEI; der Proxy hat dieselbe Bildrate und Bildanzahl
//    (serverseitig verifiziert), Bild n des Proxys ⇔ Bild n der Quelle. Timecode = Start-Timecode + Frame (timecode.ts).
//  - Einzelbildschritte setzen `currentTime` auf die MITTE des Zielbildes (timeForFrame) — nie ein Wanduhr-Takt.
//    Das tatsächlich dargestellte Bild wird über requestVideoFrameCallback (mediaTime = pts) gemessen und in
//    `data-presented-frame` bereitgestellt (Tests/Diagnose).
//  - Wiedergabe vorwärts: playbackRate (bis 8×). Rückwärts-Shuttle gibt es im Browser nicht: Rückfall über Einzelbild-
//    Seeks (der Proxy besteht nur aus Intra-Bildern); die erreichbare Rate hängt von der Seek-Geschwindigkeit ab und
//    wird bei Rückstand durch Überspringen von Bildern gehalten (nicht jedes Bild wird angezeigt).
//  - Der Proxy ist NICHT die Originaldatei: die Oberfläche kennzeichnet das dauerhaft.
import { t as tt } from "../host.ts";
import { clampFrame, type Finding, keyAction, nextBoundary, type Segment, shuttleFrame, shuttleStep, SHUTTLE_SPEEDS } from "./review-logic.ts";
import { frameForPts, frameForTime, frameForTimecode, timecodeOf, timeForFrame, type Timeline } from "./timecode.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

const SEG_COLORS = ["#2f8cff", "#43a047", "#fb8c00", "#a45cff", "#19d3f3", "#e53935"];
const SEV_COLOR: Record<string, string> = { critical: "#e53935", major: "#ef5350", minor: "#fb8c00", info: "#93a1ba" };

export interface PlayerOptions {
  timeline: Timeline;
  src: string;
  proxyLabel: string; // z. B. "960×540 H.264"
  getSegments: () => Segment[];
  findings: () => Finding[];
  onFrame?: (frame: number) => void;
  onMarks?: (m: { in: number | null; out: number | null }) => void;
  onAddSegment?: (inF: number, outF: number) => void;
}

type ViewEl = HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, md: { mediaTime: number }) => void) => number };

export class ReviewPlayer {
  readonly el: HTMLElement;
  readonly video: ViewEl;
  #o: PlayerOptions;
  #tl: Timeline;
  #cur = 0;
  #presented = -1;
  #markIn: number | null = null;
  #markOut: number | null = null;
  #cue = 0;
  #speed = 0;
  #rangeEnd: number | null = null;
  #raf = 0;
  #revStart = { ts: 0, frame: 0 };
  #lastReverseTarget = -1;
  #tcBig: HTMLElement;
  #info: HTMLElement;
  #speedOut: HTMLElement;
  #bar: HTMLElement;
  #playhead: HTMLElement;
  #msg: HTMLElement;
  #tcInput: HTMLInputElement;
  #marksOut: HTMLElement;
  #shuttle: HTMLInputElement;
  #destroyed = false;
  #vfcActive = false;

  constructor(o: PlayerOptions) {
    this.#o = o;
    this.#tl = o.timeline;
    this.el = el("div", "display:flex;flex-direction:column;gap:6px;outline:none;");
    this.el.tabIndex = 0;
    this.el.dataset.role = "review-player";

    const stage = el("div", "position:relative;background:#000;border-radius:6px;overflow:hidden;");
    this.video = el("video", "width:100%;max-height:46vh;display:block;background:#000;") as ViewEl;
    this.video.preload = "auto";
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.controls = false;
    this.video.src = o.src;
    const badge = el("div", "position:absolute;top:6px;left:6px;padding:2px 8px;border-radius:4px;background:rgba(251,140,0,.9);color:#000;font-size:11px;font-weight:700;letter-spacing:.06em;", tt("rv.player.proxy"));
    badge.title = tt("rv.player.proxy.hint", { p0: o.proxyLabel });
    this.#tcBig = el("div", "position:absolute;left:8px;bottom:6px;padding:2px 8px;border-radius:4px;background:rgba(0,0,0,.65);font:600 18px var(--omp-font-mono);color:#fff;");
    this.#tcBig.dataset.role = "timecode";
    this.#info = el("div", "position:absolute;right:8px;bottom:6px;padding:2px 8px;border-radius:4px;background:rgba(0,0,0,.65);font:12px var(--omp-font-mono);color:#cfd8e8;");
    this.#msg = el("div", "position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.7);color:#fff;text-align:center;padding:16px;");
    stage.append(this.video, badge, this.#tcBig, this.#info, this.#msg);

    // Zeitleiste
    this.#bar = el("div", "position:relative;height:38px;background:var(--omp-surface-raised);border:1px solid var(--omp-border);border-radius:4px;cursor:ew-resize;touch-action:none;user-select:none;");
    this.#playhead = el("div", "position:absolute;top:0;bottom:0;width:2px;background:#fff;pointer-events:none;");
    this.#bar.append(this.#playhead);

    // Transport
    const row = el("div", "display:flex;flex-wrap:wrap;gap:4px;align-items:center;");
    const btn = (label: string, title: string, fn: () => void): HTMLButtonElement => {
      const b = el("button", "padding:3px 9px;min-width:34px;", label);
      b.type = "button";
      b.title = title;
      b.addEventListener("click", () => {
        fn();
        this.el.focus();
      });
      return b;
    };
    this.#tcInput = el("input", "width:112px;font-family:var(--omp-font-mono);") as HTMLInputElement;
    this.#tcInput.placeholder = "HH:MM:SS:FF";
    this.#tcInput.title = tt("rv.player.goto.hint");
    this.#tcInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") this.gotoTimecode(this.#tcInput.value);
    });
    row.append(
      btn("⏮", tt("rv.player.start"), () => this.seek(0)),
      btn("◀|", tt("rv.player.back1"), () => this.step(-1)),
      btn("▶", tt("rv.player.play"), () => this.togglePlay()),
      btn("■", tt("rv.player.stop"), () => this.stop()),
      btn("|▶", tt("rv.player.fwd1"), () => this.step(1)),
      btn("⏭", tt("rv.player.end"), () => this.seek(this.#tl.durationFrames - 1)),
      el("span", "width:10px;"),
      this.#tcInput,
      btn("↵", tt("rv.player.goto"), () => this.gotoTimecode(this.#tcInput.value)),
    );

    // Jog (Frame-genau) und Shuttle (Geschwindigkeit) — getrennte Bedienarten
    const jog = el("div", "display:flex;align-items:center;gap:6px;");
    const jogStrip = el("div", "width:170px;height:26px;border:1px solid var(--omp-border);border-radius:13px;background:repeating-linear-gradient(90deg,var(--omp-surface-raised) 0 6px,var(--omp-border) 6px 7px);cursor:ew-resize;touch-action:none;display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--omp-text-dim);user-select:none;", "JOG");
    jogStrip.title = tt("rv.player.jog.hint");
    jogStrip.dataset.role = "jog";
    this.#attachJog(jogStrip);
    this.#shuttle = el("input") as HTMLInputElement;
    this.#shuttle.type = "range";
    this.#shuttle.min = "0";
    this.#shuttle.max = String(SHUTTLE_SPEEDS.length - 1);
    this.#shuttle.step = "1";
    this.#shuttle.value = String(SHUTTLE_SPEEDS.indexOf(0));
    this.#shuttle.style.width = "190px";
    this.#shuttle.title = tt("rv.player.shuttle.hint");
    this.#shuttle.dataset.role = "shuttle";
    this.#shuttle.addEventListener("input", () => this.setSpeed(SHUTTLE_SPEEDS[Number(this.#shuttle.value)]));
    // Feder-Shuttle: loslassen = Stillstand (wie der Ring am Bedienpult)
    const release = () => {
      if (this.#shuttle.dataset.spring === "1") this.setSpeed(0);
    };
    this.#shuttle.addEventListener("pointerup", release);
    this.#shuttle.addEventListener("pointercancel", release);
    this.#shuttle.dataset.spring = "1";
    this.#speedOut = el("span", "min-width:44px;font:12px var(--omp-font-mono);color:var(--omp-text-dim);", "0×");
    jog.append(el("span", "font-size:11px;color:var(--omp-text-dim);", tt("rv.player.jog")), jogStrip, el("span", "width:8px;"), el("span", "font-size:11px;color:var(--omp-text-dim);", tt("rv.player.shuttle")), this.#shuttle, this.#speedOut);

    // Marken
    const marks = el("div", "display:flex;flex-wrap:wrap;gap:4px;align-items:center;");
    this.#marksOut = el("span", "font:12px var(--omp-font-mono);color:var(--omp-text-dim);margin:0 6px;");
    marks.append(
      btn("I", tt("rv.player.markin"), () => this.markIn()),
      btn("O", tt("rv.player.markout"), () => this.markOut()),
      btn("◀I", tt("rv.player.gotoin"), () => this.#markIn !== null && this.seek(this.#markIn)),
      btn("O▶", tt("rv.player.gotoout"), () => this.#markOut !== null && this.seek(this.#markOut - 1)),
      btn("✕", tt("rv.player.clearmarks"), () => this.clearMarks()),
      this.#marksOut,
      btn("＋ " + tt("rv.player.addsegment"), tt("rv.player.addsegment.hint"), () => this.addSegmentFromMarks()),
      btn("▶ " + tt("rv.player.previewrange"), tt("rv.player.previewrange.hint"), () => this.previewMarks()),
    );
    this.el.append(stage, this.#bar, row, jog, marks);

    this.#attachBar();
    this.el.addEventListener("keydown", (e) => this.#onKey(e));
    this.video.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.step(e.deltaY > 0 ? (e.shiftKey ? 10 : 1) : e.shiftKey ? -10 : -1);
    }, { passive: false });
    this.video.addEventListener("click", () => this.togglePlay());
    this.video.addEventListener("error", () => this.#showMsg(tt("rv.player.error")));
    this.video.addEventListener("loadedmetadata", () => {
      this.#showMsg("");
      this.seek(this.#cur);
    });
    this.video.addEventListener("ended", () => {
      this.pause();
      this.#setCur(this.#tl.durationFrames - 1, false);
    });
    this.#startFrameLoop();
    this.#render();
  }

  // ---- Zugriff ----------------------------------------------------------------------------------------------------

  get frame(): number {
    return this.#cur;
  }
  /** Zuletzt tatsächlich dargestelltes Bild (aus requestVideoFrameCallback), −1 solange unbekannt. */
  get presentedFrame(): number {
    return this.#presented;
  }
  get marks(): { in: number | null; out: number | null } {
    return { in: this.#markIn, out: this.#markOut };
  }
  get speed(): number {
    return this.#speed;
  }
  get playing(): boolean {
    return !this.video.paused;
  }

  setTimeline(tl: Timeline): void {
    this.#tl = tl;
    this.#render();
  }

  // ---- Navigation -------------------------------------------------------------------------------------------------

  seek(frame: number): void {
    this.#stopReverse();
    this.#rangeEnd = null;
    const f = clampFrame(frame, this.#tl);
    this.#setCur(f, true);
  }

  step(n: number): void {
    this.pause();
    this.seek(this.#cur + n);
  }

  gotoTimecode(tc: string): boolean {
    const f = frameForTimecode(this.#tl, tc);
    if (f === null) {
      this.#flash(tt("rv.player.badtc"));
      return false;
    }
    this.pause();
    this.seek(Math.min(f, this.#tl.durationFrames - 1));
    return true;
  }

  play(speed = 1): void {
    this.#stopReverse();
    this.#cue = this.#cur;
    if (this.#cur >= this.#tl.durationFrames - 1) this.#setCur(0, true);
    this.#speed = speed;
    this.video.playbackRate = Math.max(0.0625, Math.min(16, speed));
    this.video.muted = speed !== 1;
    void this.video.play().catch(() => this.#showMsg(tt("rv.player.error")));
    this.#render();
  }

  pause(): void {
    this.#stopReverse();
    this.#rangeEnd = null;
    if (!this.video.paused) this.video.pause();
    this.#speed = 0;
    this.#syncShuttle();
    // an der Rasterposition einrasten (pause() stoppt zwischen zwei Bildern)
    this.#setCur(this.#cur, true);
    this.#render();
  }

  togglePlay(): void {
    if (this.playing || this.#speed !== 0) this.pause();
    else this.play(1);
  }

  /** Stop: anhalten und zur Position zurück, an der die Wiedergabe zuletzt gestartet wurde (Cue-Punkt). */
  stop(): void {
    this.pause();
    this.seek(this.#cue);
  }

  /** Shuttle: Vielfaches der Echtzeit; negativ = rückwärts (Rückfall über Einzelbild-Seeks). */
  setSpeed(speed: number): void {
    if (speed === 0) {
      this.pause();
      return;
    }
    if (speed > 0) {
      this.play(speed);
    } else {
      if (!this.video.paused) this.video.pause();
      this.#speed = speed;
      this.#cue = this.#cur;
      this.#startReverse();
    }
    this.#syncShuttle();
    this.#render();
  }

  previewRange(inF: number, outF: number): void {
    this.pause();
    this.seek(inF);
    this.#rangeEnd = outF; // exklusiv: das erste Bild hinter dem Bereich beendet die Vorschau
    this.play(1);
  }

  // ---- Marken -----------------------------------------------------------------------------------------------------

  markIn(frame = this.#cur): void {
    this.#markIn = frame;
    if (this.#markOut !== null && this.#markOut <= frame) this.#markOut = null;
    this.#marksChanged();
  }
  /** Out ist exklusiv: die Marke steht auf dem ersten Bild NACH dem Ausschnitt (aktuelles Bild + 1 = aktuelles Bild ist das letzte enthaltene). */
  markOut(frame = this.#cur + 1): void {
    this.#markOut = Math.min(frame, this.#tl.durationFrames);
    if (this.#markIn !== null && this.#markIn >= this.#markOut) this.#markIn = null;
    this.#marksChanged();
  }
  clearMarks(): void {
    this.#markIn = this.#markOut = null;
    this.#marksChanged();
  }
  setMarks(i: number | null, o: number | null): void {
    this.#markIn = i;
    this.#markOut = o;
    this.#marksChanged();
  }
  addSegmentFromMarks(): void {
    if (this.#markIn === null || this.#markOut === null) {
      this.#flash(tt("rv.player.needmarks"));
      return;
    }
    this.#o.onAddSegment?.(this.#markIn, this.#markOut);
  }
  previewMarks(): void {
    if (this.#markIn === null || this.#markOut === null) {
      this.#flash(tt("rv.player.needmarks"));
      return;
    }
    this.previewRange(this.#markIn, this.#markOut);
  }

  /** Zeitleiste neu zeichnen (Segmente/Befunde haben sich geändert). */
  refresh(): void {
    this.#render();
  }

  focus(): void {
    this.el.focus();
  }

  destroy(): void {
    this.#destroyed = true;
    this.#stopReverse();
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
  }

  // ---- intern -----------------------------------------------------------------------------------------------------

  #setCur(f: number, seekVideo: boolean): void {
    this.#cur = f;
    if (seekVideo) {
      const t = timeForFrame(f, this.#tl.rate);
      if (Math.abs(this.video.currentTime - t) > 1e-6) this.video.currentTime = t;
    }
    this.#o.onFrame?.(f);
    this.#render();
  }

  #startFrameLoop(): void {
    if (typeof this.video.requestVideoFrameCallback === "function") {
      this.#vfcActive = true;
      const tick = (_now: number, md: { mediaTime: number }) => {
        if (this.#destroyed) return;
        const f = Math.min(frameForPts(md.mediaTime, this.#tl.rate), this.#tl.durationFrames - 1);
        this.#presented = f;
        this.el.dataset.presentedFrame = String(f);
        if (!this.video.paused || this.#speed !== 0) {
          this.#cur = f;
          this.#o.onFrame?.(f);
          if (this.#rangeEnd !== null && f >= this.#rangeEnd) {
            const last = this.#rangeEnd - 1;
            this.pause();
            this.seek(last);
          }
          this.#render();
        } else if (f !== this.#cur) {
          // Pause: angezeigtes Bild weicht vom Ziel ab (Seek noch unterwegs) — nur Anzeige nachziehen, Ziel bleibt maßgeblich
          this.#renderInfo(f);
        } else {
          this.#renderInfo(f);
        }
        this.video.requestVideoFrameCallback!(tick);
      };
      this.video.requestVideoFrameCallback!(tick);
    } else {
      // Rückfall ohne requestVideoFrameCallback: currentTime abfragen (weniger exakt)
      const poll = () => {
        if (this.#destroyed) return;
        const f = Math.min(frameForTime(this.video.currentTime, this.#tl.rate), this.#tl.durationFrames - 1);
        this.#presented = f;
        this.el.dataset.presentedFrame = String(f);
        if (!this.video.paused) {
          this.#cur = f;
          this.#o.onFrame?.(f);
          if (this.#rangeEnd !== null && f >= this.#rangeEnd) {
            const last = this.#rangeEnd - 1;
            this.pause();
            this.seek(last);
          }
          this.#render();
        }
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    }
  }

  #startReverse(): void {
    this.#stopReverse();
    this.#revStart = { ts: performance.now(), frame: this.#cur };
    this.#lastReverseTarget = -1;
    const tick = () => {
      if (this.#speed >= 0 || this.#destroyed) return;
      const target = clampFrame(shuttleFrame(this.#revStart.frame, this.#speed, performance.now() - this.#revStart.ts, this.#tl.rate.num / this.#tl.rate.den), this.#tl);
      if (target !== this.#lastReverseTarget && !this.video.seeking) {
        this.#lastReverseTarget = target;
        this.#setCur(target, true);
      }
      if (target <= 0) {
        this.pause();
        return;
      }
      this.#raf = requestAnimationFrame(tick);
    };
    this.#raf = requestAnimationFrame(tick);
  }

  #stopReverse(): void {
    if (this.#raf) cancelAnimationFrame(this.#raf);
    this.#raf = 0;
  }

  #attachJog(strip: HTMLElement): void {
    let lastX = 0;
    let acc = 0;
    const PX = 7; // Pixel je Bild
    strip.addEventListener("pointerdown", (e) => {
      strip.setPointerCapture(e.pointerId);
      lastX = e.clientX;
      acc = 0;
      this.pause();
    });
    strip.addEventListener("pointermove", (e) => {
      if (!strip.hasPointerCapture(e.pointerId)) return;
      acc += e.clientX - lastX;
      lastX = e.clientX;
      const n = Math.trunc(acc / PX);
      if (n !== 0) {
        acc -= n * PX;
        this.seek(this.#cur + n);
      }
    });
  }

  #attachBar(): void {
    const at = (e: PointerEvent): number => {
      const r = this.#bar.getBoundingClientRect();
      const x = Math.min(Math.max(0, e.clientX - r.left), r.width);
      return Math.min(this.#tl.durationFrames - 1, Math.floor((x / r.width) * this.#tl.durationFrames));
    };
    let dragging = false;
    this.#bar.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).dataset.findingFrame) return;
      dragging = true;
      this.#bar.setPointerCapture(e.pointerId);
      this.pause();
      this.seek(at(e));
      this.el.focus();
    });
    this.#bar.addEventListener("pointermove", (e) => {
      if (dragging) this.seek(at(e));
    });
    const up = () => (dragging = false);
    this.#bar.addEventListener("pointerup", up);
    this.#bar.addEventListener("pointercancel", up);
  }

  #onKey(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const a = keyAction(e, this.#tl.rate.num / this.#tl.rate.den);
    if (!a) return;
    e.preventDefault();
    switch (a.kind) {
      case "step":
        this.step(a.frames);
        break;
      case "togglePlay":
        this.togglePlay();
        break;
      case "shuttle":
        if (a.key === "K") this.pause();
        else this.setSpeed(shuttleStep(this.#speed, a.key));
        break;
      case "markIn":
        this.markIn();
        break;
      case "markOut":
        this.markOut();
        break;
      case "gotoIn":
        if (this.#markIn !== null) this.seek(this.#markIn);
        break;
      case "gotoOut":
        if (this.#markOut !== null) this.seek(this.#markOut - 1);
        break;
      case "home":
        this.pause();
        this.seek(0);
        break;
      case "end":
        this.pause();
        this.seek(this.#tl.durationFrames - 1);
        break;
      case "gotoTimecode":
        this.#tcInput.focus();
        this.#tcInput.select();
        break;
      case "boundary": {
        const b = nextBoundary(this.#o.getSegments(), this.#cur, a.dir);
        if (b !== null) {
          this.pause();
          this.seek(Math.min(b, this.#tl.durationFrames - 1));
        }
        break;
      }
      case "addSegment":
        this.addSegmentFromMarks();
        break;
    }
  }

  #marksChanged(): void {
    this.#o.onMarks?.({ in: this.#markIn, out: this.#markOut });
    this.#render();
  }

  #syncShuttle(): void {
    const i = SHUTTLE_SPEEDS.indexOf(this.#speed);
    this.#shuttle.value = String(i < 0 ? SHUTTLE_SPEEDS.indexOf(0) : i);
  }

  #showMsg(text: string): void {
    this.#msg.textContent = text;
    this.#msg.style.display = text ? "flex" : "none";
  }

  #flashTimer = 0;
  #flash(text: string): void {
    this.#showMsg(text);
    clearTimeout(this.#flashTimer);
    this.#flashTimer = setTimeout(() => this.#showMsg(""), 1800) as unknown as number;
  }

  #renderInfo(shown: number): void {
    const tl = this.#tl;
    this.#tcBig.textContent = timecodeOf(tl, shown);
    this.#info.textContent = tt("rv.player.frameinfo", { p0: shown, p1: tl.durationFrames - 1, p2: Math.round((tl.rate.num / tl.rate.den) * 1000) / 1000 });
  }

  #render(): void {
    const tl = this.#tl;
    this.#renderInfo(this.#cur);
    this.#speedOut.textContent = `${this.#speed}×`;
    const pct = (f: number) => `${(f / tl.durationFrames) * 100}%`;
    this.#playhead.style.left = `calc(${pct(this.#cur)} - 1px)`;
    // alles außer Spielkopf neu aufbauen
    [...this.#bar.children].forEach((c) => c !== this.#playhead && c.remove());
    this.#o.getSegments().forEach((s, i) => {
      const d = el("div", `position:absolute;top:18px;height:14px;left:${pct(s.in)};width:${Math.max(0.3, ((s.out - s.in) / tl.durationFrames) * 100)}%;background:${SEG_COLORS[i % SEG_COLORS.length]};opacity:.75;border-radius:2px;pointer-events:none;`);
      d.title = `${s.label || tt("rv.seg.n", { p0: i + 1 })}: ${timecodeOf(tl, s.in)} – ${timecodeOf(tl, s.out)}`;
      this.#bar.append(d);
    });
    if (this.#markIn !== null || this.#markOut !== null) {
      const a = this.#markIn ?? 0;
      const b = this.#markOut ?? tl.durationFrames;
      this.#bar.append(el("div", `position:absolute;top:0;height:16px;left:${pct(a)};width:${Math.max(0.3, ((b - a) / tl.durationFrames) * 100)}%;background:rgba(25,211,243,.35);border-left:${this.#markIn !== null ? 2 : 0}px solid #19d3f3;border-right:${this.#markOut !== null ? 2 : 0}px solid #19d3f3;pointer-events:none;`));
    }
    for (const f of this.#o.findings()) {
      if (f.startFrame === undefined || (f.status !== "fail" && f.status !== "warning")) continue;
      const m = el("div", `position:absolute;top:0;height:16px;left:${pct(f.startFrame)};width:5px;margin-left:-2px;background:${SEV_COLOR[f.severity] ?? "#ef5350"};cursor:pointer;`);
      m.dataset.findingFrame = String(f.startFrame);
      m.title = f.message;
      m.addEventListener("click", (e) => {
        e.stopPropagation();
        this.pause();
        this.seek(f.startFrame!);
      });
      this.#bar.append(m);
    }
    this.#marksOut.textContent = `${this.#markIn === null ? "—" : timecodeOf(tl, this.#markIn)}  →  ${this.#markOut === null ? "—" : timecodeOf(tl, this.#markOut)}` +
      (this.#markIn !== null && this.#markOut !== null ? `  (${this.#markOut - this.#markIn} ${tt("rv.frames")})` : "");
  }
}
