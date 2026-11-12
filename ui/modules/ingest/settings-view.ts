// Administration → Plattform → Stream Ingest: die Einstellungen der Aufnahme (Formate/Profile, Grenzen je Rechner, Zulassungsregeln)
// als Seite statt als Dialog im Tab „Stream ingest“ (Nutzerwunsch 2026-11-12). Dasselbe Formular wie zuvor, eingebettet.
import { t as tt } from "../host.ts";
import { api, errText } from "./ingest-view.ts";
import { openSettingsForm } from "./settings-form.ts";
import type { IngestConfig } from "./settings-logic.ts";

class IngestSettingsView extends HTMLElement {
  connectedCallback() {
    this.style.cssText = "display:block;";
    void this.#load();
  }

  async #load() {
    const now = Date.now();
    const [cfg, cap] = await Promise.all([
      api("GET", "/config"),
      api<{ hosts?: { id: string; label: string }[] }>("GET", `/capacity?from=${new Date(now).toISOString()}&to=${new Date(now + 3600000).toISOString()}`),
    ]);
    if (!cfg.ok) {
      const msg = document.createElement("p");
      msg.style.cssText = "color:var(--omp-error);";
      msg.textContent = errText(cfg.data) || tt("ing.err");
      this.replaceChildren(msg);
      return;
    }
    openSettingsForm({
      config: cfg.data as unknown as IngestConfig,
      hosts: (cap.ok ? cap.data.hosts ?? [] : []).map((h) => ({ id: h.id, label: h.label })),
      container: this,
      onDiscard: () => void this.#load(),
      save: async (c) => {
        const x = await api("PUT", "/config", c);
        if (!x.ok) return { ok: false, message: errText(x.data) || tt("ing.err") };
        return { ok: true, message: "" };
      },
    });
  }
}

if (!customElements.get("omp-ingest-settings-view")) customElements.define("omp-ingest-settings-view", IngestSettingsView);
