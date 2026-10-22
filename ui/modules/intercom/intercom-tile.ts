// Kachel „Intercom“ der Operator-Konsole (Kapitel 47): öffnet die eigene Sprechstelle. Das Panel selbst liefert der
// Intercom-Node (eigener Port, HTTPS wegen des Mikrofons) und wird hier eingebettet.

import { apiFetch, t as tt } from "../host.ts";

interface PanelEntry {
  party_id: number;
  name: string;
  kind: string;
  url: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

class IntercomTile extends HTMLElement {
  #panels: PanelEntry[] = [];
  #current = 0;
  #error = "";
  #loaded = false;

  connectedCallback() {
    this.style.cssText = "display:block;";
    if (!this.#loaded) {
      this.#loaded = true;
      void this.#load();
    }
    this.#render();
  }

  async #load() {
    try {
      const r = await apiFetch("/api/v1/ext/intercom/panels");
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? String(r.status));
      const body = (await r.json()) as { panels: PanelEntry[]; error?: string };
      this.#panels = body.panels ?? [];
      this.#error = body.error ?? "";
    } catch (e) {
      this.#error = tt("icom.tile.loadFailed", { p0: (e as Error).message });
    }
    this.#render();
  }

  #render() {
    this.replaceChildren();
    if (this.#error) this.append(el("div", "color:var(--omp-error);margin-bottom:8px;", this.#error));
    if (!this.#loaded || (this.#panels.length === 0 && !this.#error)) {
      if (this.#loaded) this.append(el("div", "color:var(--omp-text-dim);padding:12px 0;", tt("icom.tile.none")));
      return;
    }
    if (this.#panels.length === 0) return;
    const p = this.#panels[Math.min(this.#current, this.#panels.length - 1)];
    const bar = el("div", "display:flex;gap:12px;align-items:center;margin-bottom:8px;flex-wrap:wrap;");
    if (this.#panels.length > 1) {
      const sel = el("select", "padding:3px 6px;");
      this.#panels.forEach((x, i) => {
        const o = el("option", "", x.name);
        o.value = String(i);
        sel.append(o);
      });
      sel.value = String(this.#current);
      sel.addEventListener("change", () => {
        this.#current = Number(sel.value);
        this.#render();
      });
      bar.append(el("span", "font-size:12px;color:var(--omp-text-dim);", tt("icom.tile.pick")), sel);
    } else {
      bar.append(el("strong", "", p.name));
    }
    const open = el("a", "font-size:12px;", tt("icom.tile.newTab"));
    open.href = p.url;
    open.target = "_blank";
    open.rel = "noopener";
    bar.append(open, el("span", "font-size:11px;color:var(--omp-text-dim);", tt("icom.tile.certHint")));
    this.append(bar);
    const frame = el("iframe", "width:100%;max-width:980px;height:calc(100vh - 200px);min-height:420px;border:1px solid var(--omp-border);border-radius:8px;background:var(--omp-bg);");
    frame.setAttribute("allow", "microphone; autoplay");
    frame.src = p.url;
    frame.title = p.name;
    this.append(frame);
  }
}

if (!customElements.get("omp-intercom-tile")) customElements.define("omp-intercom-tile", IntercomTile);
