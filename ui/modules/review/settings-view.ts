// Administration → Plattform → Eingangskontrolle: die Einstellungen des Eingangs (Freigabe, Segmentregeln, QC, Proxy, Metadatenformular,
// Import) als Seite statt als Dialog im Tab „Eingang“ (Nutzerwunsch 2026-11-12). Dasselbe Formular wie zuvor, eingebettet.
import { showToast, t as tt } from "../host.ts";
import { call, errText } from "./api.ts";
import { openReviewSettingsForm } from "./settings-form.ts";

class ReviewSettingsView extends HTMLElement {
  connectedCallback() {
    this.style.cssText = "display:block;";
    void this.#load();
  }

  async #load() {
    const r = await call<Record<string, unknown>>("GET", "/config");
    if (!r.ok) {
      const msg = document.createElement("p");
      msg.style.cssText = "color:var(--omp-error);";
      msg.textContent = errText(r.data) || tt("rv.err.generic");
      this.replaceChildren(msg);
      return;
    }
    openReviewSettingsForm({
      config: r.data,
      container: this,
      onDiscard: () => void this.#load(),
      save: async (c) => {
        const res = await call("PUT", "/config", c);
        if (!res.ok) return { ok: false, message: errText(res.data) || tt("rv.err.generic") };
        showToast(tt("rv.saved"));
        return { ok: true, message: "" };
      },
    });
  }
}

if (!customElements.get("omp-review-settings-view")) customElements.define("omp-review-settings-view", ReviewSettingsView);
