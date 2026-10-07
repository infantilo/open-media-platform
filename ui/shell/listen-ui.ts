// Oberfläche des Abhör-Controllers (Dienst: listen.ts). Eingeklappt ein
// schmaler Streifen unten links, aufgeklappt ein Pult-Panel: großes
// Lautstärke-Poti, frei belegbare Schnellwahl-Tasten, Kanalmodus
// (Stereo/Mono/L/R), Kopfhörer-Ausgleich, A/V-Sync und Pegel.
import { t, t as tt } from "./i18n.ts";
import type { ChannelMode, ListenService, ListenStatus } from "./listen.ts";
import { PRESET_SLOTS } from "./listen.ts";

const STATUS_TEXT: Record<ListenStatus, string> = {
  idle: "",
  connecting: "verbinde …",
  playing: "",
  reconnecting: "verbinde neu …",
  error: t("listen.a27ba8"),
};

const EXPANDED_KEY = "omp-listen-expanded";
const KNOB_ARC_START = 135; // Grad, 0° = oben, im Uhrzeigersinn
const KNOB_ARC_SPAN = 270;
const NS = "http://www.w3.org/2000/svg";

const CSS = `
/* Eigenständige Basis-Optik (specificity 0): im Shadow-DOM eines Node-Panels
   greift design-tokens.css' button/input-Reset nicht. */
:where(.omp-listen) button { font-family:var(--omp-font); font-size:var(--omp-font-size-xs); color:var(--omp-text);
  background:var(--omp-surface-raised); border:1px solid var(--omp-border); border-radius:var(--omp-radius);
  padding:4px 8px; cursor:pointer; }
:where(.omp-listen) button:hover { border-color:var(--omp-text-dim); }
:where(.omp-listen) select, :where(.omp-listen) input:not([type=range]) { font-family:var(--omp-font);
  font-size:var(--omp-font-size-sm); color:var(--omp-text); background:#060912; border:1px solid var(--omp-border);
  border-radius:var(--omp-radius); padding:5px 8px; }
:where(.omp-listen) .omp-btn-primary { background:linear-gradient(90deg,#0fb8e6,#2f8cff 55%,#8b5cf6); border-color:transparent; color:#fff; font-weight:600; }
.omp-listen { color:var(--omp-text-dim); }
.omp-listen { position:fixed; left:var(--omp-space-2); bottom:var(--omp-space-2); z-index:1000; display:none;
  flex-direction:column; align-items:flex-start; gap:6px; font-family:var(--omp-font); font-size:var(--omp-font-size-xs);
  color:var(--omp-text-dim); }
.omp-listen-bar { display:flex; align-items:center; gap:var(--omp-space-3); padding:6px var(--omp-space-3);
  background:var(--omp-surface); border:1px solid var(--omp-border); border-radius:var(--omp-radius);
  box-shadow:0 2px 8px rgba(0,0,0,.3); }
.omp-listen-bar .title { color:var(--omp-text); font-weight:700; letter-spacing:.04em; }
.omp-listen-src { max-width:190px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--omp-accent-cyan); }
.omp-listen-panel { display:none; flex-direction:column; gap:14px; width:340px; box-sizing:border-box; padding:18px;
  border-radius:16px; border:1px solid rgba(110,150,255,.22);
  background:linear-gradient(180deg,rgba(20,29,48,.98),rgba(8,12,22,.99));
  box-shadow:0 24px 70px rgba(0,0,0,.6),0 0 50px rgba(47,140,255,.1),inset 0 1px 0 rgba(255,255,255,.06); }
.omp-listen.open .omp-listen-panel { display:flex; }
.omp-listen.embedded { position:static; display:block; }
.omp-listen-panel.embedded { display:flex; width:auto; box-shadow:none; border-radius:10px; }
.omp-listen-sec { font-size:10px; font-weight:700; letter-spacing:.16em; text-transform:uppercase; color:var(--omp-text-dim); }
.omp-listen-knobwrap { display:flex; flex-direction:column; align-items:center; gap:4px; }
.omp-listen-knob { width:150px; height:150px; touch-action:none; cursor:grab; outline:none; user-select:none; }
.omp-listen-knob:focus-visible { filter:drop-shadow(0 0 6px rgba(25,211,243,.6)); }
.omp-listen-knob:active { cursor:grabbing; }
.omp-listen-db { font-size:20px; font-weight:700; color:var(--omp-text); font-variant-numeric:tabular-nums; margin-top:-20px; pointer-events:none; }
.omp-listen-meters { display:flex; flex-direction:column; gap:3px; width:100%; }
.omp-listen-meters div { height:5px; border-radius:3px; background:#050810; overflow:hidden; }
.omp-listen-meters i { display:block; height:100%; width:0; background:var(--omp-accent-gradient); }
.omp-listen-presets { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
.omp-listen-preset { min-height:44px; padding:6px 4px; border-radius:8px; font-size:11px; font-weight:600; line-height:1.15;
  overflow:hidden; background:linear-gradient(180deg,var(--omp-metal-light),var(--omp-metal-mid)); }
.omp-listen-preset.empty { background:transparent; border-style:dashed; color:var(--omp-text-disabled); font-weight:400; }
.omp-listen-preset.live { color:#fff; border-color:var(--omp-accent-cyan);
  background:linear-gradient(180deg,rgba(25,211,243,.35),rgba(47,140,255,.18)); box-shadow:0 0 12px rgba(25,211,243,.35); }
.omp-listen-preset.assigning { border-color:var(--omp-cue); color:var(--omp-cue); animation:omp-pulse 1s infinite; }
.omp-listen-row { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.omp-listen-seg { display:flex; }
.omp-listen-seg button { border-radius:0; padding:4px 10px; }
.omp-listen-seg button:first-child { border-radius:6px 0 0 6px; }
.omp-listen-seg button:last-child { border-radius:0 6px 6px 0; }
.omp-listen-seg button + button { margin-left:-1px; }
.omp-listen button.on { color:var(--omp-accent-cyan); border-color:var(--omp-accent-cyan); background:rgba(25,211,243,.1); }
.omp-listen input[type=range] { padding:0; width:110px; }
.omp-listen-hint { font-size:10px; color:var(--omp-text-disabled); }
`;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const [x1, y1] = polar(cx, cy, r, from);
  const [x2, y2] = polar(cx, cy, r, to);
  return `M ${x1} ${y1} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`;
}

/** Großes Lautstärke-Poti: vertikaler Drag, Mausrad, Pfeiltasten, Doppelklick = Standard. */
function buildKnob(initial: number, onChange: (v: number) => void) {
  const root = svg("svg", { viewBox: "0 0 150 150", class: "omp-listen-knob", tabindex: "0", role: "slider",
    "aria-label": t("listen.b34670"), "aria-valuemin": "0", "aria-valuemax": "100" });
  const defs = svg("defs", {});
  const grad = svg("linearGradient", { id: "omp-lk-grad", x1: "0", y1: "1", x2: "1", y2: "0" });
  grad.append(svg("stop", { offset: "0", "stop-color": "#19d3f3" }), svg("stop", { offset: "1", "stop-color": "#a45cff" }));
  const body = svg("radialGradient", { id: "omp-lk-body", cx: "35%", cy: "28%", r: "80%" });
  body.append(
    svg("stop", { offset: "0", "stop-color": "#59616c" }),
    svg("stop", { offset: "0.45", "stop-color": "#2e343c" }),
    svg("stop", { offset: "1", "stop-color": "#12151a" }),
  );
  defs.append(grad, body);
  const track = svg("path", { d: arcPath(75, 75, 64, KNOB_ARC_START, KNOB_ARC_START + KNOB_ARC_SPAN), fill: "none",
    stroke: "#0b101b", "stroke-width": "8", "stroke-linecap": "round" });
  const fill = svg("path", { d: "", fill: "none", stroke: "url(#omp-lk-grad)", "stroke-width": "8", "stroke-linecap": "round" });
  const ticks = svg("g", {});
  for (let i = 0; i <= 10; i++) {
    const deg = KNOB_ARC_START + (KNOB_ARC_SPAN * i) / 10;
    const [x1, y1] = polar(75, 75, 54, deg);
    const [x2, y2] = polar(75, 75, i % 5 === 0 ? 48 : 50, deg);
    ticks.append(svg("line", { x1: String(x1), y1: String(y1), x2: String(x2), y2: String(y2), stroke: "#3b4658", "stroke-width": "1.5" }));
  }
  const cap = svg("circle", { cx: "75", cy: "75", r: "44", fill: "url(#omp-lk-body)", stroke: "#06080c", "stroke-width": "2" });
  const rim = svg("circle", { cx: "75", cy: "75", r: "44", fill: "none", stroke: "rgba(255,255,255,.1)", "stroke-width": "1" });
  const pointer = svg("line", { x1: "75", y1: "75", x2: "75", y2: "40", stroke: "#19d3f3", "stroke-width": "4", "stroke-linecap": "round" });
  root.append(defs, track, fill, ticks, cap, rim, pointer);

  let value = initial;
  const paint = (v: number) => {
    value = v;
    const deg = KNOB_ARC_START + KNOB_ARC_SPAN * v;
    fill.setAttribute("d", v > 0.003 ? arcPath(75, 75, 64, KNOB_ARC_START, deg) : "");
    pointer.setAttribute("transform", `rotate(${deg - 360} 75 75)`);
    root.setAttribute("aria-valuenow", String(Math.round(v * 100)));
  };
  const set = (v: number) => {
    const c = Math.max(0, Math.min(1, v));
    if (c === value) return;
    paint(c);
    onChange(c);
  };
  let startY = 0;
  let startV = 0;
  root.addEventListener("pointerdown", (ev) => {
    root.setPointerCapture(ev.pointerId);
    startY = ev.clientY;
    startV = value;
    root.focus();
  });
  root.addEventListener("pointermove", (ev) => {
    if (!root.hasPointerCapture(ev.pointerId)) return;
    // Shift = Feinregelung. 200 px = voller Weg.
    set(startV + (startY - ev.clientY) / (ev.shiftKey ? 800 : 200));
  });
  root.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    set(value - Math.sign(ev.deltaY) * (ev.shiftKey ? 0.005 : 0.02));
  }, { passive: false });
  root.addEventListener("keydown", (ev) => {
    const step = ev.shiftKey ? 0.005 : 0.02;
    if (ev.key === "ArrowUp" || ev.key === "ArrowRight") set(value + step);
    else if (ev.key === "ArrowDown" || ev.key === "ArrowLeft") set(value - step);
    else return;
    ev.preventDefault();
  });
  root.addEventListener("dblclick", () => set(0.8));
  paint(initial);
  return { el: root, paint };
}

function buildControls(service: ListenService): { panel: HTMLElement; repaint: () => void } {
  const panel = document.createElement("div");
  panel.className = "omp-listen-panel";
  const style = document.createElement("style");
  style.textContent = CSS;

  const knobWrap = document.createElement("div");
  knobWrap.className = "omp-listen-knobwrap";
  const knob = buildKnob(service.state.volume, (v) => service.setVolume(v));
  const db = document.createElement("div");
  db.className = "omp-listen-db";
  knobWrap.append(knob.el, db);

  const meters = document.createElement("div");
  meters.className = "omp-listen-meters";
  const bars = [0, 1].map(() => {
    const track = document.createElement("div");
    const fill = document.createElement("i");
    track.append(fill);
    meters.append(track);
    return fill;
  });

  // Schnellwahl
  const presetHead = document.createElement("div");
  presetHead.className = "omp-listen-row";
  const presetTitle = document.createElement("span");
  presetTitle.className = "omp-listen-sec";
  presetTitle.textContent = t("listen.977a2d");
  const assignBtn = document.createElement("button");
  assignBtn.textContent = tt("y.assign");
  assignBtn.title = t("listen.c8108d");
  presetHead.append(presetTitle, assignBtn);
  const presetGrid = document.createElement("div");
  presetGrid.className = "omp-listen-presets";
  const hint = document.createElement("div");
  hint.className = "omp-listen-hint";
  let assigning = false;
  const presetBtns: HTMLButtonElement[] = [];

  // Inline-Editor statt Browser-Prompt: Quelle wählen, Beschriftung, Speichern/Leeren.
  const editor = document.createElement("div");
  editor.style.cssText =
    "display:none;flex-direction:column;gap:6px;padding:10px;border-radius:8px;" +
    "border:1px solid var(--omp-cue);background:rgba(251,140,0,.06);";
  const edTitle = document.createElement("div");
  edTitle.className = "omp-listen-sec";
  const edSelect = document.createElement("select");
  const edName = document.createElement("input");
  edName.placeholder = t("listen.ab6eb8");
  edName.maxLength = 18;
  const edRow = document.createElement("div");
  edRow.style.cssText = "display:flex;gap:6px;justify-content:flex-end;";
  const edClear = document.createElement("button");
  edClear.textContent = t("listen.33dddf");
  const edCancel = document.createElement("button");
  edCancel.textContent = t("listen.4b9727");
  const edSave = document.createElement("button");
  edSave.textContent = t("listen.b97d23");
  edSave.className = "omp-btn-primary";
  edRow.append(edClear, edCancel, edSave);
  editor.append(edTitle, edSelect, edName, edRow);
  let editSlot = -1;
  const closeEditor = () => {
    editSlot = -1;
    editor.style.display = "none";
  };
  edCancel.addEventListener("click", closeEditor);
  edClear.addEventListener("click", () => {
    service.assignPreset(editSlot, null);
    closeEditor();
  });
  edSave.addEventListener("click", () => {
    if (edSelect.value) {
      service.assignPreset(editSlot, { name: edName.value.trim() || edSelect.value, sourceLabel: edSelect.value });
    }
    closeEditor();
  });
  edSelect.addEventListener("change", () => {
    if (!edName.value || edName.dataset.auto === "1") {
      edName.value = edSelect.value.slice(0, 18);
      edName.dataset.auto = "1";
    }
  });
  edName.addEventListener("input", () => delete edName.dataset.auto);

  const assignSlot = async (slot: number) => {
    const labels = await service.availableLabels();
    const existing = service.state.presets[slot];
    if (existing && !labels.includes(existing.sourceLabel)) labels.unshift(existing.sourceLabel);
    if (labels.length === 0) {
      hint.textContent = t("listen.c15782");
      return;
    }
    editSlot = slot;
    edTitle.textContent = t("listen.24e79f", { p0: slot + 1 });
    edSelect.replaceChildren(...labels.map((l) => {
      const o = document.createElement("option");
      o.value = o.textContent = l;
      return o;
    }));
    edSelect.value = existing?.sourceLabel ?? (labels.includes(service.state.sourceLabel) ? service.state.sourceLabel : labels[0]);
    edName.value = existing?.name ?? edSelect.value.slice(0, 18);
    edName.dataset.auto = existing ? "" : "1";
    edClear.style.display = existing ? "" : "none";
    editor.style.display = "flex";
    hint.textContent = "";
  };

  for (let i = 0; i < PRESET_SLOTS; i++) {
    const b = document.createElement("button");
    b.className = "omp-listen-preset";
    b.addEventListener("click", async () => {
      const preset = service.state.presets[i];
      if (assigning || !preset) {
        await assignSlot(i);
        assigning = false;
        paint();
        return;
      }
      hint.textContent = (await service.selectByLabel(preset.sourceLabel))
        ? ""
        : t("listen.e7d29a", { p0: preset.sourceLabel });
    });
    b.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      void assignSlot(i);
    });
    presetBtns.push(b);
    presetGrid.append(b);
  }
  assignBtn.addEventListener("click", () => {
    assigning = !assigning;
    paint();
  });

  // Kanalmodus
  const modeRow = document.createElement("div");
  modeRow.className = "omp-listen-row";
  const modeTitle = document.createElement("span");
  modeTitle.className = "omp-listen-sec";
  modeTitle.textContent = t("listen.45cef4");
  const seg = document.createElement("div");
  seg.className = "omp-listen-seg";
  const modes: [ChannelMode, string, string][] = [
    ["stereo", "ST", t("listen.bbc45d")],
    ["mono", "MONO", t("listen.ca293d")],
    ["left", "L", t("listen.7834b5")],
    ["right", "R", t("listen.878f43")],
  ];
  const modeBtns = modes.map(([m, label, tip]) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = tip;
    b.addEventListener("click", () => service.setChannelMode(m));
    seg.append(b);
    return b;
  });
  modeRow.append(modeTitle, seg);

  // Kopfhörer-Ausgleich
  const hpRow = document.createElement("div");
  hpRow.className = "omp-listen-row";
  const hpBtn = document.createElement("button");
  hpBtn.textContent = t("listen.c5103a");
  hpBtn.title =
    t("listen.178039") +
    t("listen.5d839e");
  hpBtn.addEventListener("click", () => service.setHeadphone(!service.state.headphone));
  const xf = document.createElement("input");
  xf.type = "range";
  xf.min = "0";
  xf.max = "1";
  xf.step = "0.05";
  xf.title = t("listen.63e7ec");
  xf.addEventListener("input", () => service.setCrossfeed(parseFloat(xf.value)));
  hpRow.append(hpBtn, xf);

  // Mute / Dim / Sync
  const ctlRow = document.createElement("div");
  ctlRow.className = "omp-listen-row";
  const mute = document.createElement("button");
  mute.textContent = t("listen.00cd7b");
  mute.addEventListener("click", () => service.setMuted(!service.state.muted));
  const dim = document.createElement("button");
  dim.textContent = "Dim";
  dim.title = t("listen.f0bddc");
  dim.addEventListener("click", () => service.setDim(!service.state.dim));
  const sync = document.createElement("input");
  sync.type = "range";
  sync.min = "0";
  sync.max = "1000";
  sync.step = "10";
  sync.addEventListener("input", () => service.setSync(parseInt(sync.value, 10)));
  const syncLabel = document.createElement("span");
  syncLabel.style.cssText = "min-width:54px;font-variant-numeric:tabular-nums;";
  const syncWrap = document.createElement("label");
  syncWrap.title = t("listen.669306");
  syncWrap.style.cssText = "display:flex;align-items:center;gap:6px;";
  syncWrap.append("A/V", sync, syncLabel);
  const btnPair = document.createElement("div");
  btnPair.style.cssText = "display:flex;gap:6px;";
  btnPair.append(mute, dim);
  ctlRow.append(btnPair, syncWrap);

  panel.append(style, knobWrap, meters, presetHead, presetGrid, editor, hint, modeRow, hpRow, ctlRow);

  const mark = (b: HTMLElement, on: boolean) => b.classList.toggle("on", on);
  let raf = 0;
  const frame = () => {
    if (!panel.isConnected) return; // aus dem DOM entfernt: Schleife endet
    if (panel.offsetParent !== null) {
      const [l, r] = service.levels();
      for (const [fillEl, v] of [[bars[0], l], [bars[1], r]] as const) {
        const d = v > 0 ? 20 * Math.log10(v) : -60;
        fillEl.style.width = `${Math.max(0, Math.min(100, ((d + 60) / 60) * 100))}%`;
      }
    }
    raf = requestAnimationFrame(frame);
  };

  const paint = () => {
    if (!panel.isConnected && wasConnected) {
      service.removeEventListener("change", paint); // Panel wurde entfernt
      return;
    }
    if (panel.isConnected) wasConnected = true;
    const s = service.state;
    knob.paint(s.volume);
    db.textContent = s.muted ? "MUTE" : s.volume <= 0 ? "−∞ dB" : `${(40 * Math.log10(s.volume)).toFixed(1)} dB`;
    sync.value = String(s.syncMs);
    syncLabel.textContent = `+${s.syncMs} ms`;
    xf.value = String(s.crossfeed);
    xf.disabled = !s.headphone;
    mark(mute, s.muted);
    mark(dim, s.dim);
    mark(hpBtn, s.headphone);
    modes.forEach(([m], i) => mark(modeBtns[i], s.channelMode === m));
    assignBtn.classList.toggle("on", assigning);
    presetBtns.forEach((b, i) => {
      const p = s.presets[i];
      b.textContent = p ? p.name : assigning ? "＋" : "—";
      b.title = p ? `${p.sourceLabel}\n(Rechtsklick: neu belegen)` : t("listen.85d6d3");
      b.classList.toggle("empty", !p);
      b.classList.toggle("live", !!p && p.sourceLabel === s.sourceLabel);
      b.classList.toggle("assigning", assigning);
    });
    cancelAnimationFrame(raf);
    if (panel.isConnected) raf = requestAnimationFrame(frame);
  };
  let wasConnected = false;
  service.addEventListener("change", paint);
  // Erstes Zeichnen erst, wenn das Element im DOM hängt (isConnected).
  queueMicrotask(paint);
  setTimeout(paint, 0);
  return { panel, repaint: paint };
}

/** Controller-Inhalt zum Einbetten (z. B. ins Eigenschaften-Fenster des Audiomonitors). */
export function buildListenControls(service: ListenService): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "omp-listen embedded";
  const { panel } = buildControls(service);
  panel.classList.add("embedded");
  wrap.append(panel);
  return wrap;
}

export function buildListenWidget(service: ListenService): HTMLElement {
  const host = document.createElement("div");
  host.className = "omp-listen";
  host.setAttribute("data-role", "listen-widget");

  // --- Streifen (immer sichtbar, solange abgehört wird) ---
  const bar = document.createElement("div");
  bar.className = "omp-listen-bar";
  const expand = document.createElement("button");
  expand.title = t("listen.6fd701");
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = t("listen.30f29f");
  const barSrc = document.createElement("span");
  barSrc.className = "omp-listen-src";
  const status = document.createElement("span");
  const stopBtn = document.createElement("button");
  stopBtn.textContent = "■";
  stopBtn.title = t("listen.756de8");
  stopBtn.addEventListener("click", () => service.stop());
  bar.append(expand, title, barSrc, status, stopBtn);

  const { panel, repaint } = buildControls(service);
  host.append(panel, bar);

  let open = false;
  try { open = localStorage.getItem(EXPANDED_KEY) === "1"; } catch { /* egal */ }
  expand.addEventListener("click", () => {
    open = !open;
    try { localStorage.setItem(EXPANDED_KEY, open ? "1" : "0"); } catch { /* egal */ }
    paintBar();
    repaint();
  });

  const paintBar = () => {
    const s = service.state;
    host.style.display = s.nodeId !== null ? "flex" : "none";
    host.classList.toggle("open", open);
    expand.textContent = open ? "▾" : "🔊";
    barSrc.textContent = s.sourceLabel;
    status.textContent = STATUS_TEXT[s.status];
  };
  service.addEventListener("change", paintBar);
  paintBar();
  return host;
}
