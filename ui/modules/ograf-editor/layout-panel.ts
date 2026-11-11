// Layout-Kopplung im Panel des Grafik-Nodes (Kapitel 90.8, Bedienung zu 90.2/90.3): zeigt die von der Seite vermessenen Zonen der
// stehenden Grafiken und lässt je Zone wählen, was der Bildmischer damit tut — ein PIP-Bild in die Zone legen (Squeeze-back) oder die
// Zone als Fenster des Paternoster-Übergangs setzen. Spricht `layout.bind`/`layout.unbind` und liest `zones`/`layout` des Nodes.
import { messages } from "./messages.ts";

const L = (document.documentElement.lang || "de").startsWith("en") ? "en" : "de";
const tr = (k: string, p?: Record<string, string>): string => {
  let s = (messages[L] as Record<string, string>)[k] ?? (messages.de as Record<string, string>)[k] ?? k;
  for (const [a, b] of Object.entries(p ?? {})) s = s.split(`{${a}}`).join(b);
  return s;
};

interface Zone {
  id: string;
}
interface Binding {
  layerId: string;
  zone: string;
  mixer: string;
  level: number;
  slot: number;
  senderId: string;
  kind?: string;
  /** Vorlage, für die die Bindung gilt (leer = jede Vorlage der Ebene). */
  templateId?: string;
  /** Die Ebene zeigt gerade diese Vorlage (sonst ruht die Bindung). */
  active?: boolean;
  enabled?: boolean;
  error?: string;
  lagMs?: number;
}
interface LayerInfo {
  id: string;
  templateId: string;
}
/** Zone, die das Manifest der Vorlage im Vendor-Feld `v_omp_zones` (OGraf v1: Präfix `v_`) deklariert. */
interface DeclaredZone {
  id: string;
  name?: string;
  slot?: number;
}
interface TemplateInfo {
  id: string;
  zones?: DeclaredZone[];
}
interface Mixer {
  nodeId: string;
  label: string;
}
interface Source {
  senderId: string;
  label: string;
}

function auth(): Record<string, string> {
  try {
    const t = localStorage.getItem("omp-auth-token");
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch {
    return {};
  }
}
async function get<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`/api/v1/${path}`, { headers: auth() });
    return r.ok ? await r.json() as T : null;
  } catch {
    return null;
  }
}

const STYLE = `
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

class OmpOgrafLayout extends HTMLElement {
  #nodeId = "";
  #timer = 0;
  #mixers: Mixer[] = [];
  #sources = new Map<string, Source[]>();
  /** Auswahl je Zone, bleibt über das Neuzeichnen erhalten. */
  #draft = new Map<string, { kind: string; mixer: string; sender: string; slot: number; level: number }>();
  #busy = false;
  #last = "";
  #layers: LayerInfo[] = [];
  /** Deklarierte Zonen je Vorlage (aus dem Manifest). */
  #declared = new Map<string, DeclaredZone[]>();

  connectedCallback() {
    this.#nodeId = this.getAttribute("node-id") ?? "";
    this.attachShadow({ mode: "open" });
    void this.#tick();
    this.#timer = window.setInterval(() => void this.#tick(), 2000);
  }
  disconnectedCallback() {
    window.clearInterval(this.#timer);
  }

  async #call(method: string, body: Record<string, unknown>): Promise<string | null> {
    const r = await fetch(`/api/v1/nodes/${this.#nodeId}/methods/${method}`, { method: "POST", headers: { "Content-Type": "application/json", ...auth() }, body: JSON.stringify(body) });
    if (r.ok) return null;
    try {
      const j = await r.json();
      return String(j.error ?? j.message ?? r.status);
    } catch {
      return String(r.status);
    }
  }

  async #loadMixers() {
    const inst = await get<{ id: string; type: string; label: string }[]>("instances");
    const nodes = await get<{ id: string; label: string; online?: boolean }[]>("nodes");
    if (!nodes) return;
    const labels = new Map(nodes.map((n) => [n.label, n.id]));
    const mixers = (inst ?? []).filter((i) => i.type === "omp-video-mixer-me" && labels.has(i.label)).map((i) => ({ nodeId: labels.get(i.label)!, label: i.label }));
    this.#mixers = mixers;
  }
  async #loadSources(m: Mixer) {
    const v = await get<{ value: { senderId: string; label: string }[] }>(`nodes/${m.nodeId}/params/crosspoint.inputs`);
    const list = (v?.value ?? []).filter((e) => e.senderId && !/lowres/i.test(e.label)).map((e) => ({ senderId: e.senderId, label: e.label }));
    this.#sources.set(m.label, [{ senderId: "pst:1", label: tr("srcPst") }, ...list]);
  }

  async #tick() {
    if (this.#busy || !this.isConnected) return;
    this.#busy = true;
    try {
      const zones = (await get<{ value: Record<string, Zone[]> }>(`nodes/${this.#nodeId}/params/zones`))?.value ?? {};
      const bindings = (await get<{ value: Binding[] }>(`nodes/${this.#nodeId}/params/layout`))?.value ?? [];
      this.#layers = (await get<{ value: LayerInfo[] }>(`nodes/${this.#nodeId}/params/layers`))?.value ?? [];
      this.#declared = new Map(((await get<{ value: TemplateInfo[] }>(`nodes/${this.#nodeId}/params/templates`))?.value ?? []).map((t) => [t.id, t.zones ?? []]));
      if (!this.#mixers.length) await this.#loadMixers();
      const sig = JSON.stringify([zones, bindings, this.#layers]);
      if (sig === this.#last && this.shadowRoot?.querySelector("select:focus,input:focus")) return;
      for (const m of this.#mixers) if (!this.#sources.has(m.label)) await this.#loadSources(m);
      this.#last = sig;
      this.#render(zones, bindings);
    } finally {
      this.#busy = false;
    }
  }

  #el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  #select(options: [string, string][], value: string, on: (v: string) => void): HTMLSelectElement {
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

  #render(zones: Record<string, Zone[]>, bindings: Binding[]) {
    const root = this.shadowRoot!;
    if (root.querySelector("select:focus,input:focus")) return; // nicht unter den Fingern wegziehen
    root.innerHTML = "";
    const style = this.#el("style");
    style.textContent = STYLE;
    root.append(style);
    // Eine Karte je Ebene + Vorlage + Zone. Die Vorlage ist die, die die Ebene gerade zeigt; Bindungen anderer Vorlagen ruhen
    // und erscheinen wieder, sobald die Ebene zur Vorlage zurückkehrt.
    const tplOf = (layer: string) => this.#layers.find((l) => l.id === layer)?.templateId ?? "";
    const keys = new Map<string, { layer: string; zone: string; template: string }>();
    for (const [layer, zs] of Object.entries(zones)) for (const z of zs) keys.set(`${layer}/${tplOf(layer)}/${z.id}`, { layer, zone: z.id, template: tplOf(layer) });
    for (const b of bindings) {
      const t = b.templateId ?? "";
      if (t && t !== tplOf(b.layerId)) continue; // ruht
      keys.set(`${b.layerId}/${t}/${b.zone}`, { layer: b.layerId, zone: b.zone, template: t });
    }
    if (!keys.size) {
      root.append(this.#el("div", "dim", tr("layoutNone")));
      return;
    }
    for (const [key, { layer, zone, template }] of keys) {
      const bound = bindings.find((b) => b.layerId === layer && b.zone === zone && ((b.templateId ?? "") === template || !b.templateId));
      const live = (zones[layer] ?? []).some((z) => z.id === zone);
      const card = this.#el("div", "zone");
      const decl = (this.#declared.get(template) ?? []).find((z) => z.id === zone);
      card.append(this.#el("h4", "", `${layer} · ${decl?.name ?? zone}${live ? "" : ` (${tr("layoutHidden")})`}`));
      if (bound) {
        const what = bound.kind === "window" ? tr("kindWindow") : bound.kind === "follow" ? `${tr("kindFollow")} ${bound.slot + 1}` : `${tr("kindPip")} ${bound.slot + 1}`;
        card.append(this.#el("div", bound.error ? "bad" : "ok", `${what} → ${bound.mixer}${bound.kind === "window" || bound.kind === "follow" ? "" : ` · ${bound.senderId === "pst:1" ? tr("srcPst") : ((this.#sources.get(bound.mixer) ?? []).find((x) => x.senderId === bound.senderId)?.label ?? bound.senderId.slice(0, 8))}`}${bound.error ? ` · ${bound.error}` : bound.enabled ? ` · ${tr("layoutOn")}` : ` · ${tr("layoutOff")}`}${bound.lagMs !== undefined && !bound.error ? ` · ${Math.round(bound.lagMs)} ms` : ""}`));
        const un = this.#el("button", "", tr("layoutUnbind"));
        un.addEventListener("click", async () => {
          await this.#call("layout.unbind", { layerId: layer, zone, templateId: bound.templateId ?? "" });
          this.#last = "";
          void this.#tick();
        });
        card.append(un);
        root.append(card);
        continue;
      }
      // Schlägt die Vorlage einen Slot vor (`slot` in `v_omp_zones`), ist das die Vorbelegung: Fenster folgt diesem PIP-Slot.
      const hint = decl?.slot && decl.slot > 0 ? decl.slot - 1 : -1;
      const d = this.#draft.get(key) ?? { kind: hint >= 0 ? "follow" : "pip", mixer: this.#mixers[0]?.label ?? "", sender: "pst:1", slot: Math.max(0, hint), level: 0 };
      this.#draft.set(key, d);
      const row = (label: string, el: HTMLElement) => {
        const r = this.#el("div", "row");
        r.append(this.#el("label", "", label), el);
        card.append(r);
      };
      row(tr("kind"), this.#select([["pip", tr("kindPip")], ["window", tr("kindWindow")], ["follow", tr("kindFollow")]], d.kind, (v) => { d.kind = v; this.#last = ""; this.#render(zones, bindings); }));
      if (!this.#mixers.length) card.append(this.#el("div", "bad", tr("noMixer")));
      row(tr("mixer"), this.#select(this.#mixers.map((m): [string, string] => [m.label, m.label]), d.mixer, (v) => { d.mixer = v; d.sender = "pst:1"; this.#render(zones, bindings); }));
      if (d.kind === "pip" || d.kind === "follow") {
        if (d.kind === "pip") {
          const src = this.#sources.get(d.mixer) ?? [{ senderId: "pst:1", label: tr("srcPst") }];
          row(tr("source"), this.#select(src.map((s): [string, string] => [s.senderId, s.label]), d.sender, (v) => { d.sender = v; }));
        }
        const slot = this.#el("input");
        slot.type = "number";
        slot.min = "1";
        slot.value = String(d.slot + 1);
        slot.addEventListener("change", () => { d.slot = Math.max(0, (Number(slot.value) || 1) - 1); });
        row(tr("slot"), slot);
      }
      const go = this.#el("button", "primary", tr("layoutBind"));
      go.disabled = !this.#mixers.length || !live;
      go.title = live ? "" : tr("layoutHiddenHint");
      go.addEventListener("click", async () => {
        const err = await this.#call("layout.bind", { layerId: layer, zone, mixer: d.mixer, kind: d.kind === "window" || d.kind === "follow" ? d.kind : "", senderId: d.kind === "pip" ? d.sender : "", slot: d.slot, level: d.level, templateId: template });
        if (err) card.append(this.#el("div", "bad", err));
        this.#last = "";
        void this.#tick();
      });
      card.append(go);
      root.append(card);
    }
  }
}

if (!customElements.get("omp-ograf-layout")) customElements.define("omp-ograf-layout", OmpOgrafLayout);
