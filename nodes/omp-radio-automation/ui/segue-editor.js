// ui/modules/segue-editor/logic.ts
function rise(curve, x) {
  const v = Math.min(1, Math.max(0, x));
  switch (curve) {
    case "linear":
      return v;
    case "cosine":
      return Math.sin(v * Math.PI / 2);
    case "log":
      return v <= 0 ? 0 : Math.pow(10, (v - 1) * 3);
  }
}
var fall = (curve, x) => 1 - rise(curve, x);
function curvePoints(curve, dir, n = 32) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    pts.push([
      x,
      dir === "in" ? rise(curve, x) : fall(curve, x)
    ]);
  }
  return pts;
}
var msToX = (v, ms) => (ms - v.fromMs) / (v.toMs - v.fromMs) * v.width;
var xToMs = (v, x) => v.fromMs + x / v.width * (v.toMs - v.fromMs);
function zoomView(v, atMs, factor, maxSpanMs) {
  const span = Math.min(maxSpanMs, Math.max(200, (v.toMs - v.fromMs) * factor));
  const t = (atMs - v.fromMs) / (v.toMs - v.fromMs);
  const from = atMs - t * span;
  return {
    fromMs: from,
    toMs: from + span,
    width: v.width
  };
}
function initialView(a, b, width, padMs = 12e3) {
  const from = Math.max(0, Math.min(b.startMs, a.nextStartMs) - padMs);
  const to = Math.max(a.endMs, b.startMs + b.fadeInMs) + padMs;
  return {
    fromMs: from,
    toMs: Math.max(to, from + 1e3),
    width
  };
}
var clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
var round = (v) => Math.round(v);
function markerTime(kind, c) {
  const { a, b, pa, pb } = c;
  switch (kind) {
    case "aOutro":
      return pa.stopAtMs === null ? null : pa.startMs + (pa.stopAtMs - pa.offsetMs);
    case "bStart":
      return pb.startMs;
    case "bIntro":
      return b.introMs === null ? null : pb.startMs + (b.introMs - pb.offsetMs);
    case "bSom":
      return pb.startMs;
    case "fadeOutEnd":
      return pa.stopAtMs === null ? null : pa.startMs + (pa.stopAtMs - pa.offsetMs) + pa.fadeOutMs;
    case "fadeInEnd":
      return pb.startMs + pb.fadeInMs;
  }
  void a;
}
function dragMarker(kind, ms, c) {
  const { a, b, pa, pb } = c;
  switch (kind) {
    case "aOutro": {
      const file = pa.offsetMs + (ms - pa.startMs);
      return {
        a: {
          outroMs: round(clamp(file, a.somMs, a.durationMs))
        }
      };
    }
    case "bStart": {
      const segue = pa.startMs + ((pa.stopAtMs ?? a.durationMs) - pa.offsetMs);
      const shift = clamp(ms - segue, pa.startMs - segue, 6e5);
      return {
        tr: {
          ...c.tr,
          startShiftMs: round(shift)
        }
      };
    }
    case "bIntro": {
      const file = pb.offsetMs + (ms - pb.startMs);
      return {
        b: {
          introMs: round(clamp(file, b.somMs, b.durationMs))
        }
      };
    }
    case "bSom": {
      return {
        b: {
          somMs: round(clamp(b.somMs + (ms - pb.startMs), 0, b.durationMs - 1))
        }
      };
    }
    case "fadeOutEnd": {
      const segue = pa.startMs + ((pa.stopAtMs ?? a.durationMs) - pa.offsetMs);
      const tail = a.durationMs - (pa.stopAtMs ?? a.durationMs);
      return {
        tr: {
          ...c.tr,
          fadeOutMs: round(clamp(ms - segue, 0, tail))
        }
      };
    }
    case "fadeInEnd": {
      return {
        tr: {
          ...c.tr,
          fadeInMs: round(clamp(ms - pb.startMs, 0, 6e4))
        }
      };
    }
  }
}
function hitMarker(x, v, times, tolPx = 7) {
  let best = null;
  let bestD = tolPx + 1;
  for (const [k, t] of Object.entries(times)) {
    if (t === null || t === void 0) continue;
    const d = Math.abs(msToX(v, t) - x);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}
function isEmptyTransition(t) {
  return !t || Object.values(t).every((v) => v === void 0 || v === null);
}
function fmtMs(ms) {
  const neg = ms < 0;
  const a = Math.abs(Math.round(ms));
  const m = Math.floor(a / 6e4);
  const s = Math.floor(a % 6e4 / 1e3);
  const r = a % 1e3;
  return `${neg ? "-" : ""}${m}:${String(s).padStart(2, "0")}.${String(r).padStart(3, "0")}`;
}

// ui/modules/segue-editor/element.ts
var DE = {
  title: "\xDCbergang",
  save: "\xDCbernehmen",
  cancel: "Abbrechen",
  reset: "Standardblende",
  outro: "Segue-Punkt A",
  start: "Einsatz B (Verschiebung)",
  fadeOut: "Ausblenden A (ms)",
  fadeIn: "Einblenden B (ms)",
  curveOut: "Kurve A",
  curveIn: "Kurve B",
  intro: "Intro-Ende B",
  som: "Beginn B (SOM)",
  loading: "Lade \u2026",
  planFailed: "Planung nicht m\xF6glich",
  peaksFailed: "Wellenform nicht lesbar",
  hint: "Marken ziehen \xB7 Mausrad = Zoom \xB7 Umschalt + Ziehen = Verschieben",
  m_aOutro: "Segue A",
  m_bStart: "Einsatz B",
  m_bIntro: "Intro B",
  m_bSom: "SOM B",
  m_fadeOutEnd: "Ende Blende A",
  m_fadeInEnd: "Ende Blende B"
};
var EN = {
  title: "Transition",
  save: "Apply",
  cancel: "Cancel",
  reset: "Default blend",
  outro: "Segue point A",
  start: "Start of B (shift)",
  fadeOut: "Fade out A (ms)",
  fadeIn: "Fade in B (ms)",
  curveOut: "Curve A",
  curveIn: "Curve B",
  intro: "Intro end B",
  som: "Start of B (SOM)",
  loading: "Loading \u2026",
  planFailed: "Planning failed",
  peaksFailed: "Waveform unreadable",
  hint: "Drag markers \xB7 wheel = zoom \xB7 Shift + drag = pan",
  m_aOutro: "Segue A",
  m_bStart: "Start B",
  m_bIntro: "Intro B",
  m_bSom: "SOM B",
  m_fadeOutEnd: "End blend A",
  m_fadeInEnd: "End blend B"
};
var T = (k) => ((document.documentElement.lang || navigator.language || "de").startsWith("en") ? EN : DE)[k] ?? k;
var LANE_H = 110;
var RULER_H = 22;
var BINS = 4096;
var LANE_OF = {
  aOutro: "a",
  fadeOutEnd: "a",
  bStart: "b",
  bIntro: "b",
  bSom: "b",
  fadeInEnd: "b"
};
var HANDLE_Y = {
  aOutro: 8,
  fadeOutEnd: LANE_H - 10,
  bStart: 8,
  bSom: LANE_H / 2,
  bIntro: 8,
  fadeInEnd: LANE_H - 10
};
var COLORS = {
  aOutro: "#ffb020",
  bStart: "#19d3f3",
  bIntro: "#9be564",
  bSom: "#c792ea",
  fadeOutEnd: "#ffb020",
  fadeInEnd: "#19d3f3"
};
var SegueEditor = class extends HTMLElement {
  /** Node-Basis, z. B. `/api/v1/nodes/<id>`. */
  base = "";
  /** Eigener Abruf (Shell-Anmeldung); Standard: `fetch`. */
  fetcher = (u, i) => fetch(u, i);
  #a;
  #b;
  #peaks = /* @__PURE__ */ new Map();
  #placed = null;
  #view = {
    fromMs: 0,
    toMs: 1e3,
    width: 800
  };
  #fitted = false;
  #drag = null;
  #canvas = document.createElement("canvas");
  #status = document.createElement("div");
  #fields = document.createElement("div");
  #planTimer = 0;
  #planSeq = 0;
  #origA = "";
  #origB = "";
  /** Beide Elemente laden; `a` ist der Vorgänger, `b` der Nachfolger (trägt den Übergang). Kopien — die Eingaben bleiben unverändert. */
  load(a, b) {
    this.#a = structuredClone(a);
    this.#b = structuredClone(b);
    this.#origA = JSON.stringify(a);
    this.#origB = JSON.stringify(b);
    this.#fitted = false;
    this.#render();
    void this.#loadPeaks(this.#a);
    void this.#loadPeaks(this.#b);
    void this.#plan();
  }
  /** Bildschirmposition (Pixel im Canvas) und Höhe der Marke — für Klicktests und Tastaturbedienung. */
  markerPoint(kind) {
    const t = this.#times()[kind];
    if (t === null || t === void 0) return null;
    const y0 = LANE_OF[kind] === "a" ? RULER_H : RULER_H + LANE_H + 6;
    return {
      x: msToX(this.#view, t),
      y: y0 + HANDLE_Y[kind]
    };
  }
  /** Marke unter der Maus: zuerst der Griff (Kreis), sonst die Linie in der Spur unter dem Zeiger. */
  #hit(x, y) {
    const kinds = Object.keys(LANE_OF);
    let best = null;
    let bestD = 12;
    for (const k of kinds) {
      const p = this.markerPoint(k);
      if (!p) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best) return best;
    const lane = y < RULER_H + LANE_H + 3 ? "a" : "b";
    const times = this.#times();
    const inLane = {};
    for (const k of [
      "bStart",
      "bIntro",
      "bSom",
      "aOutro",
      "fadeOutEnd",
      "fadeInEnd"
    ]) if (LANE_OF[k] === lane) inLane[k] = times[k];
    return hitMarker(x, this.#view, inLane);
  }
  /** Aktueller Bearbeitungsstand (Kopien). */
  get value() {
    return {
      a: structuredClone(this.#a),
      b: structuredClone(this.#b)
    };
  }
  connectedCallback() {
    if (this.shadowRoot) return;
    const sr = this.attachShadow({
      mode: "open"
    });
    sr.innerHTML = `<style>
      :host{display:block;font:13px system-ui,sans-serif;color:var(--omp-fg,#e8eaed);}
      .wrap{background:var(--omp-surface,#1b1f24);border:1px solid var(--omp-border,#333a42);border-radius:6px;padding:10px;display:flex;flex-direction:column;gap:8px;}
      canvas{width:100%;height:${RULER_H + 2 * LANE_H + 6}px;display:block;background:#12151a;border-radius:4px;touch-action:none;}
      .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:6px 12px;}
      label{display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--omp-muted,#9aa4af);}
      input,select{padding:4px 6px;background:#0f1216;color:inherit;border:1px solid var(--omp-border,#333a42);border-radius:4px;min-height:30px;}
      .row{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap;}
      button{padding:6px 14px;min-height:34px;border-radius:4px;border:1px solid var(--omp-border,#333a42);background:#262c33;color:inherit;cursor:pointer;}
      button.primary{background:#0a6e86;border-color:#19d3f3;}
      .status{font-size:12px;color:var(--omp-muted,#9aa4af);min-height:16px;} .err{color:#ff6b6b;}
    </style><div class="wrap"><div class="row"><strong id="t"></strong><span class="status" id="hint"></span></div></div>`;
    const wrap = sr.querySelector(".wrap");
    sr.getElementById("t").textContent = T("title");
    sr.getElementById("hint").textContent = T("hint");
    this.#status.className = "status";
    const buttons = document.createElement("div");
    buttons.className = "row";
    const mk = (text, cls, fn) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.className = cls;
      b.addEventListener("click", fn);
      return b;
    };
    buttons.append(mk(T("reset"), "", () => {
      this.#b.transition = {};
      this.#changed();
    }), mk(T("cancel"), "", () => this.dispatchEvent(new CustomEvent("cancel"))), mk(T("save"), "primary", () => this.#save()));
    this.#fields.className = "grid";
    wrap.append(this.#canvas, this.#status, this.#fields, buttons);
    const c = this.#canvas;
    c.addEventListener("pointerdown", (e) => this.#down(e));
    c.addEventListener("pointermove", (e) => this.#move(e));
    c.addEventListener("pointerup", (e) => this.#up(e));
    c.addEventListener("pointercancel", (e) => this.#up(e));
    c.addEventListener("wheel", (e) => this.#wheel(e), {
      passive: false
    });
    new ResizeObserver(() => this.#draw()).observe(c);
    if (this.#a) this.#render();
  }
  // ---------- Daten ----------
  #marks(i) {
    return {
      durationMs: i.durationMs,
      somMs: i.somMs,
      introMs: i.introMs,
      outroMs: i.outroMs
    };
  }
  #ctx() {
    return this.#placed ? {
      a: this.#marks(this.#a),
      b: this.#marks(this.#b),
      pa: this.#placed[0],
      pb: this.#placed[1],
      tr: this.#b.transition ?? {}
    } : null;
  }
  async #loadPeaks(item) {
    const key = `${item.file}|${item.durationMs}`;
    if (this.#peaks.has(key)) return this.#draw();
    try {
      const r = await this.fetcher(`${this.base}/segue/peaks?file=${encodeURIComponent(item.file)}&durationMs=${item.durationMs}&bins=${BINS}`);
      if (!r.ok) throw new Error(String(r.status));
      this.#peaks.set(key, Uint8Array.from((await r.json()).peaks));
    } catch {
      this.#setStatus(T("peaksFailed"), true);
    }
    this.#draw();
  }
  async #plan() {
    const seq = ++this.#planSeq;
    this.#setStatus(T("loading"));
    try {
      const strip = (i) => ({
        ...i,
        id: i.id ?? "x"
      });
      const a = {
        ...strip(this.#a),
        id: "a"
      };
      const b = {
        ...strip(this.#b),
        id: "b"
      };
      if (isEmptyTransition(b.transition)) delete b.transition;
      const r = await this.fetcher(`${this.base}/segue/plan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          items: [
            a,
            b
          ]
        })
      });
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      if (seq !== this.#planSeq) return;
      this.#placed = [
        j.placed[0],
        j.placed[1]
      ];
      if (!this.#fitted) {
        this.#view = initialView(this.#placed[0], this.#placed[1], this.#canvas.clientWidth || 800);
        this.#fitted = true;
      }
      this.#setStatus("");
    } catch {
      this.#setStatus(T("planFailed"), true);
    }
    this.#renderFields();
    this.#draw();
  }
  #changed() {
    clearTimeout(this.#planTimer);
    this.#renderFields();
    this.#draw();
    this.#planTimer = window.setTimeout(() => void this.#plan(), 50);
  }
  #apply(p) {
    if (p.a) Object.assign(this.#a, p.a);
    if (p.b) Object.assign(this.#b, p.b);
    if (p.tr) this.#b.transition = {
      ...p.tr
    };
    this.#changed();
  }
  #save() {
    if (isEmptyTransition(this.#b.transition)) delete this.#b.transition;
    this.dispatchEvent(new CustomEvent("save", {
      detail: {
        a: this.#a,
        b: this.#b,
        changedA: JSON.stringify(this.#a) !== this.#origA,
        changedB: JSON.stringify(this.#b) !== this.#origB
      }
    }));
  }
  #setStatus(text, err = false) {
    this.#status.textContent = text;
    this.#status.classList.toggle("err", err);
  }
  // ---------- Zahlenfelder ----------
  #render() {
    this.#renderFields();
    this.#draw();
  }
  #renderFields() {
    if (!this.#a) return;
    const f = this.#fields;
    f.replaceChildren();
    const tr = this.#b.transition ?? {};
    const pa = this.#placed?.[0];
    const pb = this.#placed?.[1];
    const num = (label, value, set, nullable = false) => {
      const l = document.createElement("label");
      l.append(label);
      const i = document.createElement("input");
      i.type = "number";
      i.step = "10";
      i.value = value === null || value === void 0 ? "" : String(Math.round(value));
      i.addEventListener("change", () => set(i.value === "" ? nullable ? null : 0 : Number(i.value)));
      l.append(i);
      f.append(l);
    };
    const sel = (label, value, set) => {
      const l = document.createElement("label");
      l.append(label);
      const s = document.createElement("select");
      for (const c of [
        "cosine",
        "linear",
        "log"
      ]) s.add(new Option(c, c, false, c === value));
      s.addEventListener("change", () => set(s.value));
      l.append(s);
      f.append(l);
    };
    num(T("outro"), this.#a.outroMs ?? pa?.stopAtMs ?? null, (v) => this.#apply({
      a: {
        outroMs: v ?? void 0
      }
    }), true);
    num(T("start"), tr.startShiftMs ?? 0, (v) => this.#apply({
      tr: {
        ...tr,
        startShiftMs: v ?? 0
      }
    }));
    num(T("fadeOut"), tr.fadeOutMs ?? pa?.fadeOutMs ?? 0, (v) => this.#apply({
      tr: {
        ...tr,
        fadeOutMs: Math.max(0, v ?? 0)
      }
    }));
    num(T("fadeIn"), tr.fadeInMs ?? pb?.fadeInMs ?? 0, (v) => this.#apply({
      tr: {
        ...tr,
        fadeInMs: Math.max(0, v ?? 0)
      }
    }));
    sel(T("curveOut"), tr.curveOut ?? pa?.fadeOutCurve ?? "cosine", (v) => this.#apply({
      tr: {
        ...tr,
        curveOut: v
      }
    }));
    sel(T("curveIn"), tr.curveIn ?? pb?.fadeInCurve ?? "cosine", (v) => this.#apply({
      tr: {
        ...tr,
        curveIn: v
      }
    }));
    num(T("intro"), this.#b.introMs, (v) => this.#apply({
      b: {
        introMs: v ?? void 0
      }
    }), true);
    num(T("som"), this.#b.somMs, (v) => this.#apply({
      b: {
        somMs: Math.max(0, v ?? 0)
      }
    }));
  }
  // ---------- Zeichnen ----------
  #times() {
    const c = this.#ctx();
    if (!c) return {};
    const out = {};
    for (const k of [
      "aOutro",
      "bStart",
      "bIntro",
      "bSom",
      "fadeOutEnd",
      "fadeInEnd"
    ]) out[k] = markerTime(k, c);
    return out;
  }
  #draw() {
    const c = this.#canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = RULER_H + 2 * LANE_H + 6;
    if (!w) return;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    this.#view.width = w;
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const v = this.#view;
    g.fillStyle = "#9aa4af";
    g.font = "11px system-ui";
    const span = v.toMs - v.fromMs;
    const step = [
      100,
      250,
      500,
      1e3,
      2e3,
      5e3,
      1e4,
      3e4,
      6e4
    ].find((s) => s / span * w >= 70) ?? 6e4;
    for (let t = Math.ceil(v.fromMs / step) * step; t < v.toMs; t += step) {
      const x = msToX(v, t);
      g.fillRect(x, RULER_H - 6, 1, 6);
      g.fillText(fmtMs(t), x + 3, RULER_H - 8);
    }
    const p = this.#placed;
    const lanes = [
      [
        this.#a,
        p?.[0],
        RULER_H
      ],
      [
        this.#b,
        p?.[1],
        RULER_H + LANE_H + 6
      ]
    ];
    lanes.forEach(([item, pl, y0], idx) => this.#lane(g, item, pl, y0, idx === 0));
    if (!p) return;
    const times = this.#times();
    const c2 = this.#ctx();
    const trans = this.#b.transition ?? {};
    const outCurve = trans.curveOut ?? p[0].fadeOutCurve;
    const inCurve = trans.curveIn ?? p[1].fadeInCurve;
    const poly = (curve, dir, t0, len, y0, color) => {
      if (len <= 0) return;
      g.strokeStyle = color;
      g.lineWidth = 2;
      g.beginPath();
      curvePoints(curve, dir, 40).forEach(([x, gain], i) => {
        const px = msToX(v, t0 + x * len);
        const py = y0 + (1 - gain) * (LANE_H - 8) + 4;
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      });
      g.stroke();
    };
    const ao = times.aOutro;
    if (ao !== null && ao !== void 0) poly(outCurve, "out", ao, p[0].fadeOutMs, RULER_H, "#ffb020");
    poly(inCurve, "in", p[1].startMs, p[1].fadeInMs, RULER_H + LANE_H + 6, "#19d3f3");
    for (const [k, t] of Object.entries(times)) {
      if (t === null || t === void 0) continue;
      const x = msToX(v, t);
      if (x < -10 || x > w + 10) continue;
      const y0 = LANE_OF[k] === "a" ? RULER_H : RULER_H + LANE_H + 6;
      const hy = y0 + HANDLE_Y[k];
      g.strokeStyle = COLORS[k];
      g.lineWidth = k === "fadeOutEnd" || k === "fadeInEnd" ? 1 : 2;
      g.setLineDash(k === "bSom" ? [
        3,
        3
      ] : []);
      g.beginPath();
      g.moveTo(x, y0);
      g.lineTo(x, y0 + LANE_H);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = COLORS[k];
      g.beginPath();
      g.arc(x, hy, 5, 0, Math.PI * 2);
      g.fill();
      g.font = "10px system-ui";
      g.fillText(T("m_" + k), x + 7, hy + 4);
    }
    void c2;
  }
  #lane(g, item, pl, y0, isA) {
    const v = this.#view;
    const w = v.width;
    g.fillStyle = "#171b21";
    g.fillRect(0, y0, w, LANE_H);
    g.fillStyle = "#9aa4af";
    g.font = "11px system-ui";
    g.fillText(`${isA ? "A" : "B"}  ${item.title ?? item.file.split("/").pop() ?? ""}`, 6, y0 + LANE_H - 4);
    if (!pl) return;
    const peaks = this.#peaks.get(`${item.file}|${item.durationMs}`);
    const toT = (f) => pl.startMs + (f - pl.offsetMs);
    const mid = y0 + LANE_H / 2;
    const playedEnd = isA ? pl.stopAtMs !== null ? pl.stopAtMs + pl.fadeOutMs : item.durationMs : item.durationMs;
    for (let x = 0; x < w; x++) {
      const t0 = xToMs(v, x);
      const t1 = xToMs(v, x + 1);
      const f0 = t0 - pl.startMs + pl.offsetMs;
      const f1 = t1 - pl.startMs + pl.offsetMs;
      if (f1 < 0 || f0 > item.durationMs || !peaks) continue;
      const b0 = Math.max(0, Math.floor(f0 / item.durationMs * peaks.length));
      const b1 = Math.min(peaks.length, Math.max(b0 + 1, Math.ceil(f1 / item.durationMs * peaks.length)));
      let m = 0;
      for (let b = b0; b < b1; b++) if (peaks[b] > m) m = peaks[b];
      const hh = m / 255 * (LANE_H / 2 - 4);
      const inPlay = f0 >= pl.offsetMs && f0 <= playedEnd;
      g.fillStyle = inPlay ? isA ? "#c98a1a" : "#13a9c4" : "#3a4048";
      g.fillRect(x, mid - hh, 1, Math.max(1, hh * 2));
    }
    void toT;
  }
  // ---------- Maus ----------
  #pos(e) {
    return e.clientX - this.#canvas.getBoundingClientRect().left;
  }
  #posY(e) {
    return e.clientY - this.#canvas.getBoundingClientRect().top;
  }
  #down(e) {
    const x = this.#pos(e);
    this.#canvas.setPointerCapture(e.pointerId);
    if (e.shiftKey) {
      this.#drag = {
        pan: x,
        from: this.#view.fromMs,
        to: this.#view.toMs
      };
      return;
    }
    const k = this.#hit(x, this.#posY(e));
    if (k) this.#drag = {
      kind: k
    };
    else this.#drag = {
      pan: x,
      from: this.#view.fromMs,
      to: this.#view.toMs
    };
  }
  #move(e) {
    const x = this.#pos(e);
    const d = this.#drag;
    if (!d) {
      this.#canvas.style.cursor = this.#hit(x, this.#posY(e)) ? "ew-resize" : "default";
      return;
    }
    if ("pan" in d) {
      const dms = (x - d.pan) / this.#view.width * (d.to - d.from);
      this.#view = {
        ...this.#view,
        fromMs: d.from - dms,
        toMs: d.to - dms
      };
      this.#draw();
      return;
    }
    const c = this.#ctx();
    if (c) this.#apply(dragMarker(d.kind, xToMs(this.#view, x), c));
  }
  #up(e) {
    this.#drag = null;
    if (this.#canvas.hasPointerCapture(e.pointerId)) this.#canvas.releasePointerCapture(e.pointerId);
  }
  #wheel(e) {
    e.preventDefault();
    const at = xToMs(this.#view, this.#pos(e));
    const max = Math.max(this.#a?.durationMs ?? 6e4, this.#b?.durationMs ?? 6e4) * 2;
    this.#view = zoomView(this.#view, at, e.deltaY > 0 ? 1.25 : 0.8, max);
    this.#draw();
  }
};
if (!customElements.get("omp-segue-editor")) customElements.define("omp-segue-editor", SegueEditor);
export {
  SegueEditor
};
