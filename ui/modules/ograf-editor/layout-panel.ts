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
  enabled?: boolean;
  error?: string;
  lagMs?: number;
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
      if (!this.#mixers.length) await this.#loadMixers();
      const sig = JSON.stringify([zones, bindings]);
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
    const keys = new Map<string, { layer: string; zone: string }>();
    for (const [layer, zs] of Object.entries(zones)) for (const z of zs) keys.set(`${layer}/${z.id}`, { layer, zone: z.id });
    for (const b of bindings) keys.set(`${b.layerId}/${b.zone}`, { layer: b.layerId, zone: b.zone });
    if (!keys.size) {
      root.append(this.#el("div", "dim", tr("layoutNone")));
      return;
    }
    for (const [key, { layer, zone }] of keys) {
      const bound = bindings.find((b) => b.layerId === layer && b.zone === zone);
      const live = (zones[layer] ?? []).some((z) => z.id === zone);
      const card = this.#el("div", "zone");
      card.append(this.#el("h4", "", `${layer} · ${zone}${live ? "" : ` (${tr("layoutHidden")})`}`));
      if (bound) {
        const what = bound.kind === "window" ? tr("kindWindow") : `${tr("kindPip")} ${bound.slot + 1}`;
        card.append(this.#el("div", bound.error ? "bad" : "ok", `${what} → ${bound.mixer}${bound.kind === "window" ? "" : ` · ${bound.senderId === "pst:1" ? tr("srcPst") : ((this.#sources.get(bound.mixer) ?? []).find((x) => x.senderId === bound.senderId)?.label ?? bound.senderId.slice(0, 8))}`}${bound.error ? ` · ${bound.error}` : bound.enabled ? ` · ${tr("layoutOn")}` : ` · ${tr("layoutOff")}`}${bound.lagMs !== undefined && !bound.error ? ` · ${Math.round(bound.lagMs)} ms` : ""}`));
        const un = this.#el("button", "", tr("layoutUnbind"));
        un.addEventListener("click", async () => {
          await this.#call("layout.unbind", { layerId: layer, zone });
          this.#last = "";
          void this.#tick();
        });
        card.append(un);
        root.append(card);
        continue;
      }
      const d = this.#draft.get(key) ?? { kind: "pip", mixer: this.#mixers[0]?.label ?? "", sender: "pst:1", slot: 0, level: 0 };
      this.#draft.set(key, d);
      const row = (label: string, el: HTMLElement) => {
        const r = this.#el("div", "row");
        r.append(this.#el("label", "", label), el);
        card.append(r);
      };
      row(tr("kind"), this.#select([["pip", tr("kindPip")], ["window", tr("kindWindow")]], d.kind, (v) => { d.kind = v; this.#last = ""; this.#render(zones, bindings); }));
      if (!this.#mixers.length) card.append(this.#el("div", "bad", tr("noMixer")));
      row(tr("mixer"), this.#select(this.#mixers.map((m): [string, string] => [m.label, m.label]), d.mixer, (v) => { d.mixer = v; d.sender = "pst:1"; this.#render(zones, bindings); }));
      if (d.kind === "pip") {
        const src = this.#sources.get(d.mixer) ?? [{ senderId: "pst:1", label: tr("srcPst") }];
        row(tr("source"), this.#select(src.map((s): [string, string] => [s.senderId, s.label]), d.sender, (v) => { d.sender = v; }));
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
        const err = await this.#call("layout.bind", { layerId: layer, zone, mixer: d.mixer, kind: d.kind === "window" ? "window" : "", senderId: d.kind === "window" ? "" : d.sender, slot: d.slot, level: d.level });
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
