// Leinwand des OGraf-Editors (Kapitel 90.5): Elemente auswählen, verschieben, skalieren, Eigenschaften, Ebenenliste, Rückgängig,
// Vorschau der Ein-/Ausblendung. Gezeichnet wird mit derselben Laufzeit (`runtime.js`) wie in der Sendung. Zustand in `scene.ts`.
import { renderScene } from "./runtime.js";
import {
  addElement, alignGroup, ANIM_TYPES, type Align, alignToScene, angleFor, boundsOf, distribute, duplicateMany, elementsInRect, type Guide, HANDLES,
  type Handle, hitTest, History, KINDS, type Kind, moveElements, newElement, removeElements, reorder, resizeBox, resizeRotated, type Scene,
  type SceneElement, setStepCount, setTiming, snapBox, timelineEnd, updateElement,
} from "./scene.ts";
import { messages } from "./messages.ts";

const L = (document.documentElement.lang || "de").startsWith("en") ? "en" : "de";
const tr = (k: string): string => (messages[L] as Record<string, string>)[k] ?? (messages.de as Record<string, string>)[k] ?? k;

export interface ParamInfo {
  key: string;
  kind: string;
}
export interface CanvasHost {
  scene: Scene;
  /** Bilddateien des Pakets (Namen) und deren URL (Data-URL aus dem Paket). */
  images: () => string[];
  assetUrl: (name: string) => string;
  params: () => ParamInfo[];
  /** Schriftdateien des Pakets (Namen). */
  fonts: () => string[];
  /** Vorgabewerte der Parameter für die Anzeige. */
  data: () => Record<string, unknown>;
  onChange: (scene: Scene) => void;
}

const STYLE = `
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

const KIND_LABEL: Record<Kind, string> = { text: "kText", rect: "kRect", image: "kImage", zone: "kZone" };

export class CanvasEditor {
  readonly el: HTMLElement;
  #root: ShadowRoot;
  #host: CanvasHost;
  #hist: History<Scene>;
  #selIds: string[] = [];
  #vp!: HTMLDivElement;
  #ov!: HTMLDivElement;
  #side!: HTMLDivElement;
  #layers!: HTMLDivElement;
  #tools!: HTMLDivElement;
  #scale = 1;
  #handle: ReturnType<typeof renderScene> | null = null;
  #guides: Guide[] = [];
  #drag: { mode: "move" | "rot" | "marquee" | Handle; sx: number; sy: number; base: Scene; id: string; changed: boolean; add: boolean } | null = null;
  #marquee: { x: number; y: number; w: number; h: number } | null = null;
  #viewStep = 0;
  #pvStep = 0;
  #tl!: HTMLDivElement;
  #tlDir: "in" | "out" = "in";
  #tdrag: { id: string; mode: "move" | "size"; sx: number; base: Scene; end: number; w: number; changed: boolean } | null = null;
  #preview = false;
  #ro: ResizeObserver;
  #snap = true;

  constructor(host: CanvasHost) {
    this.#host = host;
    this.#hist = new History(host.scene);
    this.el = document.createElement("div");
    this.#root = this.el.attachShadow({ mode: "open" });
    this.#build();
    this.#ro = new ResizeObserver(() => this.#fit());
    this.#ro.observe(this.#vp);
    queueMicrotask(() => this.#redraw());
  }

  get scene(): Scene {
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
  setScene(s: Scene) {
    this.#hist = new History(s);
    this.#pick(this.#selIds);
    this.#redraw();
  }

  // ── Aufbau ──
  #btn(label: string, onClick: () => void, title = "", cls = "", disabled = false): HTMLButtonElement {
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
    // links: Werkzeuge + Ebenen
    const left = document.createElement("div");
    left.className = "col";
    this.#tools = document.createElement("div");
    this.#tools.className = "tools";
    this.#layers = document.createElement("div");
    this.#layers.className = "layers";
    left.append(this.#tools, this.#layers);
    // Mitte: Fläche
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
    // rechts: Eigenschaften
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
      resolveAsset: (f: string) => this.#host.assetUrl(f),
    });
    this.#vp.insertBefore(this.#handle.stage, this.#ov);
    this.#drawOverlay();
    this.#drawTimeline();
    this.#drawTools();
    this.#drawLayers();
    this.#drawProps();
  }
  /** Das einzelne gewählte Element (nur bei genau einer Auswahl). */
  #selected(): SceneElement | undefined {
    return this.#selIds.length === 1 ? this.scene.elements.find((e) => e.id === this.#selIds[0]) : undefined;
  }
  #pick(ids: string[]) {
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
      const n = this.scene.stepCount ?? 1;
      t.append(
        this.#btn("■", () => void this.#togglePreview(), tr("previewStop"), "on"),
        this.#btn("⏭", () => void this.#pvNext(), tr("previewNext"), "", n < 2 || this.#pvStep >= n - 1),
        document.createTextNode(` ${this.#pvStep + 1}/${n}`),
      );
      return;
    }
    for (const k of KINDS) t.append(this.#btn(`＋ ${tr(KIND_LABEL[k])}`, () => this.#add(k)));
    const sel = this.#selIds.length > 0;
    t.append(
      this.#btn("↶", () => this.#undo(), tr("undo"), "", !this.#hist.canUndo),
      this.#btn("↷", () => this.#redo(), tr("redo"), "", !this.#hist.canRedo),
      this.#btn("⧉", () => this.#dup(), tr("duplicate"), "", !sel),
      this.#btn("✕", () => this.#del(), tr("delete"), "", !sel),
      this.#btn("▶", () => void this.#togglePreview(), tr("previewHint")),
      this.#btn("⌗", () => { this.#snap = !this.#snap; this.#drawTools(); }, tr("snap"), this.#snap ? "on" : ""),
    );
    // Schritte: Anzahl und Ansicht
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
      for (let i = 0; i < n; i++) row.append(this.#btn(String(i + 1), () => { this.#viewStep = i; this.#redraw(); }, tr("viewStep"), i === this.#viewStep ? "on" : ""));
    }
    t.append(row);
  }
  #drawLayers() {
    const box = this.#layers;
    box.innerHTML = "";
    for (const e of [...this.scene.elements].reverse()) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `ly${this.#selIds.includes(e.id) ? " on" : ""}`;
      const icon = { text: "T", rect: "▭", image: "🖼", zone: "⬚" }[e.kind];
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = `${icon} ${e.name}`;
      b.append(n);
      for (const [l, how, ttl] of [["▲", "up", tr("up")], ["▼", "down", tr("down")]] as const) {
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
        this.#selIds = ev.shiftKey ? (this.#selIds.includes(e.id) ? this.#selIds.filter((x) => x !== e.id) : [...this.#selIds, e.id]) : [e.id];
        this.#redraw();
      });
      box.append(b);
    }
    if (!this.scene.elements.length) box.append(document.createTextNode(tr("canvasEmpty")));
    this.#drawFonts();
  }
  #fontBox?: HTMLDivElement;
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
        if (cb.checked) fonts.push({ family: f.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9 _-]/g, " ").trim() || "Schrift", file: f });
        this.#commit({ ...this.scene, fonts });
      });
      row.append(cb, document.createTextNode(used ? `${f} → „${used.family}“` : f));
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
    const head = (t: string) => {
      const h = document.createElement("h4");
      h.textContent = t;
      pp.append(h);
    };
    const row = (label: string, ...els: HTMLElement[]) => {
      const l = document.createElement("label");
      l.textContent = label;
      const w = document.createElement("div");
      w.className = els.length > 1 ? "two" : "";
      w.append(...els);
      pp.append(l, w);
    };
    const patch = (p: Partial<SceneElement>, live = false) => {
      if (live) this.#live(updateElement(this.scene, e.id, p));
      else this.#commit(updateElement(this.scene, e.id, p), false);
    };
    const text = (v: string, on: (s: string) => void): HTMLInputElement => {
      const i = document.createElement("input");
      i.value = v;
      i.addEventListener("change", () => on(i.value));
      return i;
    };
    const number = (v: number, on: (n: number) => void, step = 1): HTMLInputElement => {
      const i = document.createElement("input");
      i.type = "number";
      i.step = String(step);
      i.value = String(Math.round(v * 100) / 100);
      i.addEventListener("change", () => { const n = Number(i.value); if (Number.isFinite(n)) on(n); });
      return i;
    };
    const select = (v: string, opts: [string, string][], on: (s: string) => void): HTMLSelectElement => {
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
    const color = (v: string | undefined, on: (s: string) => void): HTMLElement[] => {
      const c = document.createElement("input");
      c.type = "color";
      c.value = /^#[0-9a-fA-F]{6}$/.test(v ?? "") ? v! : "#000000";
      c.addEventListener("change", () => on(c.value));
      const t = text(v ?? "", on);
      t.placeholder = "#rrggbb / {{farbe}}";
      return [c, t];
    };
    head(tr(KIND_LABEL[e.kind]));
    row(tr("name"), text(e.name, (s) => patch({ name: s })));
    row("X / Y", number(e.x, (n) => patch({ x: Math.round(n) })), number(e.y, (n) => patch({ y: Math.round(n) })));
    row("B / H", number(e.w, (n) => patch({ w: Math.round(n) })), number(e.h, (n) => patch({ h: Math.round(n) })));
    row(tr("rotation"), number(e.rotation, (n) => patch({ rotation: n })));
    row(tr("opacity"), number(e.opacity, (n) => patch({ opacity: n }), 0.05));
    const al = (how: Align, l: string) => this.#btn(l, () => this.#commit(alignToScene(this.scene, e.id, how)));
    row(tr("align"), al("left", "⇤"), al("hcenter", "↔"), al("right", "⇥"));
    row("", al("top", "⤒"), al("vcenter", "↕"), al("bottom", "⤓"));
    if (e.kind === "text") {
      head(tr("kText"));
      const ta = document.createElement("textarea");
      ta.value = e.text ?? "";
      ta.addEventListener("change", () => patch({ text: ta.value }));
      row(tr("content"), ta);
      const keys = this.#host.params().map((p) => p.key);
      if (keys.length) {
        row(tr("insertParam"), select("", [["", "…"], ...keys.map((k): [string, string] => [k, k])], (k) => { if (k) patch({ text: `${e.text ?? ""}{{${k}}}` }); }));
      }
      const own = (this.scene.fonts ?? []).map((f): [string, string] => [`"${f.family}", system-ui, sans-serif`, f.family]);
      row(tr("font"), select(e.font ?? "", [["system-ui, sans-serif", "Sans"], ["Georgia, serif", "Serif"], ["ui-monospace, monospace", "Mono"], ["Impact, sans-serif", "Impact"], ...own], (s) => patch({ font: s })));
      row(tr("size"), number(e.size ?? 40, (n) => patch({ size: n })), number(e.weight ?? 400, (n) => patch({ weight: n }), 100));
      row(tr("color"), ...color(e.color, (s) => patch({ color: s })));
      row(tr("hAlign"), select(e.align ?? "left", [["left", "◀"], ["center", "◆"], ["right", "▶"]], (s) => patch({ align: s as "left" })), select(e.valign ?? "top", [["top", "▲"], ["middle", "◆"], ["bottom", "▼"]], (s) => patch({ valign: s as "top" })));
      row(tr("lineHeight"), number(e.lineHeight ?? 1.2, (n) => patch({ lineHeight: n }), 0.1), number(e.padding ?? 0, (n) => patch({ padding: n })));
      row(tr("background"), ...color(e.bg, (s) => patch({ bg: s })));
      const af = document.createElement("input");
      af.type = "checkbox";
      af.style.width = "auto";
      af.checked = !!e.autofit;
      af.addEventListener("change", () => patch({ autofit: af.checked }));
      row(tr("autofit"), af, number(e.minSize ?? 12, (n) => patch({ minSize: Math.max(4, n) })));
    } else if (e.kind === "rect") {
      head(tr("kRect"));
      row(tr("fill"), ...color(e.fill, (s) => patch({ fill: s })));
      row(tr("radius"), number(e.radius ?? 0, (n) => patch({ radius: n })));
      row(tr("stroke"), ...color(e.stroke, (s) => patch({ stroke: s })));
      row(tr("strokeW"), number(e.strokeW ?? 0, (n) => patch({ strokeW: n })));
    } else if (e.kind === "image") {
      head(tr("kImage"));
      const imgs = this.#host.images();
      row(tr("file"), select(e.file ?? "", [["", "–"], ...imgs.map((f): [string, string] => [f, f])], (s) => patch({ file: s })));
      row(tr("fit"), select(e.fit ?? "contain", [["contain", "contain"], ["cover", "cover"], ["fill", "fill"]], (s) => patch({ fit: s as "fill" })));
      row(tr("radius"), number(e.radius ?? 0, (n) => patch({ radius: n })));
      if (!imgs.length) pp.append(document.createTextNode(tr("noImages")));
    } else {
      head(tr("kZone"));
      row(tr("zoneId"), text(e.zone ?? "", (s) => patch({ zone: s.replace(/[^A-Za-z0-9_-]/g, "") || "zone" })));
      pp.append(document.createTextNode(tr("zoneHint")));
    }
    if ((this.scene.stepCount ?? 1) > 1) {
      head(tr("stepRange"));
      row(tr("fromTo"), number((e.from ?? 0) + 1, (n) => patch({ from: Math.max(0, Math.round(n) - 1) })), number(e.to ?? -1, (n) => patch({ to: n <= 0 ? -1 : Math.round(n) - 1 })));
    }
    if (e.kind !== "zone") {
      for (const dir of ["in", "out"] as const) {
        head(dir === "in" ? tr("animIn") : tr("animOut"));
        const a = e.anim?.[dir] ?? { type: "none", ms: 300, delay: 0, ease: "ease-out" };
        const set = (p: Partial<typeof a>) => patch({ anim: { ...e.anim, [dir]: { ...a, ...p } } });
        row(tr("animType"), select(a.type, ANIM_TYPES.map((t): [string, string] => [t, tr(`anim_${t}`)]), (s) => set({ type: s })));
        row(tr("animMs"), number(a.ms, (n) => set({ ms: Math.max(0, n) }), 50), number(a.delay, (n) => set({ delay: Math.max(0, n) }), 50));
        row(tr("animEase"), select(a.ease, [["linear", "linear"], ["ease-out", "ease-out"], ["ease-in", "ease-in"], ["ease-in-out", "ease-in-out"]], (s) => set({ ease: s })));
      }
    }
    side.append(pp);
  }

  #drawGroupProps(side: HTMLElement) {
    const info = document.createElement("div");
    info.textContent = tr("groupCount").replace("{n}", String(this.#selIds.length));
    const bar = document.createElement("div");
    bar.className = "tools";
    const al = (how: Align, l: string, ttl: string) => this.#btn(l, () => this.#commit(alignGroup(this.scene, this.#selIds, how)), ttl);
    bar.append(al("left", "⇤", tr("alignLeft")), al("hcenter", "↔", tr("alignHCenter")), al("right", "⇥", tr("alignRight")),
      al("top", "⤒", tr("alignTop")), al("vcenter", "↕", tr("alignVCenter")), al("bottom", "⤓", tr("alignBottom")));
    const dist = document.createElement("div");
    dist.className = "tools";
    dist.append(
      this.#btn("⇹", () => this.#commit(distribute(this.scene, this.#selIds, "x")), tr("distributeX")),
      this.#btn("⇳", () => this.#commit(distribute(this.scene, this.#selIds, "y")), tr("distributeY")),
    );
    side.append(info, bar, dist);
  }

  // ── Änderungen ──
  /** Änderung ohne Verlaufseintrag (während des Ziehens). */
  #live(s: Scene) {
    this.#hist.replaceCurrent(s);
    this.#host.onChange(s);
    this.#redrawStage();
  }
  #redrawStage() {
    this.#handle?.destroy();
    this.#handle = renderScene(this.#vp, this.scene, this.#host.data(), { editor: !this.#preview, step: this.#viewStep, scale: () => this.#scale, resolveAsset: (f: string) => this.#host.assetUrl(f) });
    this.#drawTimeline();
    this.#vp.insertBefore(this.#handle.stage, this.#ov);
    this.#drawOverlay();
  }
  #commit(s: Scene, full = true) {
    if (s === this.scene) return;
    this.#hist.push(s);
    this.#host.onChange(s);
    if (full) this.#redraw();
    else this.#redraw();
  }
  #add(kind: Kind) {
    const e = newElement(kind, this.scene);
    this.#selIds = [e.id];
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
    head.append(
      this.#btn(tr("animIn"), () => { this.#tlDir = "in"; this.#drawTimeline(); }, "", dir === "in" ? "on" : ""),
      this.#btn(tr("animOut"), () => { this.#tlDir = "out"; this.#drawTimeline(); }, "", dir === "out" ? "on" : ""),
      document.createTextNode(`${tr("timeline")} · ${end} ms`),
    );
    box.append(head);
    const ruler = document.createElement("div");
    ruler.className = "row";
    const rp = document.createElement("div");
    const rt = document.createElement("div");
    rt.className = "ruler";
    for (let t = 0; t <= end; t += end / 4) {
      const m = document.createElement("span");
      m.style.cssText = `position:absolute;left:${(t / end) * 100}%;transform:translateX(${t === end ? "-100%" : "0"})`;
      m.textContent = `${Math.round(t)}`;
      rt.append(m);
    }
    ruler.append(rp, rt);
    box.append(ruler);
    for (const e of [...s.elements].reverse()) {
      if (e.kind === "zone") continue;
      const a = e.anim?.[dir];
      const row = document.createElement("div");
      row.className = "row";
      const nm = document.createElement("div");
      nm.className = `nm${this.#selIds.includes(e.id) ? " on" : ""}`;
      nm.textContent = e.name;
      nm.title = e.name;
      nm.addEventListener("click", () => { this.#selIds = [e.id]; this.#redraw(); });
      const track = document.createElement("div");
      track.className = "track";
      if (a && a.type !== "none") {
        const bar = document.createElement("div");
        bar.className = `bar ${dir}`;
        bar.style.left = `${(a.delay / end) * 100}%`;
        bar.style.width = `${Math.max(1, (a.ms / end) * 100)}%`;
        bar.title = `${tr(`anim_${a.type}`)} · ${a.delay} + ${a.ms} ms`;
        const grip = document.createElement("div");
        grip.className = "gr";
        bar.append(grip);
        bar.addEventListener("pointerdown", (ev) => {
          ev.preventDefault();
          this.#tdrag = { id: e.id, mode: ev.target === grip ? "size" : "move", sx: ev.clientX, base: this.scene, end, w: track.clientWidth || 1, changed: false };
          this.#selIds = [e.id];
          bar.setPointerCapture(ev.pointerId);
        });
        bar.addEventListener("pointermove", (ev) => this.#tlMove(ev));
        bar.addEventListener("pointerup", () => this.#tlUp());
        bar.addEventListener("pointercancel", () => this.#tlUp());
        track.append(bar);
      } else {
        track.title = tr("noAnim");
        track.style.opacity = ".5";
        track.addEventListener("dblclick", () => this.#commit(setTiming(this.scene, e.id, dir, { ms: 400 })));
      }
      row.append(nm, track);
      box.append(row);
    }
  }
  #tlMove(ev: PointerEvent) {
    const d = this.#tdrag;
    if (!d) return;
    const dms = ((ev.clientX - d.sx) / d.w) * d.end;
    d.changed = d.changed || Math.abs(ev.clientX - d.sx) > 1;
    const dir = this.#tlDir;
    const cur = d.base.elements.find((e) => e.id === d.id)?.anim?.[dir];
    if (!cur) return;
    const next = d.mode === "move" ? setTiming(d.base, d.id, dir, { delay: cur.delay + dms }) : setTiming(d.base, d.id, dir, { ms: cur.ms + dms });
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
  #toScene(ev: PointerEvent): { x: number; y: number } {
    const r = this.#vp.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / this.#scale, y: (ev.clientY - r.top) / this.#scale };
  }
  #down(ev: PointerEvent) {
    if (this.#preview || ev.button !== 0) return;
    this.#vp.focus();
    const target = ev.target as HTMLElement;
    const h = target.dataset?.handle as Handle | "rot" | undefined;
    const p = this.#toScene(ev);
    let id = this.#selIds[0] ?? "";
    let mode: "move" | "rot" | "marquee" | Handle = "move";
    if (h && this.#selected()) mode = h;
    else {
      const hit = hitTest(this.scene, p.x, p.y) ?? "";
      if (hit && ev.shiftKey) {
        this.#selIds = this.#selIds.includes(hit) ? this.#selIds.filter((x) => x !== hit) : [...this.#selIds, hit];
        id = hit;
      } else if (hit) {
        if (!this.#selIds.includes(hit)) this.#selIds = [hit];
        id = hit;
      } else {
        if (!ev.shiftKey) this.#selIds = [];
        mode = "marquee";
        id = "";
      }
    }
    this.#drag = { mode, sx: ev.clientX, sy: ev.clientY, base: this.scene, id, changed: false, add: ev.shiftKey };
    try {
      this.#vp.setPointerCapture(ev.pointerId);
    } catch { /* ohne Capture: Ziehen endet beim Verlassen */ }
    this.#drawOverlay();
    this.#drawLayers();
    this.#drawProps();
    this.#drawTools();
  }
  #move(ev: PointerEvent) {
    const d = this.#drag;
    if (!d) return;
    const dx = (ev.clientX - d.sx) / this.#scale;
    const dy = (ev.clientY - d.sy) / this.#scale;
    d.changed = d.changed || Math.abs(dx) + Math.abs(dy) > 0.5;
    if (d.mode === "marquee") {
      const p0 = { x: (d.sx - this.#vp.getBoundingClientRect().left) / this.#scale, y: (d.sy - this.#vp.getBoundingClientRect().top) / this.#scale };
      this.#marquee = { x: Math.min(p0.x, p0.x + dx), y: Math.min(p0.y, p0.y + dy), w: Math.abs(dx), h: Math.abs(dy) };
      this.#drawOverlay();
      return;
    }
    if (d.mode === "move") {
      const ids = this.#selIds;
      const bb = boundsOf(d.base, ids);
      if (!bb) return;
      let box = { ...bb, x: bb.x + dx, y: bb.y + dy };
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
        this.#hist.replaceCurrent(updateElement(d.base, d.id, { rotation: angleFor(base, p.x, p.y, ev.shiftKey) }));
      } else {
        const b0 = { x: base.x, y: base.y, w: base.w, h: base.h };
        const box = base.rotation ? resizeRotated(b0, base.rotation, d.mode, dx, dy, ev.shiftKey) : resizeBox(b0, d.mode, dx, dy, ev.shiftKey);
        this.#hist.replaceCurrent(updateElement(d.base, d.id, box));
      }
    }
    this.#host.onChange(this.scene);
    this.#redrawStage();
  }
  #up(_ev: PointerEvent) {
    const d = this.#drag;
    this.#drag = null;
    this.#guides = [];
    const m = this.#marquee;
    this.#marquee = null;
    if (!d) return;
    if (d.mode === "marquee") {
      if (m && (m.w > 3 || m.h > 3)) {
        const inside = elementsInRect(this.scene, m);
        this.#selIds = d.add ? [...new Set([...this.#selIds, ...inside])] : inside;
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
  #key(ev: KeyboardEvent) {
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
      const [dx, dy] = { ArrowLeft: [-n, 0], ArrowRight: [n, 0], ArrowUp: [0, -n], ArrowDown: [0, n] }[ev.key] ?? [0, 0];
      this.#commit(moveElements(this.scene, this.#selIds, dx, dy));
    }
  }
}

const kindsLen = (): number => KINDS.length;
