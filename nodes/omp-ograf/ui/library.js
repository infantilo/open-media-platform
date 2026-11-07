// ui/modules/ograf-editor/runtime.js with { type: 'text' }
var runtime_default = '// Laufzeit der Designer-Vorlagen des OGraf-Editors (Kapitel 90.5). Diese EINE Datei wird\n//  (a) vom Editor f\xFCr die Leinwand-Vorschau benutzt und\n//  (b) als Text in jede mit der Leinwand gebaute Vorlage kopiert (`<id>.js` = diese Datei + `export default createSceneElement(...)`),\n// damit Vorschau und Sendung denselben Code ausf\xFChren. Reines JavaScript ohne Abh\xE4ngigkeiten, ES-Modul.\n// Das Szenenmodell steht in `scene.json` des Pakets (Format `omp-ograf-scene/1`, s. scene.ts).\n\n/** Ersetzt `{{schluessel}}` durch Werte aus `data` (fehlend = leer). */\nexport function bindText(text, data) {\n  return String(text ?? "").replace(/\\{\\{\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\}\\}/g, (_, k) => {\n    const v = data ? data[k] : undefined;\n    return v === undefined || v === null ? "" : String(v);\n  });\n}\n\n/** Alle Animationsarten: Anzeigename-Schl\xFCssel \u2192 Start-Keyframes (Zustand \u201Eweg\u201C) und Ziel \u201Eda\u201C. */\nexport const ANIM_TYPES = ["none", "fade", "fromLeft", "fromRight", "fromTop", "fromBottom", "scale", "wipe"];\n\n/** Keyframes f\xFCr Einblenden (`dir` = "in") bzw. Ausblenden ("out", r\xFCckw\xE4rts). `dist` = Weg in Bildpunkten. */\nexport function keyframesFor(type, dir, dist = 80) {\n  const slide = (t) => [{ opacity: 0, transform: t }, { opacity: 1, transform: "none" }];\n  let pair;\n  switch (type) {\n    case "fade": pair = [{ opacity: 0 }, { opacity: 1 }]; break;\n    case "fromLeft": pair = slide(`translateX(${-dist}px)`); break;\n    case "fromRight": pair = slide(`translateX(${dist}px)`); break;\n    case "fromTop": pair = slide(`translateY(${-dist}px)`); break;\n    case "fromBottom": pair = slide(`translateY(${dist}px)`); break;\n    case "scale": pair = slide("scale(0.8)"); break;\n    case "wipe": pair = [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }]; break;\n    default: return null;\n  }\n  return dir === "in" ? pair : [pair[1], pair[0]];\n}\n\n/** Schrift verkleinern, bis der Text ins Feld passt (nur bei `e.autofit`, nicht unter `e.minSize`). Braucht ein eingeh\xE4ngtes Element. */\nexport function autofit(inner, e) {\n  if (e.kind !== "text" || !e.autofit) return;\n  let size = e.size || 40;\n  const min = e.minSize || 12;\n  const s = inner.style;\n  const keep = s.alignItems;\n  s.alignItems = "flex-start"; // sonst z\xE4hlt der \xDCberstand nach oben nicht in scrollHeight\n  s.fontSize = `${size}px`;\n  for (let guard = 0; guard < 60 && size > min && (inner.scrollHeight > inner.clientHeight + 1 || inner.scrollWidth > inner.clientWidth + 1); guard++) {\n    size = Math.max(min, size - Math.max(1, Math.round(size * 0.04)));\n    s.fontSize = `${size}px`;\n  }\n  s.alignItems = keep;\n}\n\nconst FONTS = new Set();\n/** Schriftdateien der Szene als Schriftfamilien anmelden; Ergebnis: Versprechen, das nach dem Laden aller erf\xFCllt ist. */\nfunction loadFonts(scene, resolveAsset) {\n  if (typeof FontFace === "undefined" || !document.fonts || !resolveAsset) return Promise.resolve();\n  const jobs = [];\n  for (const f of scene.fonts || []) {\n    const url = resolveAsset(f.file);\n    if (!url) continue;\n    const key = `${f.family}|${url}`;\n    if (FONTS.has(key)) continue;\n    FONTS.add(key);\n    const face = new FontFace(f.family, `url("${url}")`);\n    document.fonts.add(face);\n    jobs.push(face.load().catch(() => {}));\n  }\n  return Promise.all(jobs).then(() => {});\n}\n\n/** Ist das Element im Schritt `step` sichtbar? (`from` Standard 0, `to` \u22121 = bis zum letzten Schritt.) */\nexport function inStep(e, step) {\n  const from = e.from ?? 0;\n  const to = e.to ?? -1;\n  return step >= from && (to < 0 || step <= to);\n}\n\n/** Hervorhebe-Effekte f\xFCr Aktionen (kehren zum Ausgangszustand zur\xFCck). */\nexport const EFFECT_TYPES = ["pulse", "flash", "shake", "bounce"];\nexport function effectKeyframes(type) {\n  switch (type) {\n    case "pulse": return [{ transform: "scale(1)" }, { transform: "scale(1.12)" }, { transform: "scale(1)" }];\n    case "flash": return [{ opacity: 1 }, { opacity: 0.15 }, { opacity: 1 }];\n    case "shake": return [{ transform: "translateX(0)" }, { transform: "translateX(-14px)" }, { transform: "translateX(14px)" }, { transform: "translateX(-10px)" }, { transform: "translateX(10px)" }, { transform: "translateX(0)" }];\n    case "bounce": return [{ transform: "translateY(0)" }, { transform: "translateY(-28px)" }, { transform: "translateY(0)" }];\n    default: return null;\n  }\n}\n\nfunction applyBox(el, e) {\n  const s = el.style;\n  s.position = "absolute";\n  s.left = `${e.x}px`;\n  s.top = `${e.y}px`;\n  s.width = `${e.w}px`;\n  s.height = `${e.h}px`;\n  s.transform = e.rotation ? `rotate(${e.rotation}deg)` : "none";\n  s.boxSizing = "border-box";\n}\n\nfunction paint(inner, e, data) {\n  const s = inner.style;\n  const color = (c) => bindText(c, data);\n  if (e.kind === "rect") {\n    s.background = color(e.fill || "transparent");\n    s.borderRadius = `${e.radius || 0}px`;\n    s.border = e.strokeW ? `${e.strokeW}px solid ${color(e.stroke || "#fff")}` : "none";\n  } else if (e.kind === "text") {\n    inner.textContent = bindText(e.text, data);\n    s.font = `${e.weight || 400} ${e.size || 40}px/${e.lineHeight || 1.2} ${e.font || "system-ui, sans-serif"}`;\n    s.color = color(e.color || "#fff");\n    s.textAlign = e.align || "left";\n    s.whiteSpace = "pre-wrap";\n    s.overflow = "hidden";\n    s.display = "flex";\n    s.alignItems = { top: "flex-start", middle: "center", bottom: "flex-end" }[e.valign || "top"];\n    s.justifyContent = { left: "flex-start", center: "center", right: "flex-end" }[e.align || "left"];\n    s.background = e.bg ? color(e.bg) : "transparent";\n    s.padding = `${e.padding || 0}px`;\n    s.borderRadius = `${e.radius || 0}px`;\n  } else if (e.kind === "image") {\n    s.objectFit = e.fit || "contain";\n    s.borderRadius = `${e.radius || 0}px`;\n  }\n}\n\n/**\n * Baut die Szene in `root` (ShadowRoot oder Element) und liefert den Griff `{play, stop, update, destroy, stage}`.\n * `opts.resolveAsset(datei) \u2192 URL`, `opts.scale() \u2192 Faktor` (Standard: Breite des Fensters / Szenenbreite),\n * `opts.editor = true` zeigt Zonen als gestrichelte Rahmen und spielt keine Animation (alles sichtbar).\n */\nexport function renderScene(root, scene, data, opts = {}) {\n  const stage = document.createElement("div");\n  stage.style.cssText = `position:absolute;left:0;top:0;width:${scene.width}px;height:${scene.height}px;transform-origin:0 0;overflow:hidden`;\n  const scaleOf = opts.scale || (() => (window.innerWidth || scene.width) / scene.width);\n  const fit = () => { stage.style.transform = `scale(${scaleOf()})`; };\n  fit();\n  const onResize = () => fit();\n  window.addEventListener("resize", onResize);\n  const items = [];\n  for (const e of scene.elements || []) {\n    const wrap = document.createElement("div");\n    applyBox(wrap, e);\n    wrap.style.opacity = String(e.opacity ?? 1);\n    if (opts.editor && opts.step !== undefined && !inStep(e, opts.step)) wrap.style.opacity = String((e.opacity ?? 1) * 0.2);\n    wrap.dataset.elementId = e.id;\n    let inner;\n    if (e.kind === "image") {\n      inner = document.createElement("img");\n      inner.alt = "";\n      if (e.file && opts.resolveAsset) inner.src = opts.resolveAsset(e.file);\n    } else {\n      inner = document.createElement("div");\n    }\n    inner.style.cssText += ";width:100%;height:100%;box-sizing:border-box";\n    if (e.kind === "zone") {\n      wrap.setAttribute("data-ograf-zone", e.zone || "zone");\n      if (opts.editor) inner.style.outline = "2px dashed #00c8ff";\n    }\n    paint(inner, e, data);\n    wrap.append(inner);\n    stage.append(wrap);\n    items.push({ e, wrap, inner, anims: [], shown: false });\n  }\n  root.append(stage);\n  const fitAll = () => { for (const it of items) autofit(it.inner, it.e); };\n  fitAll();\n  const ready = loadFonts(scene, opts.resolveAsset).then(fitAll);\n  const clear = (it) => { for (const a of it.anims) a.cancel(); it.anims = []; };\n  const run = (it, dir) => {\n    const spec = it.e.anim && it.e.anim[dir];\n    const kf = spec ? keyframesFor(spec.type, dir) : null;\n    clear(it);\n    // Zonen melden ihr Rechteck \xFCber das umgebende Element; au\xDFerhalb ihrer Schritte gelten sie als unsichtbar\n    if (it.e.kind === "zone") it.wrap.style.visibility = dir === "in" ? "visible" : "hidden";\n    if (!kf) { it.inner.style.visibility = dir === "in" ? "visible" : "hidden"; return Promise.resolve(); }\n    it.inner.style.visibility = "visible";\n    const a = it.inner.animate(kf, { duration: spec.ms ?? 400, delay: spec.delay ?? 0, easing: spec.ease || "ease-out", fill: "both" });\n    it.anims.push(a);\n    return a.finished.catch(() => {});\n  };\n  if (!opts.editor) {\n    for (const it of items) {\n      it.inner.style.visibility = "hidden";\n      if (it.e.kind === "zone") it.wrap.style.visibility = "hidden";\n    }\n  }\n  const goto = (step) => Promise.all(items.map((it) => {\n    const vis = inStep(it.e, step);\n    if (vis && !it.shown) { it.shown = true; return run(it, "in"); }\n    if (!vis && it.shown) { it.shown = false; return run(it, "out"); }\n    return Promise.resolve();\n  }));\n  /** Aktion der Szene abspielen (Effekte auf Elementen); unbekannte Aktion/Elemente werden \xFCbersprungen. */\n  const action = (id) => {\n    const a = (scene.actions || []).find((x) => x.id === id);\n    if (!a) return Promise.resolve();\n    const jobs = [];\n    for (const fx of a.effects || []) {\n      const it = items.find((i) => i.e.id === fx.target);\n      const kf = effectKeyframes(fx.type);\n      if (!it || !kf) continue;\n      const anim = it.inner.animate(kf, { duration: Math.max(50, fx.ms || 600), delay: fx.delay || 0, easing: "ease-in-out" });\n      jobs.push(anim.finished.catch(() => {}));\n    }\n    return Promise.all(jobs);\n  };\n  /** Zeitleisten-Wiedergabekopf (nur Editor): alle Animationen einer Richtung angehalten bei `t` ms zeigen. */\n  const scrub = (dir, t) => {\n    for (const it of items) {\n      clear(it);\n      const spec = it.e.anim && it.e.anim[dir];\n      const kf = spec ? keyframesFor(spec.type, dir) : null;\n      it.inner.style.visibility = "visible";\n      if (!kf) continue;\n      const a = it.inner.animate(kf, { duration: spec.ms ?? 400, delay: spec.delay ?? 0, easing: spec.ease || "ease-out", fill: "both" });\n      a.pause();\n      a.currentTime = t;\n      it.anims.push(a);\n    }\n  };\n  const unscrub = () => { for (const it of items) { clear(it); it.inner.style.visibility = "visible"; } };\n  return {\n    stage,\n    ready,\n    action,\n    scrub,\n    unscrub,\n    goto,\n    play: (step = 0) => goto(step),\n    stop: () => Promise.all(items.filter((it) => it.shown).map((it) => { it.shown = false; return run(it, "out"); })),\n    update(next) { for (const it of items) { paint(it.inner, it.e, next); autofit(it.inner, it.e); } },\n    destroy() { window.removeEventListener("resize", onResize); for (const it of items) clear(it); stage.remove(); },\n  };\n}\n\n/** Die Web-Component-Klasse, die OGraf als `default export` erwartet. `base` = `import.meta.url` des Hauptmoduls. */\nexport function createSceneElement(scene, base) {\n  return class SceneGraphic extends HTMLElement {\n    constructor() {\n      super();\n      const sr = this.attachShadow({ mode: "open" });\n      const st = document.createElement("style");\n      st.textContent = ":host{position:fixed;inset:0;display:block;pointer-events:none}";\n      sr.append(st);\n    }\n    async load(p) {\n      this._data = (p && p.data) || {};\n      this._h = renderScene(this.shadowRoot, scene, this._data, { resolveAsset: (f) => new URL(f, base).href });\n      await this._h.ready;\n      return { statusCode: 200 };\n    }\n    async dispose() { if (this._h) this._h.destroy(); return { statusCode: 200 }; }\n    async playAction(p) {\n      const count = Math.max(1, scene.stepCount || 1);\n      const want = p && typeof p.goto === "number" ? p.goto : 0;\n      this._step = Math.max(0, Math.min(count - 1, want));\n      await this._h.goto(this._step);\n      return { statusCode: 200, currentStep: this._step };\n    }\n    async continueAction() {\n      const count = Math.max(1, scene.stepCount || 1);\n      this._step = Math.min(count - 1, (this._step || 0) + 1);\n      await this._h.goto(this._step);\n      return { statusCode: 200, currentStep: this._step };\n    }\n    async stopAction() { await this._h.stop(); return { statusCode: 200 }; }\n    async updateAction(p) { this._data = { ...this._data, ...((p && p.data) || {}) }; this._h.update(this._data); return { statusCode: 200 }; }\n    async customAction(p) {\n      if (p && p.id && this._h) await this._h.action(p.id);\n      return { statusCode: 200 };\n    }\n  };\n}\n';

// ui/modules/ograf-editor/runtime.js
function bindText(text, data) {
  return String(text ?? "").replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, k) => {
    const v = data ? data[k] : void 0;
    return v === void 0 || v === null ? "" : String(v);
  });
}
function keyframesFor(type, dir, dist = 80) {
  const slide = (t) => [
    {
      opacity: 0,
      transform: t
    },
    {
      opacity: 1,
      transform: "none"
    }
  ];
  let pair;
  switch (type) {
    case "fade":
      pair = [
        {
          opacity: 0
        },
        {
          opacity: 1
        }
      ];
      break;
    case "fromLeft":
      pair = slide(`translateX(${-dist}px)`);
      break;
    case "fromRight":
      pair = slide(`translateX(${dist}px)`);
      break;
    case "fromTop":
      pair = slide(`translateY(${-dist}px)`);
      break;
    case "fromBottom":
      pair = slide(`translateY(${dist}px)`);
      break;
    case "scale":
      pair = slide("scale(0.8)");
      break;
    case "wipe":
      pair = [
        {
          clipPath: "inset(0 100% 0 0)"
        },
        {
          clipPath: "inset(0 0 0 0)"
        }
      ];
      break;
    default:
      return null;
  }
  return dir === "in" ? pair : [
    pair[1],
    pair[0]
  ];
}
function autofit(inner, e) {
  if (e.kind !== "text" || !e.autofit) return;
  let size = e.size || 40;
  const min = e.minSize || 12;
  const s = inner.style;
  const keep = s.alignItems;
  s.alignItems = "flex-start";
  s.fontSize = `${size}px`;
  for (let guard = 0; guard < 60 && size > min && (inner.scrollHeight > inner.clientHeight + 1 || inner.scrollWidth > inner.clientWidth + 1); guard++) {
    size = Math.max(min, size - Math.max(1, Math.round(size * 0.04)));
    s.fontSize = `${size}px`;
  }
  s.alignItems = keep;
}
var FONTS = /* @__PURE__ */ new Set();
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
    jobs.push(face.load().catch(() => {
    }));
  }
  return Promise.all(jobs).then(() => {
  });
}
function inStep(e, step) {
  const from = e.from ?? 0;
  const to = e.to ?? -1;
  return step >= from && (to < 0 || step <= to);
}
function effectKeyframes(type) {
  switch (type) {
    case "pulse":
      return [
        {
          transform: "scale(1)"
        },
        {
          transform: "scale(1.12)"
        },
        {
          transform: "scale(1)"
        }
      ];
    case "flash":
      return [
        {
          opacity: 1
        },
        {
          opacity: 0.15
        },
        {
          opacity: 1
        }
      ];
    case "shake":
      return [
        {
          transform: "translateX(0)"
        },
        {
          transform: "translateX(-14px)"
        },
        {
          transform: "translateX(14px)"
        },
        {
          transform: "translateX(-10px)"
        },
        {
          transform: "translateX(10px)"
        },
        {
          transform: "translateX(0)"
        }
      ];
    case "bounce":
      return [
        {
          transform: "translateY(0)"
        },
        {
          transform: "translateY(-28px)"
        },
        {
          transform: "translateY(0)"
        }
      ];
    default:
      return null;
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
    s.alignItems = {
      top: "flex-start",
      middle: "center",
      bottom: "flex-end"
    }[e.valign || "top"];
    s.justifyContent = {
      left: "flex-start",
      center: "center",
      right: "flex-end"
    }[e.align || "left"];
    s.background = e.bg ? color(e.bg) : "transparent";
    s.padding = `${e.padding || 0}px`;
    s.borderRadius = `${e.radius || 0}px`;
  } else if (e.kind === "image") {
    s.objectFit = e.fit || "contain";
    s.borderRadius = `${e.radius || 0}px`;
  }
}
function renderScene(root, scene, data, opts = {}) {
  const stage = document.createElement("div");
  stage.style.cssText = `position:absolute;left:0;top:0;width:${scene.width}px;height:${scene.height}px;transform-origin:0 0;overflow:hidden`;
  const scaleOf = opts.scale || (() => (window.innerWidth || scene.width) / scene.width);
  const fit = () => {
    stage.style.transform = `scale(${scaleOf()})`;
  };
  fit();
  const onResize = () => fit();
  window.addEventListener("resize", onResize);
  const items = [];
  for (const e of scene.elements || []) {
    const wrap = document.createElement("div");
    applyBox(wrap, e);
    wrap.style.opacity = String(e.opacity ?? 1);
    if (opts.editor && opts.step !== void 0 && !inStep(e, opts.step)) wrap.style.opacity = String((e.opacity ?? 1) * 0.2);
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
    items.push({
      e,
      wrap,
      inner,
      anims: [],
      shown: false
    });
  }
  root.append(stage);
  const fitAll = () => {
    for (const it of items) autofit(it.inner, it.e);
  };
  fitAll();
  const ready = loadFonts(scene, opts.resolveAsset).then(fitAll);
  const clear = (it) => {
    for (const a of it.anims) a.cancel();
    it.anims = [];
  };
  const run = (it, dir) => {
    const spec = it.e.anim && it.e.anim[dir];
    const kf = spec ? keyframesFor(spec.type, dir) : null;
    clear(it);
    if (it.e.kind === "zone") it.wrap.style.visibility = dir === "in" ? "visible" : "hidden";
    if (!kf) {
      it.inner.style.visibility = dir === "in" ? "visible" : "hidden";
      return Promise.resolve();
    }
    it.inner.style.visibility = "visible";
    const a = it.inner.animate(kf, {
      duration: spec.ms ?? 400,
      delay: spec.delay ?? 0,
      easing: spec.ease || "ease-out",
      fill: "both"
    });
    it.anims.push(a);
    return a.finished.catch(() => {
    });
  };
  if (!opts.editor) {
    for (const it of items) {
      it.inner.style.visibility = "hidden";
      if (it.e.kind === "zone") it.wrap.style.visibility = "hidden";
    }
  }
  const goto = (step) => Promise.all(items.map((it) => {
    const vis = inStep(it.e, step);
    if (vis && !it.shown) {
      it.shown = true;
      return run(it, "in");
    }
    if (!vis && it.shown) {
      it.shown = false;
      return run(it, "out");
    }
    return Promise.resolve();
  }));
  const action = (id) => {
    const a = (scene.actions || []).find((x) => x.id === id);
    if (!a) return Promise.resolve();
    const jobs = [];
    for (const fx of a.effects || []) {
      const it = items.find((i) => i.e.id === fx.target);
      const kf = effectKeyframes(fx.type);
      if (!it || !kf) continue;
      const anim = it.inner.animate(kf, {
        duration: Math.max(50, fx.ms || 600),
        delay: fx.delay || 0,
        easing: "ease-in-out"
      });
      jobs.push(anim.finished.catch(() => {
      }));
    }
    return Promise.all(jobs);
  };
  const scrub = (dir, t) => {
    for (const it of items) {
      clear(it);
      const spec = it.e.anim && it.e.anim[dir];
      const kf = spec ? keyframesFor(spec.type, dir) : null;
      it.inner.style.visibility = "visible";
      if (!kf) continue;
      const a = it.inner.animate(kf, {
        duration: spec.ms ?? 400,
        delay: spec.delay ?? 0,
        easing: spec.ease || "ease-out",
        fill: "both"
      });
      a.pause();
      a.currentTime = t;
      it.anims.push(a);
    }
  };
  const unscrub = () => {
    for (const it of items) {
      clear(it);
      it.inner.style.visibility = "visible";
    }
  };
  return {
    stage,
    ready,
    action,
    scrub,
    unscrub,
    goto,
    play: (step = 0) => goto(step),
    stop: () => Promise.all(items.filter((it) => it.shown).map((it) => {
      it.shown = false;
      return run(it, "out");
    })),
    update(next) {
      for (const it of items) {
        paint(it.inner, it.e, next);
        autofit(it.inner, it.e);
      }
    },
    destroy() {
      window.removeEventListener("resize", onResize);
      for (const it of items) clear(it);
      stage.remove();
    }
  };
}

// ui/modules/ograf-editor/logic.ts
var SCHEMA_URL = "https://ograf.ebu.io/v1/specification/json-schemas/graphics/schema.json";
var PACKAGE_FORMAT = "omp-ograf-package/1";
function slugify(name) {
  const map = {
    "\xE4": "ae",
    "\xF6": "oe",
    "\xFC": "ue",
    "\xDF": "ss"
  };
  const s = name.toLowerCase().replace(/[äöüß]/g, (c) => map[c]).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/g, "");
  return s;
}
function nextFreeId(base, taken) {
  const set = new Set(taken);
  const b = slugify(base) || "vorlage";
  if (!set.has(b)) return b;
  for (let i = 2; i < 1e3; i++) {
    const c = `${b.slice(0, 58)}-${i}`;
    if (!set.has(c)) return c;
  }
  return `${b.slice(0, 50)}-${Date.now() % 1e5}`;
}
function manifestFileName(files) {
  return Object.keys(files).find((n) => n.endsWith(".ograf.json")) ?? null;
}
function parseManifest(files) {
  const n = manifestFileName(files);
  if (!n) return null;
  try {
    const v = JSON.parse(files[n]);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
var str = (v) => typeof v === "string" ? v : "";
var num = (v, d = 0) => typeof v === "number" && Number.isFinite(v) ? v : d;
function ideal(c) {
  return c && typeof c === "object" ? num(c.ideal) : 0;
}
function formFromManifest(m) {
  const author = m.author && typeof m.author === "object" ? m.author : {};
  const req = Array.isArray(m.renderRequirements) && m.renderRequirements[0] && typeof m.renderRequirements[0] === "object" ? m.renderRequirements[0] : {};
  const res = req.resolution && typeof req.resolution === "object" ? req.resolution : {};
  return {
    name: str(m.name),
    version: str(m.version),
    description: str(m.description),
    authorName: str(author.name),
    authorEmail: str(author.email),
    authorUrl: str(author.url),
    stepCount: num(m.stepCount, 1),
    supportsRealTime: m.supportsRealTime === true,
    supportsNonRealTime: m.supportsNonRealTime === true,
    width: ideal(res.width),
    height: ideal(res.height),
    frameRate: ideal(req.frameRate),
    thumbnail: Array.isArray(m.thumbnails) && m.thumbnails[0] && typeof m.thumbnails[0] === "object" ? str(m.thumbnails[0].file) : ""
  };
}
function applyForm(prev, f, id) {
  const m = {
    ...prev,
    $schema: SCHEMA_URL,
    id,
    name: f.name,
    supportsRealTime: f.supportsRealTime,
    supportsNonRealTime: f.supportsNonRealTime
  };
  const opt = (k, v, empty) => {
    if (empty) delete m[k];
    else m[k] = v;
  };
  opt("version", f.version, f.version === "");
  opt("description", f.description, f.description === "");
  m.stepCount = Math.max(-1, Math.round(f.stepCount));
  const oldAuthor = prev.author && typeof prev.author === "object" ? prev.author : {};
  if (f.authorName) {
    const a = {
      ...oldAuthor,
      name: f.authorName
    };
    if (f.authorEmail) a.email = f.authorEmail;
    else delete a.email;
    if (f.authorUrl) a.url = f.authorUrl;
    else delete a.url;
    m.author = a;
  } else delete m.author;
  const reqs = Array.isArray(prev.renderRequirements) ? [
    ...prev.renderRequirements
  ] : [];
  const first = {
    ...reqs[0] ?? {}
  };
  if (f.width > 0 && f.height > 0) first.resolution = {
    width: {
      ideal: f.width
    },
    height: {
      ideal: f.height
    }
  };
  else delete first.resolution;
  if (f.frameRate > 0) first.frameRate = {
    ideal: f.frameRate
  };
  else delete first.frameRate;
  if (Object.keys(first).length) reqs[0] = first;
  else reqs.shift();
  opt("renderRequirements", reqs, reqs.length === 0);
  const thumbs = Array.isArray(prev.thumbnails) ? [
    ...prev.thumbnails
  ] : [];
  if (f.thumbnail) thumbs[0] = {
    ...thumbs[0] ?? {},
    file: f.thumbnail
  };
  else thumbs.shift();
  opt("thumbnails", thumbs, thumbs.length === 0);
  return m;
}
function stringify(m) {
  return JSON.stringify(m, null, 2) + "\n";
}
var FIELD_KINDS = [
  "text",
  "multiline",
  "number",
  "bool",
  "color",
  "choice"
];
var COLOR_PATTERN = "^#[0-9a-f]{6}$";
var OWN_PROPS = /* @__PURE__ */ new Set([
  "type",
  "title",
  "default",
  "enum",
  "pattern"
]);
var KIND_GDD = /* @__PURE__ */ new Set([
  "color-rrggbb",
  "multi-line"
]);
function kindOf(p) {
  if (p.type === "array" || p.type === "object" || p.gddType === "select" || p.gddType === "select-multiple" || p.gddType === "color-rrggbbaa") return "raw";
  if (Array.isArray(p.enum) && p.enum.length) return "choice";
  if (p.type === "boolean") return "bool";
  if (p.type === "number" || p.type === "integer") return "number";
  if (p.gddType === "color-rrggbb" || p.gddType === "color-rrggbbaa") return "color";
  if (p.gddType === "multi-line") return "multiline";
  return "text";
}
function fieldsFromSchema(schema) {
  const s = schema && typeof schema === "object" ? schema : {};
  const props = s.properties && typeof s.properties === "object" ? s.properties : {};
  const required = Array.isArray(s.required) ? s.required.filter((x) => typeof x === "string") : [];
  return Object.entries(props).map(([key, p]) => {
    const prop = p && typeof p === "object" ? p : {};
    const kind = kindOf(prop);
    const extra = {};
    for (const [k, v] of Object.entries(prop)) {
      if (kind === "raw") extra[k] = v;
      else if (!OWN_PROPS.has(k) && !(k === "gddType" && KIND_GDD.has(String(v)))) extra[k] = v;
    }
    return {
      key,
      title: str(prop.title),
      kind,
      def: kind === "raw" || prop.default === void 0 ? "" : String(prop.default),
      choices: Array.isArray(prop.enum) ? prop.enum.map(String) : [],
      required: required.includes(key),
      extra
    };
  });
}
function schemaFromFields(fields, prev) {
  const base = prev && typeof prev === "object" && !Array.isArray(prev) ? {
    ...prev
  } : {};
  const properties = {};
  for (const f of fields) {
    if (f.kind === "raw") {
      properties[f.key] = {
        ...f.extra,
        ...f.title ? {
          title: f.title
        } : {}
      };
      continue;
    }
    const p = {
      ...f.extra
    };
    if (f.title) p.title = f.title;
    switch (f.kind) {
      case "number":
        p.type = "number";
        if (f.def.trim() !== "" && Number.isFinite(Number(f.def))) p.default = Number(f.def);
        break;
      case "bool":
        p.type = "boolean";
        if (f.def !== "") p.default = f.def === "true";
        break;
      case "color":
        p.type = "string";
        p.gddType = "color-rrggbb";
        p.pattern = COLOR_PATTERN;
        if (f.def) p.default = f.def.toLowerCase();
        break;
      case "choice":
        p.type = "string";
        p.enum = f.choices;
        if (f.def) p.default = f.def;
        break;
      case "multiline":
        p.type = "string";
        p.gddType = "multi-line";
        if (f.def !== "") p.default = f.def;
        break;
      default:
        p.type = "string";
        if (f.def !== "") p.default = f.def;
    }
    properties[f.key] = p;
  }
  base.type = "object";
  base.properties = properties;
  const required = fields.filter((f) => f.required).map((f) => f.key);
  if (required.length) base.required = required;
  else delete base.required;
  return base;
}
function validateFields(fields) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const f of fields) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.key)) out.push(`Schl\xFCssel \u201E${f.key}\u201C ung\xFCltig (Buchstaben, Ziffern, _; nicht mit Ziffer beginnen)`);
    if (seen.has(f.key)) out.push(`Schl\xFCssel \u201E${f.key}\u201C doppelt`);
    seen.add(f.key);
    if (f.kind === "choice" && f.choices.length === 0) out.push(`\u201E${f.key}\u201C: Auswahl ohne Eintr\xE4ge`);
    if (f.kind === "choice" && f.def && !f.choices.includes(f.def)) out.push(`\u201E${f.key}\u201C: Vorgabe nicht in der Auswahl`);
    if (f.kind === "number" && f.def.trim() !== "" && !Number.isFinite(Number(f.def))) out.push(`\u201E${f.key}\u201C: Vorgabe keine Zahl`);
    if (f.kind === "color" && f.def && !/^#[0-9a-fA-F]{6}$/.test(f.def)) out.push(`\u201E${f.key}\u201C: Farbe als #rrggbb`);
    if (f.kind === "raw") continue;
  }
  return out;
}
function defaultsOf(fields) {
  const o = {};
  for (const f of fields) {
    if (f.def === "" || f.kind === "raw") continue;
    o[f.key] = f.kind === "number" ? Number(f.def) : f.kind === "bool" ? f.def === "true" : f.def;
  }
  return o;
}
function importPackage(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return {
      error: "Datei ist kein g\xFCltiges JSON"
    };
  }
  const o = v;
  if (!o || o.format !== PACKAGE_FORMAT) return {
    error: `Unbekanntes Format (erwartet ${PACKAGE_FORMAT})`
  };
  const files = o.files;
  if (!files || typeof files !== "object") return {
    error: "files fehlt"
  };
  const out = {};
  for (const [k, c] of Object.entries(files)) {
    if (typeof c !== "string") return {
      error: `Datei \u201E${k}\u201C ist kein Text`
    };
    out[k] = c;
  }
  const id = typeof o.id === "string" ? o.id : "";
  if (!id) return {
    error: "id fehlt"
  };
  return {
    id,
    files: out
  };
}
function renamePackage(files, from, to) {
  const out = {};
  const m = parseManifest(files) ?? {};
  const oldMain = str(m.main);
  const newMain = oldMain === `${from}.js` ? `${to}.js` : oldMain;
  for (const [n, c] of Object.entries(files)) {
    if (n.endsWith(".ograf.json")) continue;
    out[n === oldMain && newMain !== oldMain ? newMain : n] = c;
  }
  out[`${to}.ograf.json`] = stringify({
    ...m,
    id: to,
    main: newMain
  });
  return out;
}

// ui/modules/ograf-editor/scene.ts
var SCENE_FORMAT = "omp-ograf-scene/1";
var KINDS = [
  "text",
  "rect",
  "image",
  "zone"
];
var ANIM_TYPES = [
  "none",
  "fade",
  "fromLeft",
  "fromRight",
  "fromTop",
  "fromBottom",
  "scale",
  "wipe"
];
var EFFECT_TYPES = [
  "pulse",
  "flash",
  "shake",
  "bounce"
];
var MIN_SIZE = 4;
var num2 = (v, d) => typeof v === "number" && Number.isFinite(v) ? v : d;
var str2 = (v, d = "") => typeof v === "string" ? v : d;
function newScene(width = 1920, height = 1080) {
  return {
    format: SCENE_FORMAT,
    width,
    height,
    elements: []
  };
}
function uniqueId(scene, base) {
  const ids = new Set(scene.elements.map((e) => e.id));
  for (let i = 1; i < 1e4; i++) if (!ids.has(`${base}${i}`)) return `${base}${i}`;
  return `${base}${Date.now()}`;
}
var LABEL = {
  text: "Text",
  rect: "Fl\xE4che",
  image: "Bild",
  zone: "Zone"
};
function newElement(kind, scene) {
  const id = uniqueId(scene, kind === "zone" ? "z" : kind[0]);
  const same = scene.elements.filter((e) => e.kind === kind).length + 1;
  const base = {
    id,
    kind,
    name: `${LABEL[kind]} ${same}`,
    rotation: 0,
    opacity: 1
  };
  const w = kind === "text" ? 720 : kind === "zone" ? 640 : 480;
  const h = kind === "text" ? 100 : kind === "zone" ? 360 : 270;
  const box = {
    x: Math.round((scene.width - w) / 2),
    y: Math.round((scene.height - h) / 2),
    w,
    h
  };
  switch (kind) {
    case "text":
      return {
        ...base,
        ...box,
        text: "Text",
        font: "system-ui, sans-serif",
        size: 64,
        weight: 600,
        color: "#ffffff",
        align: "left",
        valign: "middle",
        lineHeight: 1.2,
        padding: 0,
        anim: {
          in: {
            type: "fade",
            ms: 300,
            delay: 0,
            ease: "ease-out"
          },
          out: {
            type: "fade",
            ms: 300,
            delay: 0,
            ease: "ease-in"
          }
        }
      };
    case "rect":
      return {
        ...base,
        ...box,
        fill: "#10151f",
        radius: 0,
        stroke: "",
        strokeW: 0,
        anim: {
          in: {
            type: "fade",
            ms: 300,
            delay: 0,
            ease: "ease-out"
          },
          out: {
            type: "fade",
            ms: 300,
            delay: 0,
            ease: "ease-in"
          }
        }
      };
    case "image":
      return {
        ...base,
        ...box,
        file: "",
        fit: "contain",
        anim: {
          in: {
            type: "fade",
            ms: 300,
            delay: 0,
            ease: "ease-out"
          },
          out: {
            type: "fade",
            ms: 300,
            delay: 0,
            ease: "ease-in"
          }
        }
      };
    default:
      return {
        ...base,
        ...box,
        zone: uniqueZone(scene)
      };
  }
}
function uniqueZone(scene) {
  const used = new Set(scene.elements.filter((e) => e.kind === "zone").map((e) => e.zone));
  if (!used.has("window")) return "window";
  for (let i = 2; i < 100; i++) if (!used.has(`window${i}`)) return `window${i}`;
  return "zone";
}
function parseAnim(v) {
  if (!v || typeof v !== "object") return void 0;
  const o = v;
  const type = str2(o.type, "none");
  return {
    type: ANIM_TYPES.includes(type) ? type : "none",
    ms: Math.max(0, num2(o.ms, 400)),
    delay: Math.max(0, num2(o.delay, 0)),
    ease: str2(o.ease, "ease-out")
  };
}
function parseScene(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const o = v;
  if (!o || o.format !== SCENE_FORMAT || !Array.isArray(o.elements)) return null;
  const scene = newScene(Math.max(16, num2(o.width, 1920)), Math.max(16, num2(o.height, 1080)));
  if (Array.isArray(o.actions)) {
    const ids = /* @__PURE__ */ new Set();
    scene.actions = [];
    for (const a of o.actions) {
      if (!a || typeof a.id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(a.id) || ids.has(a.id)) continue;
      ids.add(a.id);
      const effects = (Array.isArray(a.effects) ? a.effects : []).filter((f) => f && typeof f.target === "string" && EFFECT_TYPES.includes(f.type)).map((f) => ({
        target: f.target,
        type: f.type,
        ms: Math.max(50, num2(f.ms, 600)),
        delay: Math.max(0, num2(f.delay, 0))
      }));
      scene.actions.push({
        id: a.id,
        name: str2(a.name, a.id),
        effects
      });
    }
  }
  scene.stepCount = Math.min(20, Math.max(1, Math.round(num2(o.stepCount, 1))));
  if (Array.isArray(o.fonts)) {
    scene.fonts = o.fonts.filter((f) => f && typeof f.family === "string" && /^[^"'\\;{}]+$/.test(f.family) && typeof f.file === "string" && /^[A-Za-z0-9._-]+$/.test(f.file)).map((f) => ({
      family: f.family,
      file: f.file
    }));
  }
  const seen = /* @__PURE__ */ new Set();
  for (const raw of o.elements) {
    const e = raw;
    if (!e || typeof e !== "object" || !KINDS.includes(e.kind)) continue;
    let id = str2(e.id) || "e";
    while (seen.has(id)) id += "x";
    seen.add(id);
    const anim = e.anim && typeof e.anim === "object" ? e.anim : {};
    scene.elements.push({
      ...e,
      id,
      kind: e.kind,
      name: str2(e.name, id),
      x: num2(e.x, 0),
      y: num2(e.y, 0),
      w: Math.max(MIN_SIZE, num2(e.w, 100)),
      h: Math.max(MIN_SIZE, num2(e.h, 100)),
      rotation: num2(e.rotation, 0),
      opacity: Math.min(1, Math.max(0, num2(e.opacity, 1))),
      from: Math.max(0, Math.round(num2(e.from, 0))),
      to: Math.max(-1, Math.round(num2(e.to, -1))),
      anim: {
        in: parseAnim(anim.in),
        out: parseAnim(anim.out)
      }
    });
  }
  return scene;
}
var withElements = (s, elements) => ({
  ...s,
  elements
});
function updateElement(s, id, patch) {
  return withElements(s, s.elements.map((e) => e.id === id ? clampElement({
    ...e,
    ...patch
  }) : e));
}
function clampElement(e) {
  return {
    ...e,
    w: Math.max(MIN_SIZE, e.w),
    h: Math.max(MIN_SIZE, e.h),
    opacity: Math.min(1, Math.max(0, e.opacity))
  };
}
function addElement(s, e) {
  return withElements(s, [
    ...s.elements,
    e
  ]);
}
function removeElements(s, ids) {
  return withElements(s, s.elements.filter((e) => !ids.includes(e.id)));
}
function duplicateElement(s, id) {
  const src = s.elements.find((e) => e.id === id);
  if (!src) return {
    scene: s,
    id: ""
  };
  const nid = uniqueId(s, src.kind === "zone" ? "z" : src.kind[0]);
  const copy = {
    ...structuredClone(src),
    id: nid,
    name: `${src.name} (Kopie)`,
    x: src.x + 40,
    y: src.y + 40
  };
  if (copy.kind === "zone") copy.zone = uniqueZone(s);
  const i = s.elements.findIndex((e) => e.id === id);
  const els = [
    ...s.elements
  ];
  els.splice(i + 1, 0, copy);
  return {
    scene: withElements(s, els),
    id: nid
  };
}
function moveElements(s, ids, dx, dy) {
  return withElements(s, s.elements.map((e) => ids.includes(e.id) ? {
    ...e,
    x: Math.round(e.x + dx),
    y: Math.round(e.y + dy)
  } : e));
}
function reorder(s, id, how) {
  const i = s.elements.findIndex((e2) => e2.id === id);
  if (i < 0) return s;
  const els = [
    ...s.elements
  ];
  const [e] = els.splice(i, 1);
  const j = how === "front" ? els.length : how === "back" ? 0 : how === "up" ? Math.min(els.length, i + 1) : Math.max(0, i - 1);
  els.splice(j, 0, e);
  return withElements(s, els);
}
function setTiming(s, id, dir, patch) {
  const e = s.elements.find((x) => x.id === id);
  if (!e) return s;
  const cur = e.anim?.[dir] ?? {
    type: "fade",
    ms: 300,
    delay: 0,
    ease: "ease-out"
  };
  const snap = (v) => Math.max(0, Math.round(v / 50) * 50);
  const next = {
    ...cur,
    type: cur.type === "none" ? "fade" : cur.type,
    ms: patch.ms !== void 0 ? Math.max(50, snap(patch.ms)) : cur.ms,
    delay: patch.delay !== void 0 ? snap(patch.delay) : cur.delay
  };
  return updateElement(s, id, {
    anim: {
      ...e.anim,
      [dir]: next
    }
  });
}
function timelineEnd(s, dir, min = 1e3) {
  let end = min;
  for (const e of s.elements) {
    const a = e.anim?.[dir];
    if (a && a.type !== "none") end = Math.max(end, a.delay + a.ms);
  }
  return Math.ceil(end / 250) * 250;
}
function newAction(s) {
  const used = new Set((s.actions ?? []).map((a) => a.id));
  let i = 1;
  while (used.has(`aktion${i}`)) i++;
  const target = s.elements.find((e) => e.kind === "text") ?? s.elements.find((e) => e.kind !== "zone");
  return {
    id: `aktion${i}`,
    name: i === 1 ? "Hervorheben" : `Aktion ${i}`,
    effects: target ? [
      {
        target: target.id,
        type: "pulse",
        ms: 600,
        delay: 0
      }
    ] : []
  };
}
function setActions(s, actions) {
  return {
    ...s,
    actions
  };
}
function checkScene(s, fileNames, paramKeys) {
  const errors = [];
  const warnings = [];
  const files = new Set(fileNames);
  const ids = new Set(s.elements.map((e) => e.id));
  const zones = /* @__PURE__ */ new Map();
  for (const e of s.elements) {
    const who = `\u201E${e.name}\u201C`;
    if (e.kind === "image") {
      if (!e.file) errors.push(`${who}: kein Bild gew\xE4hlt`);
      else if (!files.has(e.file)) errors.push(`${who}: Bilddatei \u201E${e.file}\u201C fehlt im Paket`);
    }
    if (e.kind === "zone") zones.set(e.zone ?? "", (zones.get(e.zone ?? "") ?? 0) + 1);
    if (e.kind === "text" && !(e.text ?? "").trim()) warnings.push(`${who}: leerer Text`);
    if (e.x + e.w <= 0 || e.y + e.h <= 0 || e.x >= s.width || e.y >= s.height) warnings.push(`${who}: liegt ganz au\xDFerhalb der Fl\xE4che`);
    if (e.opacity === 0) warnings.push(`${who}: Deckkraft 0 \u2014 unsichtbar`);
    if ((e.from ?? 0) >= (s.stepCount ?? 1)) warnings.push(`${who}: erscheint erst nach dem letzten Schritt`);
    if (e.to !== void 0 && e.to >= 0 && e.to < (e.from ?? 0)) warnings.push(`${who}: \u201Ebis\u201C liegt vor \u201Evon\u201C (Schritt)`);
  }
  for (const [z, n] of zones) if (n > 1) errors.push(`Zone \u201E${z}\u201C kommt ${n}\xD7 vor \u2014 die ID muss eindeutig sein`);
  for (const f of s.fonts ?? []) if (!files.has(f.file)) errors.push(`Schrift \u201E${f.family}\u201C: Datei \u201E${f.file}\u201C fehlt im Paket`);
  for (const a of s.actions ?? []) {
    if (!a.effects.length) warnings.push(`Aktion \u201E${a.name}\u201C hat keine Effekte`);
    for (const fx of a.effects) if (!ids.has(fx.target)) errors.push(`Aktion \u201E${a.name}\u201C: Ziel \u201E${fx.target}\u201C gibt es nicht mehr`);
  }
  const keys = new Set(paramKeys);
  for (const p of placeholders(s)) if (!keys.has(p)) warnings.push(`Platzhalter {{${p}}} hat noch keinen Parameter (wird beim Speichern erg\xE4nzt)`);
  return {
    errors,
    warnings
  };
}
function setStepCount(s, n) {
  const count = Math.min(20, Math.max(1, Math.round(n)));
  return {
    ...s,
    stepCount: count,
    elements: s.elements.map((e) => ({
      ...e,
      from: Math.min(e.from ?? 0, count - 1),
      to: (e.to ?? -1) >= count ? -1 : e.to ?? -1
    }))
  };
}
function alignToScene(s, id, how) {
  const e = s.elements.find((x) => x.id === id);
  if (!e) return s;
  const p = how === "left" ? {
    x: 0
  } : how === "hcenter" ? {
    x: Math.round((s.width - e.w) / 2)
  } : how === "right" ? {
    x: s.width - e.w
  } : how === "top" ? {
    y: 0
  } : how === "vcenter" ? {
    y: Math.round((s.height - e.h) / 2)
  } : {
    y: s.height - e.h
  };
  return updateElement(s, id, p);
}
function hits(e, px, py) {
  const cx = e.x + e.w / 2, cy = e.y + e.h / 2;
  const a = -(e.rotation * Math.PI) / 180;
  const dx = px - cx, dy = py - cy;
  const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
  return Math.abs(lx) <= e.w / 2 && Math.abs(ly) <= e.h / 2;
}
function hitTest(s, px, py) {
  for (let i = s.elements.length - 1; i >= 0; i--) if (hits(s.elements[i], px, py)) return s.elements[i].id;
  return null;
}
var HANDLES = [
  "nw",
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w"
];
function resizeBox(b, handle, dx, dy, keepRatio = false) {
  let { x, y, w, h } = b;
  const ratio = b.w / b.h;
  if (handle.includes("e")) w = b.w + dx;
  if (handle.includes("w")) {
    w = b.w - dx;
    x = b.x + dx;
  }
  if (handle.includes("s")) h = b.h + dy;
  if (handle.includes("n")) {
    h = b.h - dy;
    y = b.y + dy;
  }
  if (keepRatio && handle.length === 2) {
    if (Math.abs(w - b.w) / b.w >= Math.abs(h - b.h) / b.h) h = w / ratio;
    else w = h * ratio;
    if (handle.includes("w")) x = b.x + b.w - w;
    if (handle.includes("n")) y = b.y + b.h - h;
  }
  if (w < MIN_SIZE) {
    if (handle.includes("w")) x -= MIN_SIZE - w;
    w = MIN_SIZE;
  }
  if (h < MIN_SIZE) {
    if (handle.includes("n")) y -= MIN_SIZE - h;
    h = MIN_SIZE;
  }
  return {
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(w),
    h: Math.round(h)
  };
}
function resizeRotated(b, rotation, handle, dx, dy, keepRatio = false) {
  const a = rotation * Math.PI / 180;
  const c = Math.cos(a), sn = Math.sin(a);
  const ldx = dx * c + dy * sn, ldy = -dx * sn + dy * c;
  const nb = resizeBox({
    x: 0,
    y: 0,
    w: b.w,
    h: b.h
  }, handle, ldx, ldy, keepRatio);
  const shiftX = nb.x + nb.w / 2 - b.w / 2, shiftY = nb.y + nb.h / 2 - b.h / 2;
  const cx = b.x + b.w / 2 + shiftX * c - shiftY * sn;
  const cy = b.y + b.h / 2 + shiftX * sn + shiftY * c;
  return {
    x: Math.round(cx - nb.w / 2),
    y: Math.round(cy - nb.h / 2),
    w: nb.w,
    h: nb.h
  };
}
function angleFor(b, px, py, snap = false) {
  let deg = Math.atan2(py - (b.y + b.h / 2), px - (b.x + b.w / 2)) * 180 / Math.PI + 90;
  deg = ((deg + 180) % 360 + 360) % 360 - 180;
  if (snap) deg = Math.round(deg / 15) * 15;
  return Math.round(deg * 10) / 10;
}
function boundsOf(s, ids) {
  const els = s.elements.filter((e) => ids.includes(e.id));
  if (!els.length) return null;
  const x1 = Math.min(...els.map((e) => e.x)), y1 = Math.min(...els.map((e) => e.y));
  const x2 = Math.max(...els.map((e) => e.x + e.w)), y2 = Math.max(...els.map((e) => e.y + e.h));
  return {
    x: x1,
    y: y1,
    w: x2 - x1,
    h: y2 - y1
  };
}
function elementsInRect(s, r) {
  return s.elements.filter((e) => e.x < r.x + r.w && e.x + e.w > r.x && e.y < r.y + r.h && e.y + e.h > r.y).map((e) => e.id);
}
function alignGroup(s, ids, how) {
  const b = boundsOf(s, ids);
  if (!b || ids.length < 2) return s;
  return withElements(s, s.elements.map((e) => {
    if (!ids.includes(e.id)) return e;
    switch (how) {
      case "left":
        return {
          ...e,
          x: b.x
        };
      case "hcenter":
        return {
          ...e,
          x: Math.round(b.x + (b.w - e.w) / 2)
        };
      case "right":
        return {
          ...e,
          x: b.x + b.w - e.w
        };
      case "top":
        return {
          ...e,
          y: b.y
        };
      case "vcenter":
        return {
          ...e,
          y: Math.round(b.y + (b.h - e.h) / 2)
        };
      default:
        return {
          ...e,
          y: b.y + b.h - e.h
        };
    }
  }));
}
function distribute(s, ids, axis) {
  const els = s.elements.filter((e) => ids.includes(e.id));
  if (els.length < 3) return s;
  const size = axis === "x" ? "w" : "h";
  const sorted = [
    ...els
  ].sort((a, b) => a[axis] - b[axis]);
  const first = sorted[0], last = sorted[sorted.length - 1];
  const total = last[axis] + last[size] - first[axis];
  const gap = (total - sorted.reduce((a, e) => a + e[size], 0)) / (sorted.length - 1);
  const pos = /* @__PURE__ */ new Map();
  let at = first[axis];
  for (const e of sorted) {
    pos.set(e.id, Math.round(at));
    at += e[size] + gap;
  }
  return withElements(s, s.elements.map((e) => pos.has(e.id) ? {
    ...e,
    [axis]: pos.get(e.id)
  } : e));
}
function duplicateMany(s, ids) {
  let cur = s;
  const out = [];
  for (const id of ids) {
    const r = duplicateElement(cur, id);
    cur = r.scene;
    if (r.id) out.push(r.id);
  }
  return {
    scene: cur,
    ids: out
  };
}
function snapBox(b, s, skipIds, threshold) {
  const xs = [
    0,
    s.width / 2,
    s.width
  ];
  const ys = [
    0,
    s.height / 2,
    s.height
  ];
  for (const e of s.elements) {
    if (skipIds.includes(e.id)) continue;
    xs.push(e.x, e.x + e.w / 2, e.x + e.w);
    ys.push(e.y, e.y + e.h / 2, e.y + e.h);
  }
  const pick = (own, targets) => {
    let best = null;
    for (const o of own) for (const t of targets) {
      const d = t - o;
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) best = {
        d,
        at: t
      };
    }
    return best;
  };
  const sx = pick([
    b.x,
    b.x + b.w / 2,
    b.x + b.w
  ], xs);
  const sy = pick([
    b.y,
    b.y + b.h / 2,
    b.y + b.h
  ], ys);
  const guides = [];
  if (sx) guides.push({
    axis: "x",
    at: sx.at
  });
  if (sy) guides.push({
    axis: "y",
    at: sy.at
  });
  return {
    box: {
      ...b,
      x: Math.round(b.x + (sx?.d ?? 0)),
      y: Math.round(b.y + (sy?.d ?? 0))
    },
    guides
  };
}
var PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
function placeholders(s) {
  const out = [];
  const add = (v) => {
    if (typeof v !== "string") return;
    for (const m of v.matchAll(PLACEHOLDER)) if (!out.includes(m[1])) out.push(m[1]);
  };
  for (const e of s.elements) for (const k of [
    "text",
    "fill",
    "stroke",
    "color",
    "bg"
  ]) add(e[k]);
  return out;
}
function isDesigner(files) {
  return "scene.json" in files;
}
var HEADER = "// ERZEUGT vom OGraf-Editor (Leinwand) \u2014 \xC4nderungen bitte in der Leinwand machen, sie werden beim Speichern \xFCberschrieben.\n";
function generateMain(runtime, scene) {
  return `${HEADER}${runtime}
export default createSceneElement(${JSON.stringify(scene)}, import.meta.url);
`;
}
function applyScene(files, id, scene, runtime) {
  const out = {
    ...files,
    "scene.json": JSON.stringify(scene, null, 2) + "\n",
    [`${id}.js`]: generateMain(runtime, scene)
  };
  const mname = Object.keys(out).find((n) => n.endsWith(".ograf.json"));
  if (mname) {
    try {
      const m = JSON.parse(out[mname]);
      const steps = Math.max(1, scene.stepCount ?? 1);
      const next = {
        ...m,
        main: `${id}.js`,
        stepCount: steps
      };
      const acts = (scene.actions ?? []).map((a) => ({
        id: a.id,
        name: a.name
      }));
      if (acts.length) next.customActions = acts;
      else delete next.customActions;
      if (JSON.stringify(next) !== JSON.stringify(m)) out[mname] = stringify(next);
    } catch {
    }
  }
  return out;
}
function newDesignerPackage(id, name, runtime) {
  const scene = newScene();
  const bar = {
    ...newElement("rect", scene),
    name: "Balken",
    x: 120,
    y: 820,
    w: 900,
    h: 150,
    fill: "{{barColor}}"
  };
  scene.elements.push(bar);
  const accent = {
    ...newElement("rect", withElements(scene, scene.elements)),
    name: "Akzent",
    x: 120,
    y: 820,
    w: 12,
    h: 150,
    fill: "{{accentColor}}"
  };
  accent.id = "r2";
  scene.elements.push(accent);
  const t1 = {
    ...newElement("text", withElements(scene, scene.elements)),
    name: "Name",
    id: "t1",
    x: 160,
    y: 830,
    w: 840,
    h: 80,
    text: "{{name}}",
    size: 60,
    weight: 700
  };
  t1.anim = {
    in: {
      type: "fromLeft",
      ms: 400,
      delay: 150,
      ease: "ease-out"
    },
    out: {
      type: "fade",
      ms: 250,
      delay: 0,
      ease: "ease-in"
    }
  };
  scene.elements.push(t1);
  const t2 = {
    ...newElement("text", withElements(scene, scene.elements)),
    name: "Untertitel",
    id: "t2",
    x: 160,
    y: 905,
    w: 840,
    h: 55,
    text: "{{title}}",
    size: 38,
    weight: 400,
    color: "#c8d0dc"
  };
  t2.anim = {
    in: {
      type: "fromLeft",
      ms: 400,
      delay: 280,
      ease: "ease-out"
    },
    out: {
      type: "fade",
      ms: 250,
      delay: 0,
      ease: "ease-in"
    }
  };
  scene.elements.push(t2);
  const manifest = {
    $schema: SCHEMA_URL,
    id,
    name,
    version: "1.0.0",
    main: `${id}.js`,
    supportsRealTime: true,
    supportsNonRealTime: false,
    stepCount: 1,
    schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          title: "Name",
          default: "Max Mustermann"
        },
        title: {
          type: "string",
          title: "Untertitel",
          default: "Reporter"
        },
        barColor: {
          type: "string",
          title: "Balkenfarbe",
          gddType: "color-rrggbb",
          pattern: COLOR_PATTERN,
          default: "#10151f"
        },
        accentColor: {
          type: "string",
          title: "Akzentfarbe",
          gddType: "color-rrggbb",
          pattern: COLOR_PATTERN,
          default: "#00c8ff"
        }
      }
    }
  };
  return applyScene({
    [`${id}.ograf.json`]: stringify(manifest)
  }, id, scene, runtime);
}
function ensureParams(fields, s) {
  const have = new Set(fields.map((f) => f.key));
  const colorKeys = /* @__PURE__ */ new Set();
  for (const e of s.elements) {
    for (const k of [
      "fill",
      "stroke",
      "color",
      "bg"
    ]) {
      const v = e[k];
      if (typeof v === "string") for (const m of v.matchAll(PLACEHOLDER)) colorKeys.add(m[1]);
    }
  }
  const out = [
    ...fields
  ];
  for (const k of placeholders(s)) {
    if (have.has(k)) continue;
    const isColor = colorKeys.has(k);
    out.push({
      key: k,
      title: k,
      kind: isColor ? "color" : "text",
      def: isColor ? "#ffffff" : "",
      choices: [],
      required: false,
      extra: {}
    });
  }
  return out;
}
var History = class {
  current;
  limit;
  #past;
  #future;
  constructor(current, limit = 100) {
    this.current = current;
    this.limit = limit;
    this.#past = [];
    this.#future = [];
  }
  get value() {
    return this.current;
  }
  push(next) {
    this.#past.push(this.current);
    if (this.#past.length > this.limit) this.#past.shift();
    this.#future = [];
    this.current = next;
  }
  /** Aktuellen Stand ersetzen, ohne Verlaufseintrag (laufende Zeigergeste). */
  replaceCurrent(next) {
    this.current = next;
  }
  get canUndo() {
    return this.#past.length > 0;
  }
  get canRedo() {
    return this.#future.length > 0;
  }
  undo() {
    const p = this.#past.pop();
    if (p !== void 0) {
      this.#future.push(this.current);
      this.current = p;
    }
    return this.current;
  }
  redo() {
    const f = this.#future.pop();
    if (f !== void 0) {
      this.#past.push(this.current);
      this.current = f;
    }
    return this.current;
  }
};

// ui/modules/ograf-editor/messages.ts
var messages = {
  de: {
    title: "Vorlagen-Bibliothek",
    back: "\u2039 Zur Sendung",
    openLib: "Vorlagen bearbeiten",
    newTpl: "\uFF0B Neu",
    duplicate: "Duplizieren",
    delete: "L\xF6schen",
    importBtn: "Import\u2026",
    exportBtn: "Export (ZIP)",
    search: "Suchen\u2026",
    rename: "ID \xE4ndern\u2026",
    askRename: "Neue Kennung (ID) f\xFCr \u201E{id}\u201C",
    renameFailed: "ID \xE4ndern fehlgeschlagen: {why}",
    upload: "Hochladen\u2026",
    binaryInfo: "Bin\xE4rdatei, {kb} KB",
    importSkipped: "Importiert. Nicht \xFCbernommen: {list}",
    noMatch: "Keine Treffer.",
    save: "Speichern",
    revert: "Verwerfen",
    dirty: "\u25CF ungespeichert",
    saved: "Gespeichert.",
    none: "Keine Vorlage gew\xE4hlt.",
    empty: "Noch keine Vorlagen.",
    tabGeneral: "Allgemein",
    tabParams: "Parameter",
    tabSource: "Quelltext",
    askName: "Name der neuen Vorlage",
    askCopyName: "Name der Kopie",
    askDelete: "Vorlage \u201E{id}\u201C endg\xFCltig l\xF6schen?",
    valid: "g\xFCltig",
    invalid: "fehlerhaft",
    errors: "Fehler",
    warnings: "Hinweise",
    name: "Name",
    id: "Kennung (ID)",
    version: "Version",
    description: "Beschreibung",
    author: "Autor",
    authorEmail: "E-Mail",
    authorUrl: "Web",
    steps: "Schritte (stepCount, \u22121 = dynamisch)",
    realtime: "Echtzeit (supportsRealTime)",
    nonRealtime: "Nicht-Echtzeit (supportsNonRealTime)",
    resolution: "Renderaufl\xF6sung (0 = keine Angabe)",
    frameRate: "Bildrate (0 = keine Angabe)",
    addField: "\uFF0B Parameter",
    key: "Schl\xFCssel",
    fieldTitle: "Beschriftung",
    kind: "Art",
    def: "Vorgabe",
    choices: "Auswahl (kommagetrennt)",
    required: "Pflicht",
    remove: "Entfernen",
    up: "Nach oben",
    down: "Nach unten",
    kText: "Text",
    kMulti: "Mehrzeilig",
    kNumber: "Zahl",
    kBool: "Ja/Nein",
    kColor: "Farbe",
    kChoice: "Auswahl",
    file: "Datei",
    addFile: "\uFF0B Datei",
    delFile: "Datei l\xF6schen",
    askFile: "Dateiname (z. B. stil.css)",
    importFailed: "Import fehlgeschlagen: {why}",
    importExists: "Vorlage \u201E{id}\u201C gibt es schon. Als \u201E{newId}\u201C importieren?",
    loadFailed: "Laden fehlgeschlagen",
    saveFailed: "Speichern fehlgeschlagen: {why}",
    leaveDirty: "Ungespeicherte \xC4nderungen verwerfen?",
    manifestBroken: "Das Manifest ist kein g\xFCltiges JSON \u2014 bitte im Quelltext reparieren.",
    tabCanvas: "Leinwand",
    newDesigner: "\uFF0B Designer",
    kRect: "Fl\xE4che",
    kImage: "Bild",
    kZone: "Zone",
    undo: "R\xFCckg\xE4ngig (Strg+Z)",
    redo: "Wiederholen (Strg+Y)",
    previewHint: "Vorschau: Einblenden, kurz halten, Ausblenden",
    snap: "Einrasten (Alt beim Ziehen = aus)",
    canvasEmpty: "Noch keine Elemente. Oben eines hinzuf\xFCgen.",
    noSelection: "Nichts ausgew\xE4hlt. Auf ein Element klicken oder in der Liste w\xE4hlen.",
    rotation: "Drehung \xB0",
    opacity: "Deckkraft",
    align: "Ausrichten",
    content: "Inhalt",
    insertParam: "Parameter einf\xFCgen",
    font: "Schrift",
    size: "Gr\xF6\xDFe / St\xE4rke",
    color: "Farbe",
    hAlign: "Ausrichtung",
    lineHeight: "Zeilenh\xF6he / Rand",
    background: "Hintergrund",
    fill: "F\xFCllung",
    radius: "Rundung",
    stroke: "Rahmen",
    strokeW: "Rahmenst\xE4rke",
    fit: "Einpassen",
    noImages: "Keine Bilder im Paket \u2014 im Reiter Quelltext hochladen.",
    zoneId: "Zonen-ID",
    zoneHint: "Eine Zone ist ein Fenster: Der Bildmischer legt dort ein Bild ein (Squeeze-back) oder f\xE4hrt den Paternoster.",
    animIn: "Einblenden",
    animOut: "Ausblenden",
    animType: "Art",
    animMs: "Dauer / Verzug ms",
    animEase: "Verlauf",
    anim_none: "keine",
    anim_fade: "\xDCberblenden",
    anim_fromLeft: "von links",
    anim_fromRight: "von rechts",
    anim_fromTop: "von oben",
    anim_fromBottom: "von unten",
    anim_scale: "Zoom",
    anim_wipe: "Wischen",
    fonts: "Schriften",
    autofit: "Passend verkleinern / min.",
    groupCount: "{n} Elemente gew\xE4hlt",
    alignLeft: "Links b\xFCndig",
    alignHCenter: "Horizontal zentrieren",
    alignRight: "Rechts b\xFCndig",
    alignTop: "Oben b\xFCndig",
    alignVCenter: "Vertikal zentrieren",
    alignBottom: "Unten b\xFCndig",
    distributeX: "Waagerecht gleichm\xE4\xDFig verteilen",
    distributeY: "Senkrecht gleichm\xE4\xDFig verteilen",
    stepsLabel: "Schritte",
    viewStep: "Ansicht dieses Schritts (andere Elemente blass)",
    previewStop: "Vorschau beenden (Ausblenden)",
    previewNext: "N\xE4chster Schritt (Weiter)",
    timeline: "Zeitleiste",
    noAnim: "Keine Animation \u2014 Doppelklick legt eine an",
    stepRange: "Sichtbar in Schritten",
    fromTo: "von / bis (0 = Ende)",
    testShow: "\u25B6 Sendetest",
    testNext: "\u23ED",
    testOff: "\u25A0",
    testHint: "Vorlage auf dem Grafik-Node einblenden (Ebene \u201Eeditor-test\u201C)",
    testNextHint: "Weiter (n\xE4chster Schritt)",
    testOffHint: "Sendetest ausblenden",
    saveFirst: "Erst speichern, dann testen.",
    testFailed: "Sendetest fehlgeschlagen: {why}",
    scrub: "Wiedergabekopf: Zeitpunkt der Animation ansehen (loslassen = zur\xFCck)",
    actions: "Aktionen",
    actionPlay: "Aktion in der Vorschau abspielen",
    addAction: "\uFF0B Aktion",
    addEffect: "\uFF0B Effekt",
    fx_pulse: "Puls",
    fx_flash: "Blinken",
    fx_shake: "Wackeln",
    fx_bounce: "H\xFCpfen",
    kRaw: "Erweitert",
    rawField: "Erweiterte Eigenschaft (z. B. Mehrfachauswahl) \u2014 im Quelltext bearbeiten",
    check: "Pr\xFCfung",
    checkOk: "in Ordnung",
    thumbnail: "Vorschaubild",
    noThumb: "\u2013 keines \u2013",
    layoutNone: "Keine Zonen: Die stehende Grafik meldet kein Fenster (Element mit data-ograf-zone).",
    layoutHidden: "Grafik nicht auf Sendung",
    layoutHiddenHint: "Zuerst die Grafik einblenden, dann koppeln",
    layoutOn: "Fenster aktiv",
    layoutOff: "Fenster aus",
    layoutUnbind: "L\xF6sen",
    layoutBind: "Koppeln",
    kindPip: "Bild im Fenster (PIP)",
    kindWindow: "Fenster f\xFCr Paternoster",
    kindFollow: "Fenster folgt PIP-Slot (Klick-Vergr\xF6\xDFern bleibt im Mischer)",
    mixer: "Mischer",
    source: "Quelle",
    slot: "PIP-Slot",
    srcPst: "Preset (pst:1)",
    noMixer: "Kein Videomischer gefunden.",
    generated: "Erzeugt aus der Leinwand \u2014 nicht von Hand bearbeiten."
  },
  en: {
    title: "Template library",
    back: "\u2039 Back to on-air",
    openLib: "Edit templates",
    newTpl: "\uFF0B New",
    duplicate: "Duplicate",
    delete: "Delete",
    importBtn: "Import\u2026",
    exportBtn: "Export (ZIP)",
    search: "Search\u2026",
    rename: "Change ID\u2026",
    askRename: "New identifier (ID) for \u201C{id}\u201D",
    renameFailed: "Changing the ID failed: {why}",
    upload: "Upload\u2026",
    binaryInfo: "Binary file, {kb} KB",
    importSkipped: "Imported. Not taken over: {list}",
    noMatch: "No matches.",
    save: "Save",
    revert: "Discard",
    dirty: "\u25CF unsaved",
    saved: "Saved.",
    none: "No template selected.",
    empty: "No templates yet.",
    tabGeneral: "General",
    tabParams: "Parameters",
    tabSource: "Source",
    askName: "Name of the new template",
    askCopyName: "Name of the copy",
    askDelete: "Delete template \u201C{id}\u201D permanently?",
    valid: "valid",
    invalid: "faulty",
    errors: "Errors",
    warnings: "Notes",
    name: "Name",
    id: "Identifier (ID)",
    version: "Version",
    description: "Description",
    author: "Author",
    authorEmail: "E-mail",
    authorUrl: "Web",
    steps: "Steps (stepCount, \u22121 = dynamic)",
    realtime: "Real time (supportsRealTime)",
    nonRealtime: "Non-real time (supportsNonRealTime)",
    resolution: "Render resolution (0 = unspecified)",
    frameRate: "Frame rate (0 = unspecified)",
    addField: "\uFF0B Parameter",
    key: "Key",
    fieldTitle: "Label",
    kind: "Kind",
    def: "Default",
    choices: "Choices (comma-separated)",
    required: "Required",
    remove: "Remove",
    up: "Move up",
    down: "Move down",
    kText: "Text",
    kMulti: "Multi-line",
    kNumber: "Number",
    kBool: "Yes/No",
    kColor: "Colour",
    kChoice: "Choice",
    file: "File",
    addFile: "\uFF0B File",
    delFile: "Delete file",
    askFile: "File name (e.g. style.css)",
    importFailed: "Import failed: {why}",
    importExists: "Template \u201C{id}\u201D already exists. Import as \u201C{newId}\u201D?",
    loadFailed: "Loading failed",
    saveFailed: "Saving failed: {why}",
    leaveDirty: "Discard unsaved changes?",
    manifestBroken: "The manifest is not valid JSON \u2014 please repair it in the source tab.",
    tabCanvas: "Canvas",
    newDesigner: "\uFF0B Designer",
    kRect: "Shape",
    kImage: "Image",
    kZone: "Zone",
    undo: "Undo (Ctrl+Z)",
    redo: "Redo (Ctrl+Y)",
    previewHint: "Preview: animate in, hold briefly, animate out",
    snap: "Snap (Alt while dragging = off)",
    canvasEmpty: "No elements yet. Add one above.",
    noSelection: "Nothing selected. Click an element or choose one in the list.",
    rotation: "Rotation \xB0",
    opacity: "Opacity",
    align: "Align",
    content: "Content",
    insertParam: "Insert parameter",
    font: "Font",
    size: "Size / weight",
    color: "Colour",
    hAlign: "Alignment",
    lineHeight: "Line height / padding",
    background: "Background",
    fill: "Fill",
    radius: "Radius",
    stroke: "Border",
    strokeW: "Border width",
    fit: "Fit",
    noImages: "No images in the package \u2014 upload them in the Source tab.",
    zoneId: "Zone ID",
    zoneHint: "A zone is a window: the video mixer places a picture there (squeeze-back) or runs the paternoster.",
    animIn: "Animate in",
    animOut: "Animate out",
    animType: "Type",
    animMs: "Duration / delay ms",
    animEase: "Easing",
    anim_none: "none",
    anim_fade: "Fade",
    anim_fromLeft: "from left",
    anim_fromRight: "from right",
    anim_fromTop: "from top",
    anim_fromBottom: "from bottom",
    anim_scale: "Zoom",
    anim_wipe: "Wipe",
    fonts: "Fonts",
    autofit: "Shrink to fit / min.",
    groupCount: "{n} elements selected",
    alignLeft: "Align left",
    alignHCenter: "Centre horizontally",
    alignRight: "Align right",
    alignTop: "Align top",
    alignVCenter: "Centre vertically",
    alignBottom: "Align bottom",
    distributeX: "Distribute horizontally",
    distributeY: "Distribute vertically",
    stepsLabel: "Steps",
    viewStep: "View this step (other elements dimmed)",
    previewStop: "End preview (animate out)",
    previewNext: "Next step (continue)",
    timeline: "Timeline",
    noAnim: "No animation \u2014 double-click adds one",
    stepRange: "Visible in steps",
    fromTo: "from / to (0 = end)",
    testShow: "\u25B6 On-air test",
    testNext: "\u23ED",
    testOff: "\u25A0",
    testHint: "Show the template on the graphics node (layer \u201Ceditor-test\u201D)",
    testNextHint: "Continue (next step)",
    testOffHint: "Hide the on-air test",
    saveFirst: "Save first, then test.",
    testFailed: "On-air test failed: {why}",
    scrub: "Playhead: view the animation at a point in time (release = back)",
    actions: "Actions",
    actionPlay: "Play the action in the preview",
    addAction: "\uFF0B Action",
    addEffect: "\uFF0B Effect",
    fx_pulse: "Pulse",
    fx_flash: "Flash",
    fx_shake: "Shake",
    fx_bounce: "Bounce",
    kRaw: "Advanced",
    rawField: "Advanced property (e.g. multiple choice) \u2014 edit in the Source tab",
    check: "Check",
    checkOk: "all good",
    thumbnail: "Thumbnail",
    noThumb: "\u2013 none \u2013",
    layoutNone: "No zones: the graphic on air reports no window (element with data-ograf-zone).",
    layoutHidden: "graphic not on air",
    layoutHiddenHint: "Show the graphic first, then couple",
    layoutOn: "window active",
    layoutOff: "window off",
    layoutUnbind: "Release",
    layoutBind: "Couple",
    kindPip: "Picture in window (PIP)",
    kindWindow: "Window for paternoster",
    kindFollow: "Window follows PIP slot (click-to-enlarge stays in the mixer)",
    mixer: "Mixer",
    source: "Source",
    slot: "PIP slot",
    srcPst: "Preset (pst:1)",
    noMixer: "No video mixer found.",
    generated: "Generated from the canvas \u2014 do not edit by hand."
  }
};

// ui/modules/ograf-editor/canvas.ts
var L = (document.documentElement.lang || "de").startsWith("en") ? "en" : "de";
var tr = (k) => messages[L][k] ?? messages.de[k] ?? k;
var STYLE = `
:host { display: block; }
.cv { display: grid; grid-template-columns: 200px minmax(360px, 1fr) 280px; gap: 10px; align-items: start; }
.col { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.tools { display: flex; flex-wrap: wrap; gap: 4px; }
.vp { position: relative; width: 100%; background: repeating-conic-gradient(#2a2d31 0% 25%, #222529 0% 50%) 0 0 / 24px 24px; border: 1px solid var(--omp-border, #2e3338); overflow: hidden; outline: none; user-select: none; touch-action: none; }
.ov { position: absolute; left: 0; top: 0; width: 100%; height: 100%; pointer-events: none; }
.sel { position: absolute; border: 1px solid #00c8ff; box-sizing: border-box; }
.hd { position: absolute; width: 9px; height: 9px; margin: -5px 0 0 -5px; background: #fff; border: 1px solid #00c8ff; box-sizing: border-box; pointer-events: auto; }
.guide { position: absolute; background: #ff3b81; }
.tl { border: 1px solid var(--omp-border, #2e3338); border-radius: 4px; padding: 4px; display: flex; flex-direction: column; gap: 2px; }
.tl .hd2 { display: flex; gap: 6px; align-items: center; }
.tl .row { display: grid; grid-template-columns: 110px 1fr; gap: 6px; align-items: center; }
.tl .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.tl .nm.on { color: #fff; background: var(--omp-info, #4285f4); border-radius: 3px; padding: 0 3px; }
.tl .track { position: relative; height: 16px; background: var(--omp-bg-2, #1c1f22); border-radius: 3px; }
.tl .bar { position: absolute; top: 2px; height: 12px; border-radius: 3px; background: #4285f4; cursor: grab; box-sizing: border-box; min-width: 4px; }
.tl .bar.out { background: #d97706; }
.tl .bar .gr { position: absolute; right: 0; top: 0; width: 6px; height: 100%; cursor: ew-resize; background: rgba(255,255,255,.45); border-radius: 0 3px 3px 0; }
.tl .ruler { position: relative; height: 12px; color: var(--omp-text-dim, #9aa0a6); font-size: 10px; }
.layers { display: flex; flex-direction: column; border: 1px solid var(--omp-border, #2e3338); border-radius: 4px; max-height: 360px; overflow: auto; }
.ly { display: flex; align-items: center; gap: 4px; padding: 3px 6px; cursor: pointer; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; }
.ly.on { background: var(--omp-info, #4285f4); color: #fff; }
.ly .n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pp { display: grid; grid-template-columns: 90px 1fr; gap: 4px 6px; align-items: center; }
.pp h4 { grid-column: 1 / -1; margin: 6px 0 0; font-size: 11px; color: var(--omp-text-dim, #9aa0a6); text-transform: uppercase; letter-spacing: .05em; }
.pp label { color: var(--omp-text-dim, #9aa0a6); }
.pp .two { display: flex; gap: 4px; }
button.s { cursor: pointer; font: inherit; padding: 3px 8px; border-radius: 4px; border: 1px solid var(--omp-border, #3a3f45); background: var(--omp-surface-raised, #2f3339); color: inherit; }
button.s:disabled { opacity: .4; cursor: default; }
button.s.on { background: var(--omp-info, #4285f4); border-color: var(--omp-info, #4285f4); color: #fff; }
input, select, textarea { font: inherit; padding: 2px 5px; border-radius: 4px; background: var(--omp-bg-2, #1c1f22); color: var(--omp-text, #e8eaed); border: 1px solid var(--omp-border, #2e3338); min-width: 0; width: 100%; box-sizing: border-box; }
input[type=color] { padding: 0 2px; height: 22px; width: 40px; flex: none; }
textarea { min-height: 54px; resize: vertical; }
`;
var KIND_LABEL = {
  text: "kText",
  rect: "kRect",
  image: "kImage",
  zone: "kZone"
};
var CanvasEditor = class {
  el;
  #root;
  #host;
  #hist;
  #selIds = [];
  #vp;
  #ov;
  #side;
  #layers;
  #tools;
  #scale = 1;
  #handle = null;
  #guides = [];
  #drag = null;
  #marquee = null;
  #viewStep = 0;
  #pvStep = 0;
  #tl;
  #tlDir = "in";
  #tdrag = null;
  #preview = false;
  #ro;
  #snap = true;
  constructor(host) {
    this.#host = host;
    this.#hist = new History(host.scene);
    this.el = document.createElement("div");
    this.#root = this.el.attachShadow({
      mode: "open"
    });
    this.#build();
    this.#ro = new ResizeObserver(() => this.#fit());
    this.#ro.observe(this.#vp);
    queueMicrotask(() => this.#redraw());
  }
  get scene() {
    return this.#hist.value;
  }
  /** Nach Änderungen außerhalb (neue Bilder/Schriften im Paket) Listen und Vorschau neu aufbauen. */
  refresh() {
    this.#redraw();
  }
  destroy() {
    this.#ro.disconnect();
    this.#handle?.destroy();
  }
  /** Szene von außen ersetzen (z. B. nach Verwerfen). */
  setScene(s) {
    this.#hist = new History(s);
    this.#pick(this.#selIds);
    this.#redraw();
  }
  // ── Aufbau ──
  #btn(label, onClick, title = "", cls = "", disabled = false) {
    const b = document.createElement("button");
    b.type = "button";
    b.disabled = disabled;
    b.className = `s ${cls}`.trim();
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }
  #build() {
    const style = document.createElement("style");
    style.textContent = STYLE;
    const cv = document.createElement("div");
    cv.className = "cv";
    const left = document.createElement("div");
    left.className = "col";
    this.#tools = document.createElement("div");
    this.#tools.className = "tools";
    this.#layers = document.createElement("div");
    this.#layers.className = "layers";
    left.append(this.#tools, this.#layers);
    const mid = document.createElement("div");
    mid.className = "col";
    this.#vp = document.createElement("div");
    this.#vp.className = "vp";
    this.#vp.tabIndex = 0;
    this.#ov = document.createElement("div");
    this.#ov.className = "ov";
    this.#vp.append(this.#ov);
    this.#tl = document.createElement("div");
    this.#tl.className = "tl";
    mid.append(this.#vp, this.#tl);
    this.#side = document.createElement("div");
    this.#side.className = "col";
    cv.append(left, mid, this.#side);
    this.#root.append(style, cv);
    this.#vp.addEventListener("pointerdown", (e) => this.#down(e));
    this.#vp.addEventListener("pointermove", (e) => this.#move(e));
    this.#vp.addEventListener("pointerup", (e) => this.#up(e));
    this.#vp.addEventListener("pointercancel", (e) => this.#up(e));
    this.#vp.addEventListener("keydown", (e) => this.#key(e));
  }
  // ── Zeichnen ──
  #fit() {
    const s = this.scene;
    const w = this.#vp.clientWidth || 640;
    this.#scale = w / s.width;
    this.#vp.style.height = `${Math.round(s.height * this.#scale)}px`;
    this.#drawOverlay();
    if (this.#handle) this.#handle.stage.style.transform = `scale(${this.#scale})`;
  }
  #redraw() {
    this.#handle?.destroy();
    const s = this.scene;
    this.#scale = (this.#vp.clientWidth || 640) / s.width;
    this.#vp.style.height = `${Math.round(s.height * this.#scale)}px`;
    this.#handle = renderScene(this.#vp, s, this.#host.data(), {
      editor: !this.#preview,
      step: this.#viewStep,
      scale: () => this.#scale,
      resolveAsset: (f) => this.#host.assetUrl(f)
    });
    this.#vp.insertBefore(this.#handle.stage, this.#ov);
    this.#drawOverlay();
    this.#drawTimeline();
    this.#drawTools();
    this.#drawLayers();
    this.#drawProps();
  }
  /** Das einzelne gewählte Element (nur bei genau einer Auswahl). */
  #selected() {
    return this.#selIds.length === 1 ? this.scene.elements.find((e) => e.id === this.#selIds[0]) : void 0;
  }
  #pick(ids) {
    this.#selIds = ids.filter((id) => this.scene.elements.some((e) => e.id === id));
  }
  #drawOverlay() {
    this.#ov.innerHTML = "";
    if (this.#preview) return;
    const k = this.#scale;
    const single = this.#selected();
    for (const id of this.#selIds) {
      const e = this.scene.elements.find((x) => x.id === id);
      if (!e) continue;
      const sel = document.createElement("div");
      sel.className = "sel";
      sel.style.cssText = `left:${e.x * k}px;top:${e.y * k}px;width:${e.w * k}px;height:${e.h * k}px;transform:rotate(${e.rotation}deg)`;
      if (e === single) {
        for (const h of HANDLES) {
          const d = document.createElement("div");
          d.className = "hd";
          d.dataset.handle = h;
          d.style.cursor = `${h}-resize`;
          d.style.left = h.includes("w") ? "0" : h.includes("e") ? "100%" : "50%";
          d.style.top = h.includes("n") ? "0" : h.includes("s") ? "100%" : "50%";
          sel.append(d);
        }
        const rot = document.createElement("div");
        rot.className = "hd rot";
        rot.dataset.handle = "rot";
        rot.style.cssText = "left:50%;top:-22px;border-radius:50%;cursor:grab";
        const stem = document.createElement("div");
        stem.style.cssText = "position:absolute;left:50%;top:-17px;width:1px;height:17px;background:#00c8ff";
        sel.append(stem, rot);
      }
      this.#ov.append(sel);
    }
    if (this.#selIds.length > 1) {
      const bb = boundsOf(this.scene, this.#selIds);
      if (bb) {
        const g = document.createElement("div");
        g.className = "sel";
        g.style.cssText = `left:${bb.x * k}px;top:${bb.y * k}px;width:${bb.w * k}px;height:${bb.h * k}px;border-style:dashed`;
        this.#ov.append(g);
      }
    }
    if (this.#marquee) {
      const m = this.#marquee;
      const d = document.createElement("div");
      d.className = "sel";
      d.style.cssText = `left:${m.x * k}px;top:${m.y * k}px;width:${m.w * k}px;height:${m.h * k}px;background:rgba(0,200,255,.12)`;
      this.#ov.append(d);
    }
    for (const g of this.#guides) {
      const d = document.createElement("div");
      d.className = "guide";
      d.style.cssText = g.axis === "x" ? `left:${g.at * k}px;top:0;width:1px;height:100%` : `top:${g.at * k}px;left:0;height:1px;width:100%`;
      this.#ov.append(d);
    }
  }
  #drawTools() {
    const t = this.#tools;
    t.innerHTML = "";
    if (this.#preview) {
      const n2 = this.scene.stepCount ?? 1;
      t.append(this.#btn("\u25A0", () => void this.#togglePreview(), tr("previewStop"), "on"), this.#btn("\u23ED", () => void this.#pvNext(), tr("previewNext"), "", n2 < 2 || this.#pvStep >= n2 - 1), document.createTextNode(` ${this.#pvStep + 1}/${n2}`));
      return;
    }
    for (const k of KINDS) t.append(this.#btn(`\uFF0B ${tr(KIND_LABEL[k])}`, () => this.#add(k)));
    const sel = this.#selIds.length > 0;
    t.append(this.#btn("\u21B6", () => this.#undo(), tr("undo"), "", !this.#hist.canUndo), this.#btn("\u21B7", () => this.#redo(), tr("redo"), "", !this.#hist.canRedo), this.#btn("\u29C9", () => this.#dup(), tr("duplicate"), "", !sel), this.#btn("\u2715", () => this.#del(), tr("delete"), "", !sel), this.#btn("\u25B6", () => void this.#togglePreview(), tr("previewHint")), this.#btn("\u2317", () => {
      this.#snap = !this.#snap;
      this.#drawTools();
    }, tr("snap"), this.#snap ? "on" : ""));
    const n = this.scene.stepCount ?? 1;
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:4px;align-items:center;flex-basis:100%";
    const lab = document.createElement("span");
    lab.textContent = tr("stepsLabel");
    const cnt = document.createElement("input");
    cnt.type = "number";
    cnt.min = "1";
    cnt.max = "20";
    cnt.value = String(n);
    cnt.style.width = "52px";
    cnt.addEventListener("change", () => this.#commit(setStepCount(this.scene, Number(cnt.value) || 1)));
    row.append(lab, cnt);
    if (n > 1) {
      for (let i = 0; i < n; i++) row.append(this.#btn(String(i + 1), () => {
        this.#viewStep = i;
        this.#redraw();
      }, tr("viewStep"), i === this.#viewStep ? "on" : ""));
    }
    t.append(row);
  }
  #drawLayers() {
    const box = this.#layers;
    box.innerHTML = "";
    for (const e of [
      ...this.scene.elements
    ].reverse()) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `ly${this.#selIds.includes(e.id) ? " on" : ""}`;
      const icon = {
        text: "T",
        rect: "\u25AD",
        image: "\u{1F5BC}",
        zone: "\u2B1A"
      }[e.kind];
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = `${icon} ${e.name}`;
      b.append(n);
      for (const [l, how, ttl] of [
        [
          "\u25B2",
          "up",
          tr("up")
        ],
        [
          "\u25BC",
          "down",
          tr("down")
        ]
      ]) {
        const m = document.createElement("span");
        m.textContent = l;
        m.title = ttl;
        m.style.padding = "0 3px";
        m.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.#commit(reorder(this.scene, e.id, how));
        });
        b.append(m);
      }
      b.addEventListener("click", (ev) => {
        this.#selIds = ev.shiftKey ? this.#selIds.includes(e.id) ? this.#selIds.filter((x) => x !== e.id) : [
          ...this.#selIds,
          e.id
        ] : [
          e.id
        ];
        this.#redraw();
      });
      box.append(b);
    }
    if (!this.scene.elements.length) box.append(document.createTextNode(tr("canvasEmpty")));
    this.#drawFonts();
    this.#drawActions();
    this.#drawCheck();
  }
  #chkBox;
  #drawCheck() {
    if (!this.#chkBox) {
      this.#chkBox = document.createElement("div");
      this.#chkBox.className = "col";
      (this.#actBox ?? this.#layers).after(this.#chkBox);
    }
    const box = this.#chkBox;
    box.innerHTML = "";
    const r = checkScene(this.scene, this.#host.files(), this.#host.params().map((p) => p.key));
    const h = document.createElement("div");
    h.textContent = `${tr("check")}: ${r.errors.length ? `${r.errors.length} ${tr("errors")}` : tr("checkOk")}${r.warnings.length ? ` \xB7 ${r.warnings.length} ${tr("warnings")}` : ""}`;
    h.style.cssText = `font-size:11px;color:${r.errors.length ? "#ff7b72" : "#3fb950"}`;
    box.append(h);
    for (const [list, color] of [
      [
        r.errors,
        "#ff7b72"
      ],
      [
        r.warnings,
        "#e3b341"
      ]
    ]) {
      for (const m of list) {
        const d = document.createElement("div");
        d.textContent = `\u2022 ${m}`;
        d.style.cssText = `font-size:11px;color:${color}`;
        box.append(d);
      }
    }
  }
  #actBox;
  #fontBox;
  #drawActions() {
    if (!this.#actBox) {
      this.#actBox = document.createElement("div");
      this.#actBox.className = "col";
      (this.#fontBox ?? this.#layers).after(this.#actBox);
    }
    const box = this.#actBox;
    box.innerHTML = "";
    const h = document.createElement("div");
    h.textContent = tr("actions");
    h.style.cssText = "color:var(--omp-text-dim,#9aa0a6);font-size:11px;text-transform:uppercase;letter-spacing:.05em";
    box.append(h);
    const acts = this.scene.actions ?? [];
    const names = this.scene.elements.filter((e) => e.kind !== "zone");
    const save = (next) => this.#commit(setActions(this.scene, next));
    acts.forEach((a, ai) => {
      const card = document.createElement("div");
      card.style.cssText = "border:1px solid var(--omp-border,#2e3338);border-radius:4px;padding:4px;display:flex;flex-direction:column;gap:3px";
      const top = document.createElement("div");
      top.style.cssText = "display:flex;gap:4px";
      const nm = document.createElement("input");
      nm.value = a.name;
      nm.title = `ID: ${a.id}`;
      nm.addEventListener("change", () => save(acts.map((x, i) => i === ai ? {
        ...x,
        name: nm.value || x.id
      } : x)));
      top.append(nm, this.#btn("\u25B6", () => void this.#handle?.action(a.id), tr("actionPlay")), this.#btn("\u2715", () => save(acts.filter((_, i) => i !== ai)), tr("remove")));
      card.append(top);
      a.effects.forEach((fx, fi) => {
        const row = document.createElement("div");
        row.style.cssText = "display:grid;grid-template-columns:1fr 78px 50px auto;gap:3px";
        const set = (p) => save(acts.map((x, i) => i === ai ? {
          ...x,
          effects: x.effects.map((f, j) => j === fi ? {
            ...f,
            ...p
          } : f)
        } : x));
        const tgt = document.createElement("select");
        for (const e of names) {
          const o = document.createElement("option");
          o.value = e.id;
          o.textContent = e.name;
          tgt.append(o);
        }
        tgt.value = fx.target;
        tgt.addEventListener("change", () => set({
          target: tgt.value
        }));
        const typ = document.createElement("select");
        for (const t of EFFECT_TYPES) {
          const o = document.createElement("option");
          o.value = t;
          o.textContent = tr(`fx_${t}`);
          typ.append(o);
        }
        typ.value = fx.type;
        typ.addEventListener("change", () => set({
          type: typ.value
        }));
        const ms = document.createElement("input");
        ms.type = "number";
        ms.value = String(fx.ms);
        ms.title = tr("animMs");
        ms.addEventListener("change", () => set({
          ms: Math.max(50, Number(ms.value) || 600)
        }));
        row.append(tgt, typ, ms, this.#btn("\u2715", () => save(acts.map((x, i) => i === ai ? {
          ...x,
          effects: x.effects.filter((_, j) => j !== fi)
        } : x)), tr("remove")));
        card.append(row);
      });
      card.append(this.#btn(tr("addEffect"), () => {
        const first = names[0];
        if (first) save(acts.map((x, i) => i === ai ? {
          ...x,
          effects: [
            ...x.effects,
            {
              target: first.id,
              type: "pulse",
              ms: 600,
              delay: 0
            }
          ]
        } : x));
      }));
      box.append(card);
    });
    box.append(this.#btn(tr("addAction"), () => save([
      ...acts,
      newAction(this.scene)
    ])));
  }
  #drawFonts() {
    if (!this.#fontBox) {
      this.#fontBox = document.createElement("div");
      this.#fontBox.className = "col";
      this.#layers.after(this.#fontBox);
    }
    const box = this.#fontBox;
    box.innerHTML = "";
    const files = this.#host.fonts();
    if (!files.length) return;
    const h = document.createElement("div");
    h.textContent = tr("fonts");
    h.style.cssText = "color:var(--omp-text-dim,#9aa0a6);font-size:11px;text-transform:uppercase;letter-spacing:.05em";
    box.append(h);
    for (const f of files) {
      const used = (this.scene.fonts ?? []).find((x) => x.file === f);
      const row = document.createElement("label");
      row.style.cssText = "display:flex;gap:6px;align-items:center";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.style.width = "auto";
      cb.checked = !!used;
      cb.addEventListener("change", () => {
        const fonts = (this.scene.fonts ?? []).filter((x) => x.file !== f);
        if (cb.checked) fonts.push({
          family: f.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9 _-]/g, " ").trim() || "Schrift",
          file: f
        });
        this.#commit({
          ...this.scene,
          fonts
        });
      });
      row.append(cb, document.createTextNode(used ? `${f} \u2192 \u201E${used.family}\u201C` : f));
      box.append(row);
    }
  }
  // ── Eigenschaften ──
  #drawProps() {
    const side = this.#side;
    side.innerHTML = "";
    const e = this.#selected();
    if (this.#selIds.length > 1) {
      this.#drawGroupProps(side);
      return;
    }
    if (!e) {
      side.append(document.createTextNode(tr("noSelection")));
      return;
    }
    const pp = document.createElement("div");
    pp.className = "pp";
    const head = (t) => {
      const h = document.createElement("h4");
      h.textContent = t;
      pp.append(h);
    };
    const row = (label, ...els) => {
      const l = document.createElement("label");
      l.textContent = label;
      const w = document.createElement("div");
      w.className = els.length > 1 ? "two" : "";
      w.append(...els);
      pp.append(l, w);
    };
    const patch = (p, live = false) => {
      if (live) this.#live(updateElement(this.scene, e.id, p));
      else this.#commit(updateElement(this.scene, e.id, p), false);
    };
    const text = (v, on) => {
      const i = document.createElement("input");
      i.value = v;
      i.addEventListener("change", () => on(i.value));
      return i;
    };
    const number = (v, on, step = 1) => {
      const i = document.createElement("input");
      i.type = "number";
      i.step = String(step);
      i.value = String(Math.round(v * 100) / 100);
      i.addEventListener("change", () => {
        const n = Number(i.value);
        if (Number.isFinite(n)) on(n);
      });
      return i;
    };
    const select = (v, opts, on) => {
      const s = document.createElement("select");
      for (const [val, label] of opts) {
        const o = document.createElement("option");
        o.value = val;
        o.textContent = label;
        s.append(o);
      }
      s.value = v;
      s.addEventListener("change", () => on(s.value));
      return s;
    };
    const color = (v, on) => {
      const c = document.createElement("input");
      c.type = "color";
      c.value = /^#[0-9a-fA-F]{6}$/.test(v ?? "") ? v : "#000000";
      c.addEventListener("change", () => on(c.value));
      const t = text(v ?? "", on);
      t.placeholder = "#rrggbb / {{farbe}}";
      return [
        c,
        t
      ];
    };
    head(tr(KIND_LABEL[e.kind]));
    row(tr("name"), text(e.name, (s) => patch({
      name: s
    })));
    row("X / Y", number(e.x, (n) => patch({
      x: Math.round(n)
    })), number(e.y, (n) => patch({
      y: Math.round(n)
    })));
    row("B / H", number(e.w, (n) => patch({
      w: Math.round(n)
    })), number(e.h, (n) => patch({
      h: Math.round(n)
    })));
    row(tr("rotation"), number(e.rotation, (n) => patch({
      rotation: n
    })));
    row(tr("opacity"), number(e.opacity, (n) => patch({
      opacity: n
    }), 0.05));
    const al = (how, l) => this.#btn(l, () => this.#commit(alignToScene(this.scene, e.id, how)));
    row(tr("align"), al("left", "\u21E4"), al("hcenter", "\u2194"), al("right", "\u21E5"));
    row("", al("top", "\u2912"), al("vcenter", "\u2195"), al("bottom", "\u2913"));
    if (e.kind === "text") {
      head(tr("kText"));
      const ta = document.createElement("textarea");
      ta.value = e.text ?? "";
      ta.addEventListener("change", () => patch({
        text: ta.value
      }));
      row(tr("content"), ta);
      const keys = this.#host.params().map((p) => p.key);
      if (keys.length) {
        row(tr("insertParam"), select("", [
          [
            "",
            "\u2026"
          ],
          ...keys.map((k) => [
            k,
            k
          ])
        ], (k) => {
          if (k) patch({
            text: `${e.text ?? ""}{{${k}}}`
          });
        }));
      }
      const own = (this.scene.fonts ?? []).map((f) => [
        `"${f.family}", system-ui, sans-serif`,
        f.family
      ]);
      row(tr("font"), select(e.font ?? "", [
        [
          "system-ui, sans-serif",
          "Sans"
        ],
        [
          "Georgia, serif",
          "Serif"
        ],
        [
          "ui-monospace, monospace",
          "Mono"
        ],
        [
          "Impact, sans-serif",
          "Impact"
        ],
        ...own
      ], (s) => patch({
        font: s
      })));
      row(tr("size"), number(e.size ?? 40, (n) => patch({
        size: n
      })), number(e.weight ?? 400, (n) => patch({
        weight: n
      }), 100));
      row(tr("color"), ...color(e.color, (s) => patch({
        color: s
      })));
      row(tr("hAlign"), select(e.align ?? "left", [
        [
          "left",
          "\u25C0"
        ],
        [
          "center",
          "\u25C6"
        ],
        [
          "right",
          "\u25B6"
        ]
      ], (s) => patch({
        align: s
      })), select(e.valign ?? "top", [
        [
          "top",
          "\u25B2"
        ],
        [
          "middle",
          "\u25C6"
        ],
        [
          "bottom",
          "\u25BC"
        ]
      ], (s) => patch({
        valign: s
      })));
      row(tr("lineHeight"), number(e.lineHeight ?? 1.2, (n) => patch({
        lineHeight: n
      }), 0.1), number(e.padding ?? 0, (n) => patch({
        padding: n
      })));
      row(tr("background"), ...color(e.bg, (s) => patch({
        bg: s
      })));
      const af = document.createElement("input");
      af.type = "checkbox";
      af.style.width = "auto";
      af.checked = !!e.autofit;
      af.addEventListener("change", () => patch({
        autofit: af.checked
      }));
      row(tr("autofit"), af, number(e.minSize ?? 12, (n) => patch({
        minSize: Math.max(4, n)
      })));
    } else if (e.kind === "rect") {
      head(tr("kRect"));
      row(tr("fill"), ...color(e.fill, (s) => patch({
        fill: s
      })));
      row(tr("radius"), number(e.radius ?? 0, (n) => patch({
        radius: n
      })));
      row(tr("stroke"), ...color(e.stroke, (s) => patch({
        stroke: s
      })));
      row(tr("strokeW"), number(e.strokeW ?? 0, (n) => patch({
        strokeW: n
      })));
    } else if (e.kind === "image") {
      head(tr("kImage"));
      const imgs = this.#host.images();
      row(tr("file"), select(e.file ?? "", [
        [
          "",
          "\u2013"
        ],
        ...imgs.map((f) => [
          f,
          f
        ])
      ], (s) => patch({
        file: s
      })));
      row(tr("fit"), select(e.fit ?? "contain", [
        [
          "contain",
          "contain"
        ],
        [
          "cover",
          "cover"
        ],
        [
          "fill",
          "fill"
        ]
      ], (s) => patch({
        fit: s
      })));
      row(tr("radius"), number(e.radius ?? 0, (n) => patch({
        radius: n
      })));
      if (!imgs.length) pp.append(document.createTextNode(tr("noImages")));
    } else {
      head(tr("kZone"));
      row(tr("zoneId"), text(e.zone ?? "", (s) => patch({
        zone: s.replace(/[^A-Za-z0-9_-]/g, "") || "zone"
      })));
      pp.append(document.createTextNode(tr("zoneHint")));
    }
    if ((this.scene.stepCount ?? 1) > 1) {
      head(tr("stepRange"));
      row(tr("fromTo"), number((e.from ?? 0) + 1, (n) => patch({
        from: Math.max(0, Math.round(n) - 1)
      })), number(e.to ?? -1, (n) => patch({
        to: n <= 0 ? -1 : Math.round(n) - 1
      })));
    }
    if (e.kind !== "zone") {
      for (const dir of [
        "in",
        "out"
      ]) {
        head(dir === "in" ? tr("animIn") : tr("animOut"));
        const a = e.anim?.[dir] ?? {
          type: "none",
          ms: 300,
          delay: 0,
          ease: "ease-out"
        };
        const set = (p) => patch({
          anim: {
            ...e.anim,
            [dir]: {
              ...a,
              ...p
            }
          }
        });
        row(tr("animType"), select(a.type, ANIM_TYPES.map((t) => [
          t,
          tr(`anim_${t}`)
        ]), (s) => set({
          type: s
        })));
        row(tr("animMs"), number(a.ms, (n) => set({
          ms: Math.max(0, n)
        }), 50), number(a.delay, (n) => set({
          delay: Math.max(0, n)
        }), 50));
        row(tr("animEase"), select(a.ease, [
          [
            "linear",
            "linear"
          ],
          [
            "ease-out",
            "ease-out"
          ],
          [
            "ease-in",
            "ease-in"
          ],
          [
            "ease-in-out",
            "ease-in-out"
          ]
        ], (s) => set({
          ease: s
        })));
      }
    }
    side.append(pp);
  }
  #drawGroupProps(side) {
    const info = document.createElement("div");
    info.textContent = tr("groupCount").replace("{n}", String(this.#selIds.length));
    const bar = document.createElement("div");
    bar.className = "tools";
    const al = (how, l, ttl) => this.#btn(l, () => this.#commit(alignGroup(this.scene, this.#selIds, how)), ttl);
    bar.append(al("left", "\u21E4", tr("alignLeft")), al("hcenter", "\u2194", tr("alignHCenter")), al("right", "\u21E5", tr("alignRight")), al("top", "\u2912", tr("alignTop")), al("vcenter", "\u2195", tr("alignVCenter")), al("bottom", "\u2913", tr("alignBottom")));
    const dist = document.createElement("div");
    dist.className = "tools";
    dist.append(this.#btn("\u21F9", () => this.#commit(distribute(this.scene, this.#selIds, "x")), tr("distributeX")), this.#btn("\u21F3", () => this.#commit(distribute(this.scene, this.#selIds, "y")), tr("distributeY")));
    side.append(info, bar, dist);
  }
  // ── Änderungen ──
  /** Änderung ohne Verlaufseintrag (während des Ziehens). */
  #live(s) {
    this.#hist.replaceCurrent(s);
    this.#host.onChange(s);
    this.#redrawStage();
  }
  #redrawStage() {
    this.#handle?.destroy();
    this.#handle = renderScene(this.#vp, this.scene, this.#host.data(), {
      editor: !this.#preview,
      step: this.#viewStep,
      scale: () => this.#scale,
      resolveAsset: (f) => this.#host.assetUrl(f)
    });
    this.#drawTimeline();
    this.#vp.insertBefore(this.#handle.stage, this.#ov);
    this.#drawOverlay();
  }
  #commit(s, full = true) {
    if (s === this.scene) return;
    this.#hist.push(s);
    this.#host.onChange(s);
    if (full) this.#redraw();
    else this.#redraw();
  }
  #add(kind) {
    const e = newElement(kind, this.scene);
    this.#selIds = [
      e.id
    ];
    this.#commit(addElement(this.scene, e));
    this.#vp.focus();
  }
  #del() {
    if (!this.#selIds.length) return;
    const ids = this.#selIds;
    this.#selIds = [];
    this.#commit(removeElements(this.scene, ids));
  }
  #dup() {
    if (!this.#selIds.length) return;
    const r = duplicateMany(this.scene, this.#selIds);
    this.#selIds = r.ids;
    this.#commit(r.scene);
  }
  #undo() {
    if (!this.#hist.canUndo) return;
    this.#hist.undo();
    this.#host.onChange(this.scene);
    this.#pick(this.#selIds);
    this.#redraw();
  }
  #redo() {
    if (!this.#hist.canRedo) return;
    this.#hist.redo();
    this.#host.onChange(this.scene);
    this.#redraw();
  }
  async #togglePreview() {
    if (!this.#preview) {
      this.#preview = true;
      this.#pvStep = 0;
      this.#redraw();
      await this.#handle?.ready;
      await this.#handle?.play(0);
      return;
    }
    const h = this.#handle;
    this.#preview = false;
    this.#drawTools();
    await h?.stop();
    this.#redraw();
  }
  async #pvNext() {
    const n = this.scene.stepCount ?? 1;
    this.#pvStep = Math.min(n - 1, this.#pvStep + 1);
    this.#drawTools();
    await this.#handle?.goto(this.#pvStep);
  }
  // ── Zeitleiste ──
  #drawTimeline() {
    const box = this.#tl;
    box.innerHTML = "";
    const s = this.scene;
    const dir = this.#tlDir;
    const end = timelineEnd(s, dir);
    const head = document.createElement("div");
    head.className = "hd2";
    head.append(this.#btn(tr("animIn"), () => {
      this.#tlDir = "in";
      this.#drawTimeline();
    }, "", dir === "in" ? "on" : ""), this.#btn(tr("animOut"), () => {
      this.#tlDir = "out";
      this.#drawTimeline();
    }, "", dir === "out" ? "on" : ""), document.createTextNode(`${tr("timeline")} \xB7 ${end} ms`));
    const scrub = document.createElement("input");
    scrub.type = "range";
    scrub.min = "0";
    scrub.max = String(end);
    scrub.step = "10";
    scrub.value = "0";
    scrub.title = tr("scrub");
    scrub.style.cssText = "flex:1;min-width:120px;padding:0";
    scrub.addEventListener("input", () => this.#handle?.scrub(dir, Number(scrub.value)));
    scrub.addEventListener("change", () => {
      scrub.value = "0";
      this.#redrawStage();
    });
    head.append(scrub);
    box.append(head);
    const ruler = document.createElement("div");
    ruler.className = "row";
    const rp = document.createElement("div");
    const rt = document.createElement("div");
    rt.className = "ruler";
    for (let t = 0; t <= end; t += end / 4) {
      const m = document.createElement("span");
      m.style.cssText = `position:absolute;left:${t / end * 100}%;transform:translateX(${t === end ? "-100%" : "0"})`;
      m.textContent = `${Math.round(t)}`;
      rt.append(m);
    }
    ruler.append(rp, rt);
    box.append(ruler);
    for (const e of [
      ...s.elements
    ].reverse()) {
      if (e.kind === "zone") continue;
      const a = e.anim?.[dir];
      const row = document.createElement("div");
      row.className = "row";
      const nm = document.createElement("div");
      nm.className = `nm${this.#selIds.includes(e.id) ? " on" : ""}`;
      nm.textContent = e.name;
      nm.title = e.name;
      nm.addEventListener("click", () => {
        this.#selIds = [
          e.id
        ];
        this.#redraw();
      });
      const track = document.createElement("div");
      track.className = "track";
      if (a && a.type !== "none") {
        const bar = document.createElement("div");
        bar.className = `bar ${dir}`;
        bar.style.left = `${a.delay / end * 100}%`;
        bar.style.width = `${Math.max(1, a.ms / end * 100)}%`;
        bar.title = `${tr(`anim_${a.type}`)} \xB7 ${a.delay} + ${a.ms} ms`;
        const grip = document.createElement("div");
        grip.className = "gr";
        bar.append(grip);
        bar.addEventListener("pointerdown", (ev) => {
          ev.preventDefault();
          this.#tdrag = {
            id: e.id,
            mode: ev.target === grip ? "size" : "move",
            sx: ev.clientX,
            base: this.scene,
            end,
            w: track.clientWidth || 1,
            changed: false
          };
          this.#selIds = [
            e.id
          ];
          bar.setPointerCapture(ev.pointerId);
        });
        bar.addEventListener("pointermove", (ev) => this.#tlMove(ev));
        bar.addEventListener("pointerup", () => this.#tlUp());
        bar.addEventListener("pointercancel", () => this.#tlUp());
        track.append(bar);
      } else {
        track.title = tr("noAnim");
        track.style.opacity = ".5";
        track.addEventListener("dblclick", () => this.#commit(setTiming(this.scene, e.id, dir, {
          ms: 400
        })));
      }
      row.append(nm, track);
      box.append(row);
    }
  }
  #tlMove(ev) {
    const d = this.#tdrag;
    if (!d) return;
    const dms = (ev.clientX - d.sx) / d.w * d.end;
    d.changed = d.changed || Math.abs(ev.clientX - d.sx) > 1;
    const dir = this.#tlDir;
    const cur = d.base.elements.find((e) => e.id === d.id)?.anim?.[dir];
    if (!cur) return;
    const next = d.mode === "move" ? setTiming(d.base, d.id, dir, {
      delay: cur.delay + dms
    }) : setTiming(d.base, d.id, dir, {
      ms: cur.ms + dms
    });
    this.#hist.replaceCurrent(next);
    this.#host.onChange(next);
    this.#drawTimeline();
  }
  #tlUp() {
    const d = this.#tdrag;
    this.#tdrag = null;
    if (!d) return;
    if (d.changed) {
      const final = this.scene;
      this.#hist.replaceCurrent(d.base);
      this.#hist.push(final);
      this.#host.onChange(final);
    }
    this.#redraw();
  }
  // ── Zeigereingaben ──
  #toScene(ev) {
    const r = this.#vp.getBoundingClientRect();
    return {
      x: (ev.clientX - r.left) / this.#scale,
      y: (ev.clientY - r.top) / this.#scale
    };
  }
  #down(ev) {
    if (this.#preview || ev.button !== 0) return;
    this.#vp.focus();
    const target = ev.target;
    const h = target.dataset?.handle;
    const p = this.#toScene(ev);
    let id = this.#selIds[0] ?? "";
    let mode = "move";
    if (h && this.#selected()) mode = h;
    else {
      const hit = hitTest(this.scene, p.x, p.y) ?? "";
      if (hit && ev.shiftKey) {
        this.#selIds = this.#selIds.includes(hit) ? this.#selIds.filter((x) => x !== hit) : [
          ...this.#selIds,
          hit
        ];
        id = hit;
      } else if (hit) {
        if (!this.#selIds.includes(hit)) this.#selIds = [
          hit
        ];
        id = hit;
      } else {
        if (!ev.shiftKey) this.#selIds = [];
        mode = "marquee";
        id = "";
      }
    }
    this.#drag = {
      mode,
      sx: ev.clientX,
      sy: ev.clientY,
      base: this.scene,
      id,
      changed: false,
      add: ev.shiftKey
    };
    try {
      this.#vp.setPointerCapture(ev.pointerId);
    } catch {
    }
    this.#drawOverlay();
    this.#drawLayers();
    this.#drawProps();
    this.#drawTools();
  }
  #move(ev) {
    const d = this.#drag;
    if (!d) return;
    const dx = (ev.clientX - d.sx) / this.#scale;
    const dy = (ev.clientY - d.sy) / this.#scale;
    d.changed = d.changed || Math.abs(dx) + Math.abs(dy) > 0.5;
    if (d.mode === "marquee") {
      const p0 = {
        x: (d.sx - this.#vp.getBoundingClientRect().left) / this.#scale,
        y: (d.sy - this.#vp.getBoundingClientRect().top) / this.#scale
      };
      this.#marquee = {
        x: Math.min(p0.x, p0.x + dx),
        y: Math.min(p0.y, p0.y + dy),
        w: Math.abs(dx),
        h: Math.abs(dy)
      };
      this.#drawOverlay();
      return;
    }
    if (d.mode === "move") {
      const ids = this.#selIds;
      const bb = boundsOf(d.base, ids);
      if (!bb) return;
      let box = {
        ...bb,
        x: bb.x + dx,
        y: bb.y + dy
      };
      this.#guides = [];
      if (this.#snap && !ev.altKey) {
        const sn = snapBox(box, d.base, ids, 8 / this.#scale);
        box = sn.box;
        this.#guides = sn.guides;
      }
      const mx = Math.round(box.x - bb.x), my = Math.round(box.y - bb.y);
      this.#hist.replaceCurrent(moveElements(d.base, ids, mx, my));
    } else {
      const base = d.base.elements.find((e) => e.id === d.id);
      if (!base) return;
      if (d.mode === "rot") {
        const p = this.#toScene(ev);
        this.#hist.replaceCurrent(updateElement(d.base, d.id, {
          rotation: angleFor(base, p.x, p.y, ev.shiftKey)
        }));
      } else {
        const b0 = {
          x: base.x,
          y: base.y,
          w: base.w,
          h: base.h
        };
        const box = base.rotation ? resizeRotated(b0, base.rotation, d.mode, dx, dy, ev.shiftKey) : resizeBox(b0, d.mode, dx, dy, ev.shiftKey);
        this.#hist.replaceCurrent(updateElement(d.base, d.id, box));
      }
    }
    this.#host.onChange(this.scene);
    this.#redrawStage();
  }
  #up(_ev) {
    const d = this.#drag;
    this.#drag = null;
    this.#guides = [];
    const m = this.#marquee;
    this.#marquee = null;
    if (!d) return;
    if (d.mode === "marquee") {
      if (m && (m.w > 3 || m.h > 3)) {
        const inside = elementsInRect(this.scene, m);
        this.#selIds = d.add ? [
          .../* @__PURE__ */ new Set([
            ...this.#selIds,
            ...inside
          ])
        ] : inside;
      }
      this.#redraw();
      return;
    }
    if (d.changed) {
      const final = this.scene;
      this.#hist.replaceCurrent(d.base);
      this.#hist.push(final);
      this.#host.onChange(final);
    }
    this.#redraw();
  }
  #key(ev) {
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && ev.key.toLowerCase() === "z") {
      ev.preventDefault();
      if (ev.shiftKey) this.#redo();
      else this.#undo();
    } else if (mod && ev.key.toLowerCase() === "y") {
      ev.preventDefault();
      this.#redo();
    } else if (mod && ev.key.toLowerCase() === "d") {
      ev.preventDefault();
      this.#dup();
    } else if (ev.key === "Delete" || ev.key === "Backspace") {
      ev.preventDefault();
      this.#del();
    } else if (mod && ev.key.toLowerCase() === "a") {
      ev.preventDefault();
      this.#selIds = this.scene.elements.map((e) => e.id);
      this.#redraw();
    } else if (this.#selIds.length && ev.key.startsWith("Arrow")) {
      ev.preventDefault();
      const n = ev.shiftKey ? 10 : 1;
      const [dx, dy] = {
        ArrowLeft: [
          -n,
          0
        ],
        ArrowRight: [
          n,
          0
        ],
        ArrowUp: [
          0,
          -n
        ],
        ArrowDown: [
          0,
          n
        ]
      }[ev.key] ?? [
        0,
        0
      ];
      this.#commit(moveElements(this.scene, this.#selIds, dx, dy));
    }
  }
};

// ui/modules/ograf-editor/layout-panel.ts
var L2 = (document.documentElement.lang || "de").startsWith("en") ? "en" : "de";
var tr2 = (k, p) => {
  let s = messages[L2][k] ?? messages.de[k] ?? k;
  for (const [a, b] of Object.entries(p ?? {})) s = s.split(`{${a}}`).join(b);
  return s;
};
function auth() {
  try {
    const t = localStorage.getItem("omp-auth-token");
    return t ? {
      Authorization: `Bearer ${t}`
    } : {};
  } catch {
    return {};
  }
}
async function get(path) {
  try {
    const r = await fetch(`/api/v1/${path}`, {
      headers: auth()
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
var STYLE2 = `
:host { display: block; font-size: 11px; }
* { box-sizing: border-box; }
.zone { border: 1px solid var(--omp-border, #2e3338); border-radius: 4px; padding: 6px; margin-bottom: 6px; display: flex; flex-direction: column; gap: 4px; }
.zone h4 { margin: 0; font-size: 12px; }
.row { display: grid; grid-template-columns: 80px 1fr; gap: 4px; align-items: center; }
.row label { color: var(--omp-text-dim, #9aa0a6); }
select, input { width: 100%; font: inherit; padding: 2px 4px; border-radius: 4px; background: var(--omp-bg-2, #1c1f22); color: var(--omp-text, #e8eaed); border: 1px solid var(--omp-border, #2e3338); }
button { cursor: pointer; font: inherit; padding: 3px 10px; border-radius: 4px; border: 1px solid var(--omp-border, #3a3f45); background: var(--omp-surface-raised, #2f3339); color: inherit; }
button.primary { background: var(--omp-info, #4285f4); border-color: var(--omp-info, #4285f4); color: #fff; }
.ok { color: #3fb950; } .bad { color: #ff7b72; } .dim { color: var(--omp-text-dim, #9aa0a6); }
`;
var OmpOgrafLayout = class extends HTMLElement {
  #nodeId = "";
  #timer = 0;
  #mixers = [];
  #sources = /* @__PURE__ */ new Map();
  /** Auswahl je Zone, bleibt über das Neuzeichnen erhalten. */
  #draft = /* @__PURE__ */ new Map();
  #busy = false;
  #last = "";
  connectedCallback() {
    this.#nodeId = this.getAttribute("node-id") ?? "";
    this.attachShadow({
      mode: "open"
    });
    void this.#tick();
    this.#timer = window.setInterval(() => void this.#tick(), 2e3);
  }
  disconnectedCallback() {
    window.clearInterval(this.#timer);
  }
  async #call(method, body) {
    const r = await fetch(`/api/v1/nodes/${this.#nodeId}/methods/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...auth()
      },
      body: JSON.stringify(body)
    });
    if (r.ok) return null;
    try {
      const j = await r.json();
      return String(j.error ?? j.message ?? r.status);
    } catch {
      return String(r.status);
    }
  }
  async #loadMixers() {
    const inst = await get("instances");
    const nodes = await get("nodes");
    if (!nodes) return;
    const labels = new Map(nodes.map((n) => [
      n.label,
      n.id
    ]));
    const mixers = (inst ?? []).filter((i) => i.type === "omp-video-mixer-me" && labels.has(i.label)).map((i) => ({
      nodeId: labels.get(i.label),
      label: i.label
    }));
    this.#mixers = mixers;
  }
  async #loadSources(m) {
    const v = await get(`nodes/${m.nodeId}/params/crosspoint.inputs`);
    const list = (v?.value ?? []).filter((e) => e.senderId && !/lowres/i.test(e.label)).map((e) => ({
      senderId: e.senderId,
      label: e.label
    }));
    this.#sources.set(m.label, [
      {
        senderId: "pst:1",
        label: tr2("srcPst")
      },
      ...list
    ]);
  }
  async #tick() {
    if (this.#busy || !this.isConnected) return;
    this.#busy = true;
    try {
      const zones = (await get(`nodes/${this.#nodeId}/params/zones`))?.value ?? {};
      const bindings = (await get(`nodes/${this.#nodeId}/params/layout`))?.value ?? [];
      if (!this.#mixers.length) await this.#loadMixers();
      const sig = JSON.stringify([
        zones,
        bindings
      ]);
      if (sig === this.#last && this.shadowRoot?.querySelector("select:focus,input:focus")) return;
      for (const m of this.#mixers) if (!this.#sources.has(m.label)) await this.#loadSources(m);
      this.#last = sig;
      this.#render(zones, bindings);
    } finally {
      this.#busy = false;
    }
  }
  #el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== void 0) e.textContent = text;
    return e;
  }
  #select(options, value, on) {
    const s = this.#el("select");
    for (const [v, l] of options) {
      const o = this.#el("option", "", l);
      o.value = v;
      s.append(o);
    }
    s.value = value;
    s.addEventListener("change", () => on(s.value));
    return s;
  }
  #render(zones, bindings) {
    const root = this.shadowRoot;
    if (root.querySelector("select:focus,input:focus")) return;
    root.innerHTML = "";
    const style = this.#el("style");
    style.textContent = STYLE2;
    root.append(style);
    const keys = /* @__PURE__ */ new Map();
    for (const [layer, zs] of Object.entries(zones)) for (const z of zs) keys.set(`${layer}/${z.id}`, {
      layer,
      zone: z.id
    });
    for (const b of bindings) keys.set(`${b.layerId}/${b.zone}`, {
      layer: b.layerId,
      zone: b.zone
    });
    if (!keys.size) {
      root.append(this.#el("div", "dim", tr2("layoutNone")));
      return;
    }
    for (const [key, { layer, zone }] of keys) {
      const bound = bindings.find((b) => b.layerId === layer && b.zone === zone);
      const live = (zones[layer] ?? []).some((z) => z.id === zone);
      const card = this.#el("div", "zone");
      card.append(this.#el("h4", "", `${layer} \xB7 ${zone}${live ? "" : ` (${tr2("layoutHidden")})`}`));
      if (bound) {
        const what = bound.kind === "window" ? tr2("kindWindow") : bound.kind === "follow" ? `${tr2("kindFollow")} ${bound.slot + 1}` : `${tr2("kindPip")} ${bound.slot + 1}`;
        card.append(this.#el("div", bound.error ? "bad" : "ok", `${what} \u2192 ${bound.mixer}${bound.kind === "window" || bound.kind === "follow" ? "" : ` \xB7 ${bound.senderId === "pst:1" ? tr2("srcPst") : (this.#sources.get(bound.mixer) ?? []).find((x) => x.senderId === bound.senderId)?.label ?? bound.senderId.slice(0, 8)}`}${bound.error ? ` \xB7 ${bound.error}` : bound.enabled ? ` \xB7 ${tr2("layoutOn")}` : ` \xB7 ${tr2("layoutOff")}`}${bound.lagMs !== void 0 && !bound.error ? ` \xB7 ${Math.round(bound.lagMs)} ms` : ""}`));
        const un = this.#el("button", "", tr2("layoutUnbind"));
        un.addEventListener("click", async () => {
          await this.#call("layout.unbind", {
            layerId: layer,
            zone
          });
          this.#last = "";
          void this.#tick();
        });
        card.append(un);
        root.append(card);
        continue;
      }
      const d = this.#draft.get(key) ?? {
        kind: "pip",
        mixer: this.#mixers[0]?.label ?? "",
        sender: "pst:1",
        slot: 0,
        level: 0
      };
      this.#draft.set(key, d);
      const row = (label, el) => {
        const r = this.#el("div", "row");
        r.append(this.#el("label", "", label), el);
        card.append(r);
      };
      row(tr2("kind"), this.#select([
        [
          "pip",
          tr2("kindPip")
        ],
        [
          "window",
          tr2("kindWindow")
        ],
        [
          "follow",
          tr2("kindFollow")
        ]
      ], d.kind, (v) => {
        d.kind = v;
        this.#last = "";
        this.#render(zones, bindings);
      }));
      if (!this.#mixers.length) card.append(this.#el("div", "bad", tr2("noMixer")));
      row(tr2("mixer"), this.#select(this.#mixers.map((m) => [
        m.label,
        m.label
      ]), d.mixer, (v) => {
        d.mixer = v;
        d.sender = "pst:1";
        this.#render(zones, bindings);
      }));
      if (d.kind === "pip" || d.kind === "follow") {
        if (d.kind === "pip") {
          const src = this.#sources.get(d.mixer) ?? [
            {
              senderId: "pst:1",
              label: tr2("srcPst")
            }
          ];
          row(tr2("source"), this.#select(src.map((s) => [
            s.senderId,
            s.label
          ]), d.sender, (v) => {
            d.sender = v;
          }));
        }
        const slot = this.#el("input");
        slot.type = "number";
        slot.min = "1";
        slot.value = String(d.slot + 1);
        slot.addEventListener("change", () => {
          d.slot = Math.max(0, (Number(slot.value) || 1) - 1);
        });
        row(tr2("slot"), slot);
      }
      const go = this.#el("button", "primary", tr2("layoutBind"));
      go.disabled = !this.#mixers.length || !live;
      go.title = live ? "" : tr2("layoutHiddenHint");
      go.addEventListener("click", async () => {
        const err = await this.#call("layout.bind", {
          layerId: layer,
          zone,
          mixer: d.mixer,
          kind: d.kind === "window" || d.kind === "follow" ? d.kind : "",
          senderId: d.kind === "pip" ? d.sender : "",
          slot: d.slot,
          level: d.level
        });
        if (err) card.append(this.#el("div", "bad", err));
        this.#last = "";
        void this.#tick();
      });
      card.append(go);
      root.append(card);
    }
  }
};
if (!customElements.get("omp-ograf-layout")) customElements.define("omp-ograf-layout", OmpOgrafLayout);

// ui/modules/ograf-editor/zip.ts
var TEXT_EXT = [
  "js",
  "mjs",
  "json",
  "css",
  "svg",
  "html",
  "txt"
];
var BINARY_EXT = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "woff",
  "woff2",
  "ttf"
];
var BINARY_PREFIX = "base64:";
var MAX_ENTRIES = 200;
var MAX_UNPACKED = 16 * 1024 * 1024;
var extOf = (n) => n.includes(".") ? n.slice(n.lastIndexOf(".") + 1).toLowerCase() : "";
var isBinaryName = (n) => BINARY_EXT.includes(extOf(n));
var isTextName = (n) => TEXT_EXT.includes(extOf(n));
var CRC = null;
function crc32(data) {
  if (!CRC) {
    CRC = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c2 = n;
      for (let k = 0; k < 8; k++) c2 = c2 & 1 ? 3988292384 ^ c2 >>> 1 : c2 >>> 1;
      CRC[n] = c2 >>> 0;
    }
  }
  let c = 4294967295;
  for (let i = 0; i < data.length; i++) c = CRC[(c ^ data[i]) & 255] ^ c >>> 8;
  return (c ^ 4294967295) >>> 0;
}
function bytesToBase64(b) {
  let s = "";
  for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768));
  return btoa(s);
}
function base64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function filesToBytes(files) {
  const out = {};
  for (const [n, c] of Object.entries(files)) {
    out[n] = isBinaryName(n) && c.startsWith(BINARY_PREFIX) ? base64ToBytes(c.slice(BINARY_PREFIX.length)) : new TextEncoder().encode(c);
  }
  return out;
}
function makeZip(entries) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const u16 = (v) => new Uint8Array([
    v & 255,
    v >> 8 & 255
  ]);
  const u32 = (v) => new Uint8Array([
    v & 255,
    v >> 8 & 255,
    v >> 16 & 255,
    v >>> 24 & 255
  ]);
  const cat = (...p) => {
    const o = new Uint8Array(p.reduce((a, b) => a + b.length, 0));
    let i = 0;
    for (const x of p) {
      o.set(x, i);
      i += x.length;
    }
    return o;
  };
  const DOS_TIME = 0, DOS_DATE = 1 << 5 | 1 | 2026 - 1980 << 9;
  for (const [name, data] of Object.entries(entries)) {
    const nm = enc.encode(name);
    const crc = crc32(data);
    const local = cat(u32(67324752), u16(20), u16(2048), u16(0), u16(DOS_TIME), u16(DOS_DATE), u32(crc), u32(data.length), u32(data.length), u16(nm.length), u16(0), nm, data);
    central.push(cat(u32(33639248), u16(20), u16(20), u16(2048), u16(0), u16(DOS_TIME), u16(DOS_DATE), u32(crc), u32(data.length), u32(data.length), u16(nm.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nm));
    chunks.push(local);
    offset += local.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const count = Object.keys(entries).length;
  return cat(...chunks, ...central, u32(101010256), u16(0), u16(0), u16(count), u16(count), u32(cdSize), u32(offset), u16(0));
}
async function inflate(raw) {
  const ds = new DecompressionStream("deflate-raw");
  const w = ds.writable.getWriter();
  void w.write(raw).then(() => w.close()).catch(() => {
  });
  const buf = await new Response(ds.readable).arrayBuffer();
  return new Uint8Array(buf);
}
async function readZip(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 101010256) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("kein ZIP-Archiv");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (count > MAX_ENTRIES) throw new Error("zu viele Eintr\xE4ge im Archiv");
  const dec = new TextDecoder();
  const raw = [];
  let unpacked = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > data.length || dv.getUint32(p, true) !== 33639248) throw new Error("Archiv besch\xE4digt");
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(data.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (name.endsWith("/")) continue;
    if (flags & 1) throw new Error("verschl\xFCsseltes Archiv wird nicht unterst\xFCtzt");
    if (csize === 4294967295 || usize === 4294967295) throw new Error("ZIP64 wird nicht unterst\xFCtzt");
    unpacked += usize;
    if (unpacked > MAX_UNPACKED) throw new Error("Archiv entpackt zu gro\xDF");
    if (lho + 30 > data.length || dv.getUint32(lho, true) !== 67324752) throw new Error("Archiv besch\xE4digt");
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const body = data.subarray(start, start + csize);
    if (body.length !== csize) throw new Error("Archiv besch\xE4digt");
    let out;
    if (method === 0) out = body;
    else if (method === 8) out = await inflate(body);
    else throw new Error(`Kompressionsmethode ${method} wird nicht unterst\xFCtzt`);
    if (out.length !== usize || crc32(out) !== crc) throw new Error(`Pr\xFCfsumme von \u201E${name}\u201C stimmt nicht`);
    raw.push({
      name,
      data: out
    });
  }
  const clean = raw.filter((r) => !r.name.startsWith("__MACOSX/"));
  const tops = new Set(clean.map((r) => r.name.includes("/") ? r.name.split("/")[0] : ""));
  const strip = tops.size === 1 && !tops.has("") ? `${[
    ...tops
  ][0]}/` : "";
  const files = {};
  const skipped = [];
  for (const r of clean) {
    const name = strip ? r.name.slice(strip.length) : r.name;
    const ok = name !== "" && !name.includes("/") && !name.startsWith(".") && /^[A-Za-z0-9._-]+$/.test(name) && (isTextName(name) || isBinaryName(name));
    if (ok) files[name] = r.data;
    else skipped.push(r.name);
  }
  return {
    files,
    skipped
  };
}
function bytesToFiles(entries) {
  const out = {};
  for (const [n, b] of Object.entries(entries)) {
    out[n] = isBinaryName(n) ? BINARY_PREFIX + bytesToBase64(b) : new TextDecoder().decode(b);
  }
  return out;
}

// ui/modules/ograf-editor/library.ts
var L3 = (document.documentElement.lang || "de").startsWith("en") ? "en" : "de";
var D = messages[L3];
var tr3 = (k, p) => {
  let s = D[k] ?? messages.de[k] ?? k;
  for (const [a, b] of Object.entries(p ?? {})) s = s.split(`{${a}}`).join(b);
  return s;
};
function authHeaders() {
  let tok = null;
  try {
    tok = localStorage.getItem("omp-auth-token");
  } catch {
  }
  return tok ? {
    Authorization: `Bearer ${tok}`
  } : {};
}
function confirmDialog(message) {
  return new Promise((resolve) => {
    if (!customElements.get("omp-confirm")) return resolve(false);
    const el = document.createElement("omp-confirm");
    el.textContent = message;
    el.addEventListener("resolve", (ev) => {
      resolve(ev.detail);
      el.remove();
    }, {
      once: true
    });
    document.body.appendChild(el);
  });
}
function promptDialog(message, initial = "") {
  return new Promise((resolve) => {
    if (!customElements.get("omp-prompt")) return resolve(null);
    const el = document.createElement("omp-prompt");
    el.textContent = message;
    if (initial) el.setAttribute("value", initial);
    el.addEventListener("resolve", (ev) => {
      resolve(ev.detail);
      el.remove();
    }, {
      once: true
    });
    document.body.appendChild(el);
  });
}
var isBinaryOrSvg = (n) => isBinaryName(n) || n.toLowerCase().endsWith(".svg");
var KIND_LABEL2 = {
  text: "kText",
  multiline: "kMulti",
  number: "kNumber",
  bool: "kBool",
  color: "kColor",
  choice: "kChoice",
  raw: "kRaw"
};
var STYLE3 = `
:host { display: block; font-family: var(--omp-font, system-ui, sans-serif); color: var(--omp-text, #e8eaed); font-size: var(--omp-font-size-sm, 12px); }
* { box-sizing: border-box; }
.wrap { display: grid; grid-template-columns: 220px 1fr; gap: 10px; min-height: 420px; }
.side { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.list { display: flex; flex-direction: column; gap: 2px; overflow: auto; max-height: 60vh; border: 1px solid var(--omp-border, #2e3338); border-radius: 4px; }
.item { display: flex; align-items: center; gap: 6px; padding: 5px 8px; cursor: pointer; border: 0; background: transparent; color: inherit; text-align: left; font: inherit; }
.item:hover { background: var(--omp-bg-2, #1c1f22); }
.item.sel { background: var(--omp-info, #4285f4); color: #fff; }
.item .lbl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; flex: none; }
.dot.bad { background: #f85149; }
.bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
button.b, label.b { cursor: pointer; font: inherit; padding: 4px 10px; border-radius: 4px; border: 1px solid var(--omp-border, #3a3f45); background: var(--omp-surface-raised, #2f3339); color: inherit; }
button.b:hover { filter: brightness(1.15); }
button.b.primary { background: var(--omp-info, #4285f4); border-color: var(--omp-info, #4285f4); color: #fff; }
button.b:disabled { opacity: .45; cursor: default; }
.main { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.head h3 { margin: 0; font-size: 14px; }
.pill { font-size: 11px; padding: 1px 8px; border-radius: 10px; background: #1f6f3a; }
.pill.bad { background: #8b2a26; }
.dirty { color: #e3b341; font-size: 11px; }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--omp-border, #2e3338); }
.tab { cursor: pointer; padding: 5px 12px; border: 0; background: transparent; color: var(--omp-text-dim, #9aa0a6); font: inherit; border-bottom: 2px solid transparent; }
.tab.on { color: var(--omp-text, #e8eaed); border-bottom-color: var(--omp-info, #4285f4); }
.form { display: grid; grid-template-columns: 200px 1fr; gap: 6px 10px; align-items: center; max-width: 720px; }
.form label.k { color: var(--omp-text-dim, #9aa0a6); }
input[type=text], input[type=number], textarea, select { width: 100%; font: inherit; padding: 3px 6px; border-radius: 4px; background: var(--omp-bg-2, #1c1f22); color: var(--omp-text, #e8eaed); border: 1px solid var(--omp-border, #2e3338); }
textarea { font-family: var(--omp-mono, monospace); min-height: 300px; resize: vertical; white-space: pre; tab-size: 2; }
.row2 { display: flex; gap: 6px; }
.msgs { margin: 0; padding-left: 18px; }
.msgs.err { color: #ff7b72; }
.msgs.warn { color: #e3b341; }
.fields { display: flex; flex-direction: column; gap: 6px; }
.field { display: grid; grid-template-columns: 130px 150px 110px 1fr 70px auto; gap: 6px; align-items: center; padding: 6px; border: 1px solid var(--omp-border, #2e3338); border-radius: 4px; }
.field .ch { grid-column: 1 / -1; }
.status { min-height: 16px; color: var(--omp-text-dim, #9aa0a6); }
.status.bad { color: #ff7b72; }
.fileBar { display: flex; gap: 6px; align-items: center; }
.fileBar select { width: auto; min-width: 200px; }
`;
var OmpOgrafLibrary = class extends HTMLElement {
  #nodeId = "";
  #root;
  #list = [];
  #selected = "";
  #files = {};
  #orig = "";
  #origId = "";
  #serverErrors = [];
  #serverWarnings = [];
  #tab = "general";
  #fields = [];
  #sourceFile = "";
  #filter = "";
  #canvas = null;
  #status = "";
  #statusBad = false;
  connectedCallback() {
    this.#nodeId = this.getAttribute("node-id") ?? "";
    this.#root = this.shadowRoot ?? this.attachShadow({
      mode: "open"
    });
    void this.#loadList().then(() => this.#render());
  }
  // ── Zugriff auf den Node ──
  async #param(name) {
    const r = await fetch(`/api/v1/nodes/${this.#nodeId}/params/${name}`, {
      headers: authHeaders()
    });
    if (!r.ok) throw new Error(`${r.status}`);
    return (await r.json()).value;
  }
  async #call(method, body) {
    const r = await fetch(`/api/v1/nodes/${this.#nodeId}/methods/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders()
      },
      body: JSON.stringify(body)
    });
    if (r.ok) return null;
    try {
      const j = await r.json();
      return String(j.error ?? j.message ?? r.status);
    } catch {
      return String(r.status);
    }
  }
  async #loadList() {
    try {
      this.#list = await this.#param("library");
    } catch {
      this.#list = [];
      this.#say(tr3("loadFailed"), true);
    }
  }
  async #open(id) {
    if (this.#dirty() && !await confirmDialog(tr3("leaveDirty"))) return;
    try {
      const pkg = await this.#param(`library.${id}`);
      this.#selected = id;
      this.#files = {
        ...pkg.files
      };
      this.#serverErrors = pkg.errors;
      this.#serverWarnings = pkg.warnings;
      this.#origId = id;
      this.#canvas?.destroy();
      this.#canvas = null;
      this.#tab = isDesigner(this.#files) ? "canvas" : this.#tab === "canvas" ? "general" : this.#tab;
      this.#orig = JSON.stringify(this.#files);
      this.#syncFields();
      this.#sourceFile = Object.keys(this.#files).find((n) => !n.endsWith(".ograf.json")) ?? "";
      this.#say("", false);
    } catch {
      this.#say(tr3("loadFailed"), true);
    }
    this.#render();
  }
  #dirty() {
    return this.#selected !== "" && JSON.stringify(this.#files) !== this.#orig;
  }
  #say(msg, bad) {
    this.#status = msg;
    this.#statusBad = bad;
    const el = this.#root?.querySelector(".status");
    if (el) {
      el.textContent = msg;
      el.classList.toggle("bad", bad);
    }
  }
  #syncFields() {
    const m = parseManifest(this.#files);
    this.#fields = fieldsFromSchema(m?.schema);
  }
  /** Feldliste und Formular in `files` zurückschreiben (Manifest ist die einzige Quelle der Wahrheit). */
  #writeManifest(mutate) {
    const name = manifestFileName(this.#files);
    const m = parseManifest(this.#files);
    if (!name || !m) return;
    this.#files = {
      ...this.#files,
      [name]: stringify(mutate(m))
    };
    this.#markDirty();
  }
  #markDirty() {
    const d = this.#dirty();
    const dot = this.#root.querySelector(".dirty");
    if (dot) dot.style.display = d ? "" : "none";
    const save = this.#root.querySelector("button.save");
    if (save) save.disabled = !d;
  }
  // ── Aktionen ──
  async #newTemplate(designer = false) {
    const name = await promptDialog(tr3("askName"));
    if (!name?.trim()) return;
    const id = nextFreeId(name, this.#list.map((e) => e.id));
    const err = designer ? await this.#call("library.save", {
      id,
      files: newDesignerPackage(id, name.trim(), runtime_default)
    }) : await this.#call("library.new", {
      id,
      name: name.trim()
    });
    if (err) return this.#say(tr3("saveFailed", {
      why: err
    }), true);
    await this.#loadList();
    await this.#open(id);
  }
  /** Sendetest: die gespeicherte Vorlage auf dem Grafik-Node einblenden, weiterschalten oder ausblenden. */
  async #test(what) {
    if (!this.#selected) return;
    if (what === "show" && this.#dirty()) return this.#say(tr3("saveFirst"), true);
    const body = {
      layerId: "editor-test"
    };
    if (what === "show") {
      body.templateId = this.#selected;
      body.data = defaultsOf(this.#fields);
    }
    const err = await this.#call(what, body);
    this.#say(err ? tr3("testFailed", {
      why: err
    }) : "", !!err);
  }
  async #duplicate() {
    if (!this.#selected) return;
    const name = await promptDialog(tr3("askCopyName"), `${this.#selected}-kopie`);
    if (!name?.trim()) return;
    const id = nextFreeId(name, this.#list.map((e) => e.id));
    const err = await this.#call("library.duplicate", {
      id: this.#selected,
      newId: id
    });
    if (err) return this.#say(tr3("saveFailed", {
      why: err
    }), true);
    await this.#loadList();
    await this.#open(id);
  }
  async #delete() {
    if (!this.#selected || !await confirmDialog(tr3("askDelete", {
      id: this.#selected
    }))) return;
    const err = await this.#call("library.delete", {
      id: this.#selected
    });
    if (err) return this.#say(tr3("saveFailed", {
      why: err
    }), true);
    this.#selected = "";
    this.#files = {};
    this.#orig = "";
    await this.#loadList();
    this.#render();
  }
  async #save() {
    const bad = validateFields(this.#fields);
    if (bad.length) return this.#say(bad.join("; "), true);
    const err = await this.#call("library.save", {
      id: this.#selected,
      files: this.#files
    });
    if (err) return this.#say(tr3("saveFailed", {
      why: err
    }), true);
    const id = this.#selected;
    await this.#loadList();
    this.#orig = "";
    this.#selected = "";
    await this.#open(id);
    this.#say(tr3("saved"), false);
  }
  #export() {
    if (!this.#selected) return;
    const zip = makeZip(filesToBytes(this.#files));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([
      zip
    ], {
      type: "application/zip"
    }));
    a.download = `${this.#selected}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2e3);
  }
  async #rename() {
    if (!this.#selected) return;
    if (this.#dirty() && !await confirmDialog(tr3("leaveDirty"))) return;
    const old = this.#selected;
    const wanted = await promptDialog(tr3("askRename", {
      id: old
    }), old);
    const id = slugify(wanted ?? "");
    if (!id || id === old) return;
    if (this.#list.some((e) => e.id === id)) return this.#say(tr3("renameFailed", {
      why: id
    }), true);
    const files = renamePackage(this.#files, old, id);
    let err = await this.#call("library.save", {
      id,
      files
    });
    if (err) return this.#say(tr3("renameFailed", {
      why: err
    }), true);
    err = await this.#call("library.delete", {
      id: old
    });
    if (err) this.#say(tr3("renameFailed", {
      why: err
    }), true);
    this.#orig = "";
    this.#selected = "";
    await this.#loadList();
    await this.#open(id);
  }
  async #import(file) {
    let id = "";
    let files = {};
    let skipped = [];
    if (file.name.toLowerCase().endsWith(".zip")) {
      try {
        const z = await readZip(new Uint8Array(await file.arrayBuffer()));
        files = bytesToFiles(z.files);
        skipped = z.skipped;
      } catch (e) {
        return this.#say(tr3("importFailed", {
          why: e.message
        }), true);
      }
      const m = parseManifest(files);
      if (!m) return this.#say(tr3("importFailed", {
        why: "Manifest (*.ograf.json) fehlt oder ist kein JSON"
      }), true);
      id = typeof m.id === "string" && slugify(m.id) === m.id ? m.id : slugify(String(m.name ?? file.name.replace(/\.zip$/i, "")));
      if (!id) return this.#say(tr3("importFailed", {
        why: "id"
      }), true);
      const had = typeof m.id === "string" ? m.id : id;
      if (had !== id || manifestFileName(files) !== `${id}.ograf.json`) files = renamePackage(files, manifestFileName(files).replace(/\.ograf\.json$/, ""), id);
    } else {
      const r = importPackage(await file.text());
      if ("error" in r) return this.#say(tr3("importFailed", {
        why: r.error
      }), true);
      ({ id, files } = r);
    }
    const taken = this.#list.map((e) => e.id);
    if (taken.includes(id)) {
      const newId = nextFreeId(id, taken);
      if (!await confirmDialog(tr3("importExists", {
        id,
        newId
      }))) return;
      files = renamePackage(files, id, newId);
      id = newId;
    }
    const err = await this.#call("library.save", {
      id,
      files
    });
    if (err) return this.#say(tr3("importFailed", {
      why: err
    }), true);
    await this.#loadList();
    await this.#open(id);
    if (skipped.length) this.#say(tr3("importSkipped", {
      list: skipped.join(", ")
    }), false);
  }
  // ── Darstellung ──
  #el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== void 0) e.textContent = text;
    return e;
  }
  #tip(el, title) {
    el.title = title;
    return el;
  }
  #btn(label, onClick, cls = "", disabled = false) {
    const b = this.#el("button", `b ${cls}`.trim(), label);
    b.type = "button";
    b.disabled = disabled;
    b.addEventListener("click", onClick);
    return b;
  }
  #render() {
    const root = this.#root;
    root.innerHTML = "";
    const style = this.#el("style");
    style.textContent = STYLE3;
    const wrap = this.#el("div", "wrap");
    wrap.append(this.#renderSide(), this.#renderMain());
    root.append(style, wrap);
  }
  #renderSide() {
    const side = this.#el("div", "side");
    const bar = this.#el("div", "bar");
    const imp = this.#el("label", "b", tr3("importBtn"));
    const input = this.#el("input");
    input.type = "file";
    input.accept = ".zip,.json,application/zip,application/json";
    input.style.display = "none";
    input.addEventListener("change", () => {
      const f = input.files?.[0];
      input.value = "";
      if (f) void this.#import(f);
    });
    imp.append(input);
    bar.append(this.#btn(tr3("newTpl"), () => void this.#newTemplate(), "primary"), this.#btn(tr3("newDesigner"), () => void this.#newTemplate(true), "primary"), imp);
    const search = this.#el("input");
    search.type = "text";
    search.placeholder = tr3("search");
    search.value = this.#filter;
    search.addEventListener("input", () => {
      this.#filter = search.value;
      const pos = search.selectionStart;
      this.#render();
      const again = this.#root.querySelector(".side input[type=text]");
      again?.focus();
      again?.setSelectionRange(pos, pos);
    });
    const list = this.#el("div", "list");
    const q = this.#filter.trim().toLowerCase();
    const shown = this.#list.filter((e) => !q || e.label.toLowerCase().includes(q) || e.id.includes(q));
    if (!this.#list.length) list.append(this.#el("div", "status", tr3("empty")));
    else if (!shown.length) list.append(this.#el("div", "status", tr3("noMatch")));
    for (const e of shown) {
      const it = this.#el("button", `item${e.id === this.#selected ? " sel" : ""}`);
      it.type = "button";
      it.title = e.errors.join("\n") || e.id;
      const dot = this.#el("span", `dot${e.valid ? "" : " bad"}`);
      it.append(dot, this.#el("span", "lbl", e.label));
      it.addEventListener("click", () => void this.#open(e.id));
      list.append(it);
    }
    side.append(bar, search, list);
    return side;
  }
  #renderMain() {
    const main = this.#el("div", "main");
    if (!this.#selected) {
      main.append(this.#el("div", "status", tr3("none")), this.#statusEl());
      return main;
    }
    const m = parseManifest(this.#files);
    const head = this.#el("div", "head");
    const valid = this.#serverErrors.length === 0;
    head.append(this.#el("h3", "", String(m?.name ?? this.#selected)), this.#el("span", `pill${valid ? "" : " bad"}`, valid ? tr3("valid") : tr3("invalid")));
    const dirty = this.#el("span", "dirty", tr3("dirty"));
    dirty.style.display = this.#dirty() ? "" : "none";
    head.append(dirty);
    const spacer = this.#el("span");
    spacer.style.flex = "1";
    const save = this.#btn(tr3("save"), () => void this.#save(), "primary save", !this.#dirty());
    head.append(spacer, this.#tip(this.#btn(tr3("testShow"), () => void this.#test("show")), tr3("testHint")), this.#tip(this.#btn(tr3("testNext"), () => void this.#test("continue")), tr3("testNextHint")), this.#tip(this.#btn(tr3("testOff"), () => void this.#test("hide")), tr3("testOffHint")), this.#btn(tr3("duplicate"), () => void this.#duplicate()), this.#btn(tr3("rename"), () => void this.#rename()), this.#btn(tr3("exportBtn"), () => this.#export()), this.#btn(tr3("delete"), () => void this.#delete()), this.#btn(tr3("revert"), () => this.#revert(), "", false), save);
    main.append(head);
    if (this.#serverErrors.length) main.append(this.#list_("err", tr3("errors"), this.#serverErrors));
    if (this.#serverWarnings.length) main.append(this.#list_("warn", tr3("warnings"), this.#serverWarnings));
    const tabs = this.#el("div", "tabs");
    const tabList = [
      [
        "general",
        tr3("tabGeneral")
      ],
      [
        "params",
        tr3("tabParams")
      ],
      [
        "source",
        tr3("tabSource")
      ]
    ];
    if (isDesigner(this.#files)) tabList.unshift([
      "canvas",
      tr3("tabCanvas")
    ]);
    for (const [id, label] of tabList) {
      const t = this.#el("button", `tab${this.#tab === id ? " on" : ""}`, label);
      t.type = "button";
      t.addEventListener("click", () => {
        if (this.#tab === "source") this.#syncFields();
        this.#tab = id;
        this.#render();
      });
      tabs.append(t);
    }
    main.append(tabs);
    if (!m && this.#tab !== "source") main.append(this.#el("div", "status bad", tr3("manifestBroken")));
    else if (this.#tab === "canvas" && isDesigner(this.#files)) main.append(this.#renderCanvas());
    else if (this.#tab === "general") main.append(this.#renderGeneral(m));
    else if (this.#tab === "params") main.append(this.#renderParams());
    else main.append(this.#renderSource());
    main.append(this.#statusEl());
    return main;
  }
  #revert() {
    if (!this.#dirty()) return;
    this.#files = JSON.parse(this.#orig);
    this.#syncFields();
    const sc = this.#files["scene.json"] ? parseScene(this.#files["scene.json"]) : null;
    if (sc) this.#canvas?.setScene(sc);
    this.#render();
  }
  #statusEl() {
    return this.#el("div", `status${this.#statusBad ? " bad" : ""}`, this.#status);
  }
  #list_(cls, title, items) {
    const box = this.#el("div");
    box.append(this.#el("strong", "", `${title}:`));
    const ul = this.#el("ul", `msgs ${cls}`);
    for (const i of items) ul.append(this.#el("li", "", i));
    box.append(ul);
    return box;
  }
  #input(value, type, onInput, readonly = false) {
    const i = this.#el("input");
    i.type = type;
    i.value = String(value);
    i.readOnly = readonly;
    i.addEventListener("input", () => onInput(i.value));
    return i;
  }
  #check(value, onChange) {
    const i = this.#el("input");
    i.type = "checkbox";
    i.checked = value;
    i.addEventListener("change", () => onChange(i.checked));
    return i;
  }
  #renderGeneral(m) {
    const f = formFromManifest(m);
    const form = this.#el("div", "form");
    const upd = (patch) => {
      Object.assign(f, patch);
      this.#writeManifest((prev) => applyForm(prev, f, this.#selected));
    };
    const row = (label, el) => form.append(this.#el("label", "k", label), el);
    row(tr3("name"), this.#input(f.name, "text", (v) => upd({
      name: v
    })));
    row(tr3("id"), this.#input(this.#selected, "text", () => {
    }, true));
    row(tr3("version"), this.#input(f.version, "text", (v) => upd({
      version: v
    })));
    const desc = this.#el("textarea");
    desc.style.minHeight = "60px";
    desc.style.whiteSpace = "pre-wrap";
    desc.value = f.description;
    desc.addEventListener("input", () => upd({
      description: desc.value
    }));
    row(tr3("description"), desc);
    row(tr3("author"), this.#input(f.authorName, "text", (v) => upd({
      authorName: v
    })));
    row(tr3("authorEmail"), this.#input(f.authorEmail, "text", (v) => upd({
      authorEmail: v
    })));
    row(tr3("authorUrl"), this.#input(f.authorUrl, "text", (v) => upd({
      authorUrl: v
    })));
    row(tr3("steps"), this.#input(f.stepCount, "number", (v) => upd({
      stepCount: Number(v) || 1
    })));
    row(tr3("realtime"), this.#check(f.supportsRealTime, (v) => upd({
      supportsRealTime: v
    })));
    row(tr3("nonRealtime"), this.#check(f.supportsNonRealTime, (v) => upd({
      supportsNonRealTime: v
    })));
    const res = this.#el("div", "row2");
    res.append(this.#input(f.width, "number", (v) => upd({
      width: Number(v) || 0
    })), this.#input(f.height, "number", (v) => upd({
      height: Number(v) || 0
    })));
    row(tr3("resolution"), res);
    row(tr3("frameRate"), this.#input(f.frameRate, "number", (v) => upd({
      frameRate: Number(v) || 0
    })));
    const thumb = this.#el("select");
    for (const n of [
      "",
      ...Object.keys(this.#files).filter((n2) => /\.(png|jpe?g|webp|gif)$/i.test(n2))
    ]) {
      const o = this.#el("option", "", n || tr3("noThumb"));
      o.value = n;
      thumb.append(o);
    }
    thumb.value = f.thumbnail;
    thumb.addEventListener("change", () => upd({
      thumbnail: thumb.value
    }));
    row(tr3("thumbnail"), thumb);
    return form;
  }
  #writeFields() {
    this.#writeManifest((m) => ({
      ...m,
      schema: schemaFromFields(this.#fields, m.schema)
    }));
  }
  #renderParams() {
    const box = this.#el("div", "fields");
    const kinds = FIELD_KINDS;
    this.#fields.forEach((fd, i) => {
      const row = this.#el("div", "field");
      row.append(this.#input(fd.key, "text", (v) => {
        fd.key = v;
        this.#writeFields();
      }), this.#input(fd.title, "text", (v) => {
        fd.title = v;
        this.#writeFields();
      }));
      if (fd.kind === "raw") {
        const note = this.#el("span", "status", tr3("rawField"));
        note.style.gridColumn = "3 / 5";
        row.append(note);
        const ctl0 = this.#el("span", "bar");
        ctl0.append(this.#btn("\u25B2", () => this.#move(i, -1), "", i === 0), this.#btn("\u25BC", () => this.#move(i, 1), "", i === this.#fields.length - 1), this.#btn("\u2715", () => {
          this.#fields.splice(i, 1);
          this.#writeFields();
          this.#render();
        }));
        row.append(this.#el("span"), ctl0);
        box.append(row);
        return;
      }
      const sel = this.#el("select");
      for (const k of kinds) {
        const o = this.#el("option", "", tr3(KIND_LABEL2[k]));
        o.value = k;
        sel.append(o);
      }
      sel.value = fd.kind;
      sel.addEventListener("change", () => {
        fd.kind = sel.value;
        this.#writeFields();
        this.#render();
      });
      row.append(sel, this.#defaultInput(fd));
      const req = this.#el("label");
      req.append(this.#check(fd.required, (v) => {
        fd.required = v;
        this.#writeFields();
      }), document.createTextNode(` ${tr3("required")}`));
      const ctl = this.#el("span", "bar");
      ctl.append(this.#btn("\u25B2", () => this.#move(i, -1), "", i === 0), this.#btn("\u25BC", () => this.#move(i, 1), "", i === this.#fields.length - 1), this.#btn("\u2715", () => {
        this.#fields.splice(i, 1);
        this.#writeFields();
        this.#render();
      }));
      ctl.title = `${tr3("up")} / ${tr3("down")} / ${tr3("remove")}`;
      row.append(req, ctl);
      if (fd.kind === "choice") {
        const ch = this.#el("div", "ch");
        ch.append(this.#el("span", "", `${tr3("choices")}: `));
        ch.append(this.#input(fd.choices.join(", "), "text", (v) => {
          fd.choices = v.split(",").map((s) => s.trim()).filter(Boolean);
          this.#writeFields();
        }));
        row.append(ch);
      }
      box.append(row);
    });
    const issues = validateFields(this.#fields);
    if (issues.length) box.append(this.#list_("err", tr3("errors"), issues));
    box.append(this.#btn(tr3("addField"), () => {
      let n = 1;
      while (this.#fields.some((f) => f.key === `feld${n}`)) n++;
      this.#fields.push({
        key: `feld${n}`,
        title: "",
        kind: "text",
        def: "",
        choices: [],
        required: false,
        extra: {}
      });
      this.#writeFields();
      this.#render();
    }));
    return box;
  }
  #defaultInput(fd) {
    if (fd.kind === "bool") {
      const s = this.#el("select");
      for (const [v, l] of [
        [
          "",
          "\u2013"
        ],
        [
          "true",
          tr3("kBool") + ": \u2713"
        ],
        [
          "false",
          tr3("kBool") + ": \u2717"
        ]
      ]) {
        const o = this.#el("option", "", l);
        o.value = v;
        s.append(o);
      }
      s.value = fd.def;
      s.addEventListener("change", () => {
        fd.def = s.value;
        this.#writeFields();
      });
      return s;
    }
    if (fd.kind === "color") {
      const c = this.#el("input");
      c.type = "color";
      c.value = /^#[0-9a-fA-F]{6}$/.test(fd.def) ? fd.def : "#000000";
      c.addEventListener("input", () => {
        fd.def = c.value;
        this.#writeFields();
      });
      return c;
    }
    return this.#input(fd.def, fd.kind === "number" ? "number" : "text", (v) => {
      fd.def = v;
      this.#writeFields();
    });
  }
  #move(i, d) {
    const j = i + d;
    if (j < 0 || j >= this.#fields.length) return;
    [this.#fields[i], this.#fields[j]] = [
      this.#fields[j],
      this.#fields[i]
    ];
    this.#writeFields();
    this.#render();
  }
  #renderCanvas() {
    const scene = parseScene(this.#files["scene.json"] ?? "");
    if (!scene) return this.#el("div", "status bad", tr3("manifestBroken"));
    if (!this.#canvas) {
      this.#canvas = new CanvasEditor({
        scene,
        images: () => Object.keys(this.#files).filter(isBinaryOrSvg),
        files: () => Object.keys(this.#files),
        assetUrl: (n) => this.#assetUrl(n),
        fonts: () => Object.keys(this.#files).filter((n) => /\.(woff2?|ttf)$/i.test(n)),
        params: () => this.#fields.map((f) => ({
          key: f.key,
          kind: f.kind
        })),
        data: () => defaultsOf(this.#fields),
        onChange: (sc) => this.#onScene(sc)
      });
    } else queueMicrotask(() => this.#canvas?.refresh());
    return this.#canvas.el;
  }
  #assetUrl(name) {
    const c = this.#files[name] ?? "";
    const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    if (c.startsWith("base64:")) {
      const mime = [
        "woff",
        "woff2",
        "ttf"
      ].includes(ext) ? `font/${ext}` : `image/${ext === "jpg" ? "jpeg" : ext}`;
      return `data:${mime};base64,${c.slice(7)}`;
    }
    if (ext === "svg") return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(c)}`;
    return "";
  }
  /** Szene → Paketdateien (`scene.json`, erzeugtes Hauptmodul) und fehlende Parameter im Manifest-Schema. */
  #onScene(sc) {
    this.#files = applyScene(this.#files, this.#selected, sc, runtime_default);
    const next = ensureParams(this.#fields, sc);
    if (next.length !== this.#fields.length) {
      this.#fields = next;
      this.#writeFields();
    } else this.#markDirty();
  }
  #renderSource() {
    const box = this.#el("div", "fields");
    const bar = this.#el("div", "fileBar");
    const sel = this.#el("select");
    for (const n of Object.keys(this.#files)) {
      const o = this.#el("option", "", n);
      o.value = n;
      sel.append(o);
    }
    if (!this.#files[this.#sourceFile]) this.#sourceFile = Object.keys(this.#files)[0] ?? "";
    sel.value = this.#sourceFile;
    sel.addEventListener("change", () => {
      this.#sourceFile = sel.value;
      this.#render();
    });
    const isManifest = this.#sourceFile.endsWith(".ograf.json");
    bar.append(this.#el("span", "", `${tr3("file")}:`), sel, this.#btn(tr3("addFile"), () => void this.#addFile()), this.#btn(tr3("delFile"), () => {
      const n = this.#sourceFile;
      const { [n]: _gone, ...rest } = this.#files;
      this.#files = rest;
      this.#sourceFile = "";
      this.#markDirty();
      this.#render();
    }, "", isManifest));
    const upload = this.#el("label", "b", tr3("upload"));
    const up = this.#el("input");
    up.type = "file";
    up.style.display = "none";
    up.addEventListener("change", () => {
      const f = up.files?.[0];
      up.value = "";
      if (f) void this.#uploadFile(f);
    });
    upload.append(up);
    bar.append(upload);
    if (isBinaryName(this.#sourceFile)) {
      const content = this.#files[this.#sourceFile] ?? "";
      const info = this.#el("div", "fields");
      info.append(this.#el("div", "status", tr3("binaryInfo", {
        kb: String(Math.round(content.length * 3 / 4 / 1024))
      })));
      const ext = this.#sourceFile.slice(this.#sourceFile.lastIndexOf(".") + 1).toLowerCase();
      if ([
        "png",
        "jpg",
        "jpeg",
        "webp",
        "gif"
      ].includes(ext)) {
        const img = this.#el("img");
        img.src = `data:image/${ext === "jpg" ? "jpeg" : ext};base64,${content.replace(/^base64:/, "")}`;
        img.style.cssText = "max-width:420px;max-height:260px;background:#444;border-radius:4px;align-self:flex-start";
        info.append(img);
      }
      box.append(bar, info);
      return box;
    }
    const ta = this.#el("textarea");
    ta.spellcheck = false;
    ta.value = this.#files[this.#sourceFile] ?? "";
    if (isDesigner(this.#files) && (this.#sourceFile === `${this.#selected}.js` || this.#sourceFile === "scene.json")) {
      ta.readOnly = true;
      box.append(this.#el("div", "status", tr3("generated")));
    }
    ta.addEventListener("input", () => {
      this.#files = {
        ...this.#files,
        [this.#sourceFile]: ta.value
      };
      this.#markDirty();
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const s = ta.selectionStart;
        ta.setRangeText("  ", s, ta.selectionEnd, "end");
        ta.dispatchEvent(new Event("input"));
      }
    });
    box.append(bar, ta);
    return box;
  }
  async #uploadFile(f) {
    const name = f.name.replace(/[^A-Za-z0-9._-]/g, "-");
    const bytes = new Uint8Array(await f.arrayBuffer());
    const content = bytesToFiles({
      [name]: bytes
    })[name];
    this.#files = {
      ...this.#files,
      [name]: content
    };
    this.#sourceFile = name;
    this.#markDirty();
    this.#render();
  }
  async #addFile() {
    const name = await promptDialog(tr3("askFile"));
    const n = (name ?? "").trim();
    if (!n || this.#files[n] !== void 0) return;
    this.#files = {
      ...this.#files,
      [n]: ""
    };
    this.#sourceFile = n;
    this.#markDirty();
    this.#render();
  }
};
if (!customElements.get("omp-ograf-library")) customElements.define("omp-ograf-library", OmpOgrafLibrary);
