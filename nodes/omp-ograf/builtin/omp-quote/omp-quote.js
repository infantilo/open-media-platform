// ERZEUGT vom OGraf-Editor (Leinwand) — Änderungen bitte in der Leinwand machen, sie werden beim Speichern überschrieben.
// Laufzeit der Designer-Vorlagen des OGraf-Editors (Kapitel 90.5). Diese EINE Datei wird
//  (a) vom Editor für die Leinwand-Vorschau benutzt und
//  (b) als Text in jede mit der Leinwand gebaute Vorlage kopiert (`<id>.js` = diese Datei + `export default createSceneElement(...)`),
// damit Vorschau und Sendung denselben Code ausführen. Reines JavaScript ohne Abhängigkeiten, ES-Modul.
// Das Szenenmodell steht in `scene.json` des Pakets (Format `omp-ograf-scene/1`, s. scene.ts).

/** Ersetzt `{{schluessel}}` durch Werte aus `data` (fehlend = leer). */
export function bindText(text, data) {
  return String(text ?? "").replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, k) => {
    const v = data ? data[k] : undefined;
    return v === undefined || v === null ? "" : String(v);
  });
}

/** Alle Animationsarten: Anzeigename-Schlüssel → Start-Keyframes (Zustand „weg“) und Ziel „da“. */
export const ANIM_TYPES = ["none", "fade", "fromLeft", "fromRight", "fromTop", "fromBottom", "scale", "wipe"];

/** Keyframes für Einblenden (`dir` = "in") bzw. Ausblenden ("out", rückwärts). `dist` = Weg in Bildpunkten. */
export function keyframesFor(type, dir, dist = 80) {
  const slide = (t) => [{ opacity: 0, transform: t }, { opacity: 1, transform: "none" }];
  let pair;
  switch (type) {
    case "fade": pair = [{ opacity: 0 }, { opacity: 1 }]; break;
    case "fromLeft": pair = slide(`translateX(${-dist}px)`); break;
    case "fromRight": pair = slide(`translateX(${dist}px)`); break;
    case "fromTop": pair = slide(`translateY(${-dist}px)`); break;
    case "fromBottom": pair = slide(`translateY(${dist}px)`); break;
    case "scale": pair = slide("scale(0.8)"); break;
    case "wipe": pair = [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }]; break;
    default: return null;
  }
  return dir === "in" ? pair : [pair[1], pair[0]];
}

/** Schrift verkleinern, bis der Text ins Feld passt (nur bei `e.autofit`, nicht unter `e.minSize`). Braucht ein eingehängtes Element. */
export function autofit(inner, e) {
  if (e.kind !== "text" || !e.autofit) return;
  let size = e.size || 40;
  const min = e.minSize || 12;
  const s = inner.style;
  const keep = s.alignItems;
  s.alignItems = "flex-start"; // sonst zählt der Überstand nach oben nicht in scrollHeight
  s.fontSize = `${size}px`;
  for (let guard = 0; guard < 60 && size > min && (inner.scrollHeight > inner.clientHeight + 1 || inner.scrollWidth > inner.clientWidth + 1); guard++) {
    size = Math.max(min, size - Math.max(1, Math.round(size * 0.04)));
    s.fontSize = `${size}px`;
  }
  s.alignItems = keep;
}

const FONTS = new Set();
/** Schriftdateien der Szene als Schriftfamilien anmelden; Ergebnis: Versprechen, das nach dem Laden aller erfüllt ist. */
function loadFonts(scene, resolveAsset) {
  if (typeof FontFace === "undefined" || !document.fonts || !resolveAsset) return Promise.resolve();
  const jobs = [];
  for (const f of scene.fonts || []) {
    const url = resolveAsset(f.file);
    if (!url) continue;
    const key = `${f.family}|${url}`;
    if (FONTS.has(key)) continue;
    FONTS.add(key);
    const face = new FontFace(f.family, `url("${url}")`);
    document.fonts.add(face);
    jobs.push(face.load().catch(() => {}));
  }
  return Promise.all(jobs).then(() => {});
}

/** Ist das Element im Schritt `step` sichtbar? (`from` Standard 0, `to` −1 = bis zum letzten Schritt.) */
export function inStep(e, step) {
  const from = e.from ?? 0;
  const to = e.to ?? -1;
  return step >= from && (to < 0 || step <= to);
}

/** Hervorhebe-Effekte für Aktionen (kehren zum Ausgangszustand zurück). */
export const EFFECT_TYPES = ["pulse", "flash", "shake", "bounce"];
export function effectKeyframes(type) {
  switch (type) {
    case "pulse": return [{ transform: "scale(1)" }, { transform: "scale(1.12)" }, { transform: "scale(1)" }];
    case "flash": return [{ opacity: 1 }, { opacity: 0.15 }, { opacity: 1 }];
    case "shake": return [{ transform: "translateX(0)" }, { transform: "translateX(-14px)" }, { transform: "translateX(14px)" }, { transform: "translateX(-10px)" }, { transform: "translateX(10px)" }, { transform: "translateX(0)" }];
    case "bounce": return [{ transform: "translateY(0)" }, { transform: "translateY(-28px)" }, { transform: "translateY(0)" }];
    default: return null;
  }
}

function applyBox(el, e) {
  const s = el.style;
  s.position = "absolute";
  s.left = `${e.x}px`;
  s.top = `${e.y}px`;
  s.width = `${e.w}px`;
  s.height = `${e.h}px`;
  s.transform = e.rotation ? `rotate(${e.rotation}deg)` : "none";
  s.boxSizing = "border-box";
}

function paint(inner, e, data) {
  const s = inner.style;
  const color = (c) => bindText(c, data);
  if (e.kind === "rect") {
    s.background = color(e.fill || "transparent");
    s.borderRadius = `${e.radius || 0}px`;
    s.border = e.strokeW ? `${e.strokeW}px solid ${color(e.stroke || "#fff")}` : "none";
  } else if (e.kind === "text") {
    inner.textContent = bindText(e.text, data);
    s.font = `${e.weight || 400} ${e.size || 40}px/${e.lineHeight || 1.2} ${e.font || "system-ui, sans-serif"}`;
    s.color = color(e.color || "#fff");
    s.textAlign = e.align || "left";
    s.whiteSpace = "pre-wrap";
    s.overflow = "hidden";
    s.display = "flex";
    s.alignItems = { top: "flex-start", middle: "center", bottom: "flex-end" }[e.valign || "top"];
    s.justifyContent = { left: "flex-start", center: "center", right: "flex-end" }[e.align || "left"];
    s.background = e.bg ? color(e.bg) : "transparent";
    s.padding = `${e.padding || 0}px`;
    s.borderRadius = `${e.radius || 0}px`;
  } else if (e.kind === "image") {
    s.objectFit = e.fit || "contain";
    s.borderRadius = `${e.radius || 0}px`;
  }
}

/**
 * Baut die Szene in `root` (ShadowRoot oder Element) und liefert den Griff `{play, stop, update, destroy, stage}`.
 * `opts.resolveAsset(datei) → URL`, `opts.scale() → Faktor` (Standard: Breite des Fensters / Szenenbreite),
 * `opts.editor = true` zeigt Zonen als gestrichelte Rahmen und spielt keine Animation (alles sichtbar).
 */
export function renderScene(root, scene, data, opts = {}) {
  const stage = document.createElement("div");
  stage.style.cssText = `position:absolute;left:0;top:0;width:${scene.width}px;height:${scene.height}px;transform-origin:0 0;overflow:hidden`;
  const scaleOf = opts.scale || (() => (window.innerWidth || scene.width) / scene.width);
  const fit = () => { stage.style.transform = `scale(${scaleOf()})`; };
  fit();
  const onResize = () => fit();
  window.addEventListener("resize", onResize);
  const items = [];
  for (const e of scene.elements || []) {
    const wrap = document.createElement("div");
    applyBox(wrap, e);
    wrap.style.opacity = String(e.opacity ?? 1);
    if (opts.editor && opts.step !== undefined && !inStep(e, opts.step)) wrap.style.opacity = String((e.opacity ?? 1) * 0.2);
    wrap.dataset.elementId = e.id;
    let inner;
    if (e.kind === "image") {
      inner = document.createElement("img");
      inner.alt = "";
      if (e.file && opts.resolveAsset) inner.src = opts.resolveAsset(e.file);
    } else {
      inner = document.createElement("div");
    }
    inner.style.cssText += ";width:100%;height:100%;box-sizing:border-box";
    if (e.kind === "zone") {
      wrap.setAttribute("data-ograf-zone", e.zone || "zone");
      if (opts.editor) inner.style.outline = "2px dashed #00c8ff";
    }
    paint(inner, e, data);
    wrap.append(inner);
    stage.append(wrap);
    items.push({ e, wrap, inner, anims: [], shown: false });
  }
  root.append(stage);
  const fitAll = () => { for (const it of items) autofit(it.inner, it.e); };
  fitAll();
  const ready = loadFonts(scene, opts.resolveAsset).then(fitAll);
  const clear = (it) => { for (const a of it.anims) a.cancel(); it.anims = []; };
  const run = (it, dir) => {
    const spec = it.e.anim && it.e.anim[dir];
    const kf = spec ? keyframesFor(spec.type, dir) : null;
    clear(it);
    // Zonen melden ihr Rechteck über das umgebende Element; außerhalb ihrer Schritte gelten sie als unsichtbar
    if (it.e.kind === "zone") it.wrap.style.visibility = dir === "in" ? "visible" : "hidden";
    if (!kf) { it.inner.style.visibility = dir === "in" ? "visible" : "hidden"; return Promise.resolve(); }
    it.inner.style.visibility = "visible";
    const a = it.inner.animate(kf, { duration: spec.ms ?? 400, delay: spec.delay ?? 0, easing: spec.ease || "ease-out", fill: "both" });
    it.anims.push(a);
    return a.finished.catch(() => {});
  };
  if (!opts.editor) {
    for (const it of items) {
      it.inner.style.visibility = "hidden";
      if (it.e.kind === "zone") it.wrap.style.visibility = "hidden";
    }
  }
  const goto = (step) => Promise.all(items.map((it) => {
    const vis = inStep(it.e, step);
    if (vis && !it.shown) { it.shown = true; return run(it, "in"); }
    if (!vis && it.shown) { it.shown = false; return run(it, "out"); }
    return Promise.resolve();
  }));
  /** Aktion der Szene abspielen (Effekte auf Elementen); unbekannte Aktion/Elemente werden übersprungen. */
  const action = (id) => {
    const a = (scene.actions || []).find((x) => x.id === id);
    if (!a) return Promise.resolve();
    const jobs = [];
    for (const fx of a.effects || []) {
      const it = items.find((i) => i.e.id === fx.target);
      const kf = effectKeyframes(fx.type);
      if (!it || !kf) continue;
      const anim = it.inner.animate(kf, { duration: Math.max(50, fx.ms || 600), delay: fx.delay || 0, easing: "ease-in-out" });
      jobs.push(anim.finished.catch(() => {}));
    }
    return Promise.all(jobs);
  };
  /** Zeitleisten-Wiedergabekopf (nur Editor): alle Animationen einer Richtung angehalten bei `t` ms zeigen. */
  const scrub = (dir, t) => {
    for (const it of items) {
      clear(it);
      const spec = it.e.anim && it.e.anim[dir];
      const kf = spec ? keyframesFor(spec.type, dir) : null;
      it.inner.style.visibility = "visible";
      if (!kf) continue;
      const a = it.inner.animate(kf, { duration: spec.ms ?? 400, delay: spec.delay ?? 0, easing: spec.ease || "ease-out", fill: "both" });
      a.pause();
      a.currentTime = t;
      it.anims.push(a);
    }
  };
  const unscrub = () => { for (const it of items) { clear(it); it.inner.style.visibility = "visible"; } };
  return {
    stage,
    ready,
    action,
    scrub,
    unscrub,
    goto,
    play: (step = 0) => goto(step),
    stop: () => Promise.all(items.filter((it) => it.shown).map((it) => { it.shown = false; return run(it, "out"); })),
    update(next) { for (const it of items) { paint(it.inner, it.e, next); autofit(it.inner, it.e); } },
    destroy() { window.removeEventListener("resize", onResize); for (const it of items) clear(it); stage.remove(); },
  };
}

/** Die Web-Component-Klasse, die OGraf als `default export` erwartet. `base` = `import.meta.url` des Hauptmoduls. */
export function createSceneElement(scene, base) {
  return class SceneGraphic extends HTMLElement {
    constructor() {
      super();
      const sr = this.attachShadow({ mode: "open" });
      const st = document.createElement("style");
      st.textContent = ":host{position:fixed;inset:0;display:block;pointer-events:none}";
      sr.append(st);
    }
    async load(p) {
      this._data = (p && p.data) || {};
      this._h = renderScene(this.shadowRoot, scene, this._data, { resolveAsset: (f) => new URL(f, base).href });
      await this._h.ready;
      return { statusCode: 200 };
    }
    async dispose() { if (this._h) this._h.destroy(); return { statusCode: 200 }; }
    async playAction(p) {
      const count = Math.max(1, scene.stepCount || 1);
      const want = p && typeof p.goto === "number" ? p.goto : 0;
      this._step = Math.max(0, Math.min(count - 1, want));
      await this._h.goto(this._step);
      return { statusCode: 200, currentStep: this._step };
    }
    async continueAction() {
      const count = Math.max(1, scene.stepCount || 1);
      this._step = Math.min(count - 1, (this._step || 0) + 1);
      await this._h.goto(this._step);
      return { statusCode: 200, currentStep: this._step };
    }
    async stopAction() { await this._h.stop(); return { statusCode: 200 }; }
    async updateAction(p) { this._data = { ...this._data, ...((p && p.data) || {}) }; this._h.update(this._data); return { statusCode: 200 }; }
    async customAction(p) {
      if (p && p.id && this._h) await this._h.action(p.id);
      return { statusCode: 200 };
    }
  };
}

export default createSceneElement({"format":"omp-ograf-scene/1","width":1920,"height":1080,"elements":[{"id":"r1","kind":"rect","name":"Hintergrund","x":154,"y":700,"w":1612,"h":290,"rotation":0,"opacity":0.9,"fill":"{{bgColor}}","radius":0,"stroke":"","strokeW":0,"anim":{"in":{"type":"fromBottom","ms":500,"delay":0,"ease":"ease-out"},"out":{"type":"fade","ms":300,"delay":0,"ease":"ease-in"}}},{"id":"r2","kind":"rect","name":"Akzent","x":154,"y":700,"w":14,"h":290,"rotation":0,"opacity":1,"fill":"{{accentColor}}","radius":0,"stroke":"","strokeW":0,"anim":{"in":{"type":"fromBottom","ms":500,"delay":0,"ease":"ease-out"},"out":{"type":"fade","ms":300,"delay":0,"ease":"ease-in"}}},{"id":"t3","kind":"text","name":"Zitat","x":205,"y":720,"w":1530,"h":170,"rotation":0,"opacity":1,"text":"{{text}}","font":"system-ui, sans-serif","size":56,"weight":600,"color":"{{textColor}}","align":"left","valign":"top","lineHeight":1.2,"padding":0,"autofit":true,"minSize":16,"anim":{"in":{"type":"fromBottom","ms":500,"delay":120,"ease":"ease-out"},"out":{"type":"fade","ms":300,"delay":0,"ease":"ease-in"}}},{"id":"t4","kind":"text","name":"Urheber","x":205,"y":905,"w":1530,"h":60,"rotation":0,"opacity":1,"text":"{{author}}","font":"system-ui, sans-serif","size":32,"weight":700,"color":"{{accentColor}}","align":"left","valign":"middle","lineHeight":1.2,"padding":0,"autofit":true,"minSize":16,"anim":{"in":{"type":"fromBottom","ms":500,"delay":220,"ease":"ease-out"},"out":{"type":"fade","ms":300,"delay":0,"ease":"ease-in"}}}]}, import.meta.url);
