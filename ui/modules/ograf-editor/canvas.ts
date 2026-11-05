// Leinwand des OGraf-Editors (Kapitel 90.5): Elemente auswählen, verschieben, skalieren, Eigenschaften, Ebenenliste, Rückgängig,
// Vorschau der Ein-/Ausblendung. Gezeichnet wird mit derselben Laufzeit (`runtime.js`) wie in der Sendung. Zustand in `scene.ts`.
import { renderScene } from "./runtime.js";
import {
  addElement, ANIM_TYPES, type Align, alignToScene, duplicateElement, type Guide, HANDLES, type Handle, hitTest, History, KINDS, type Kind,
  moveElements, newElement, removeElements, reorder, resizeBox, type Scene, type SceneElement, snapBox, updateElement,
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
  #sel = "";
  #vp!: HTMLDivElement;
  #ov!: HTMLDivElement;
  #side!: HTMLDivElement;
  #layers!: HTMLDivElement;
  #tools!: HTMLDivElement;
  #scale = 1;
  #handle: ReturnType<typeof renderScene> | null = null;
  #guides: Guide[] = [];
  #drag: { mode: "move" | Handle; sx: number; sy: number; base: Scene; id: string; changed: boolean } | null = null;
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
  destroy() {
    this.#ro.disconnect();
    this.#handle?.destroy();
  }
  /** Szene von außen ersetzen (z. B. nach Verwerfen). */
  setScene(s: Scene) {
    this.#hist = new History(s);
    if (!s.elements.some((e) => e.id === this.#sel)) this.#sel = "";
    this.#redraw();
  }

  // ── Aufbau ──
  #btn(label: string, onClick: () => void, title = "", cls = ""): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
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
    mid.append(this.#vp);
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
      scale: () => this.#scale,
      resolveAsset: (f: string) => this.#host.assetUrl(f),
    });
    this.#vp.insertBefore(this.#handle.stage, this.#ov);
    this.#drawOverlay();
    this.#drawTools();
    this.#drawLayers();
    this.#drawProps();
  }
  #selected(): SceneElement | undefined {
    return this.scene.elements.find((e) => e.id === this.#sel);
  }
  #drawOverlay() {
    this.#ov.innerHTML = "";
    if (this.#preview) return;
    const e = this.#selected();
    const k = this.#scale;
    if (e) {
      const sel = document.createElement("div");
      sel.className = "sel";
      sel.style.cssText = `left:${e.x * k}px;top:${e.y * k}px;width:${e.w * k}px;height:${e.h * k}px;transform:rotate(${e.rotation}deg)`;
      if (!e.rotation) {
        for (const h of HANDLES) {
          const d = document.createElement("div");
          d.className = "hd";
          d.dataset.handle = h;
          d.style.cursor = `${h}-resize`;
          d.style.left = h.includes("w") ? "0" : h.includes("e") ? "100%" : "50%";
          d.style.top = h.includes("n") ? "0" : h.includes("s") ? "100%" : "50%";
          sel.append(d);
        }
      }
      this.#ov.append(sel);
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
    for (const k of KINDS) t.append(this.#btn(`＋ ${tr(KIND_LABEL[k])}`, () => this.#add(k)));
    const sel = !!this.#selected();
    t.append(
      this.#btn("↶", () => this.#undo(), tr("undo"), ""),
      this.#btn("↷", () => this.#redo(), tr("redo"), ""),
      this.#btn("⧉", () => this.#dup(), tr("duplicate")),
      this.#btn("✕", () => this.#del(), tr("delete")),
      this.#btn("▶ / ■", () => this.#togglePreview(), tr("previewHint"), this.#preview ? "on" : ""),
      this.#btn("⌗", () => { this.#snap = !this.#snap; this.#drawTools(); }, tr("snap"), this.#snap ? "on" : ""),
    );
    const bs = t.querySelectorAll("button");
    (bs[kindsLen()] as HTMLButtonElement).disabled = !this.#hist.canUndo;
    (bs[kindsLen() + 1] as HTMLButtonElement).disabled = !this.#hist.canRedo;
    (bs[kindsLen() + 2] as HTMLButtonElement).disabled = !sel;
    (bs[kindsLen() + 3] as HTMLButtonElement).disabled = !sel;
  }
  #drawLayers() {
    const box = this.#layers;
    box.innerHTML = "";
    for (const e of [...this.scene.elements].reverse()) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `ly${e.id === this.#sel ? " on" : ""}`;
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
      b.addEventListener("click", () => { this.#sel = e.id; this.#redraw(); });
      box.append(b);
    }
    if (!this.scene.elements.length) box.append(document.createTextNode(tr("canvasEmpty")));
  }

  // ── Eigenschaften ──
  #drawProps() {
    const side = this.#side;
    side.innerHTML = "";
    const e = this.#selected();
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
      row(tr("font"), select(e.font ?? "", [["system-ui, sans-serif", "Sans"], ["Georgia, serif", "Serif"], ["ui-monospace, monospace", "Mono"], ["Impact, sans-serif", "Impact"]], (s) => patch({ font: s })));
      row(tr("size"), number(e.size ?? 40, (n) => patch({ size: n })), number(e.weight ?? 400, (n) => patch({ weight: n }), 100));
      row(tr("color"), ...color(e.color, (s) => patch({ color: s })));
      row(tr("hAlign"), select(e.align ?? "left", [["left", "◀"], ["center", "◆"], ["right", "▶"]], (s) => patch({ align: s as "left" })), select(e.valign ?? "top", [["top", "▲"], ["middle", "◆"], ["bottom", "▼"]], (s) => patch({ valign: s as "top" })));
      row(tr("lineHeight"), number(e.lineHeight ?? 1.2, (n) => patch({ lineHeight: n }), 0.1), number(e.padding ?? 0, (n) => patch({ padding: n })));
      row(tr("background"), ...color(e.bg, (s) => patch({ bg: s })));
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

  // ── Änderungen ──
  /** Änderung ohne Verlaufseintrag (während des Ziehens). */
  #live(s: Scene) {
    this.#hist.replaceCurrent(s);
    this.#host.onChange(s);
    this.#redrawStage();
  }
  #redrawStage() {
    this.#handle?.destroy();
    this.#handle = renderScene(this.#vp, this.scene, this.#host.data(), { editor: !this.#preview, scale: () => this.#scale, resolveAsset: (f: string) => this.#host.assetUrl(f) });
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
    this.#sel = e.id;
    this.#commit(addElement(this.scene, e));
    this.#vp.focus();
  }
  #del() {
    if (!this.#sel) return;
    const id = this.#sel;
    this.#sel = "";
    this.#commit(removeElements(this.scene, [id]));
  }
  #dup() {
    if (!this.#sel) return;
    const r = duplicateElement(this.scene, this.#sel);
    this.#sel = r.id;
    this.#commit(r.scene);
  }
  #undo() {
    if (!this.#hist.canUndo) return;
    this.#hist.undo();
    this.#host.onChange(this.scene);
    if (!this.#selected()) this.#sel = "";
    this.#redraw();
  }
  #redo() {
    if (!this.#hist.canRedo) return;
    this.#hist.redo();
    this.#host.onChange(this.scene);
    this.#redraw();
  }
  async #togglePreview() {
    this.#preview = !this.#preview;
    this.#redraw();
    if (this.#preview && this.#handle) {
      await this.#handle.play();
      await new Promise((r) => setTimeout(r, 800));
      if (this.#preview && this.#handle) await this.#handle.stop();
    }
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
    const h = target.dataset?.handle as Handle | undefined;
    const p = this.#toScene(ev);
    let id = this.#sel;
    let mode: "move" | Handle = "move";
    if (h && this.#selected()) mode = h;
    else {
      id = hitTest(this.scene, p.x, p.y) ?? "";
      this.#sel = id;
    }
    if (!id) {
      this.#redraw();
      return;
    }
    this.#drag = { mode, sx: ev.clientX, sy: ev.clientY, base: this.scene, id, changed: false };
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
    const base = d.base.elements.find((e) => e.id === d.id);
    if (!base) return;
    let box = { x: base.x, y: base.y, w: base.w, h: base.h };
    if (d.mode === "move") box = { ...box, x: base.x + dx, y: base.y + dy };
    else box = resizeBox(box, d.mode, dx, dy, ev.shiftKey);
    this.#guides = [];
    if (this.#snap && !ev.altKey) {
      const sn = snapBox(box, d.base, [d.id], 8 / this.#scale);
      if (d.mode === "move") box = sn.box;
      this.#guides = sn.guides;
    }
    box = { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) };
    d.changed = d.changed || Math.abs(dx) + Math.abs(dy) > 0.5;
    this.#hist.replaceCurrent(updateElement(d.base, d.id, box));
    this.#host.onChange(this.scene);
    this.#redrawStage();
  }
  #up(_ev: PointerEvent) {
    const d = this.#drag;
    this.#drag = null;
    this.#guides = [];
    if (!d) return;
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
    } else if (this.#sel && ev.key.startsWith("Arrow")) {
      ev.preventDefault();
      const n = ev.shiftKey ? 10 : 1;
      const [dx, dy] = { ArrowLeft: [-n, 0], ArrowRight: [n, 0], ArrowUp: [0, -n], ArrowDown: [0, n] }[ev.key] ?? [0, 0];
      this.#commit(moveElements(this.scene, [this.#sel], dx, dy));
    }
  }
}

const kindsLen = (): number => KINDS.length;
