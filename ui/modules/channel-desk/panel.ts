// Bundle des Nodes `omp-channel-desk` (Kapitel 96): das Mehrkanal-Panel als Konsole eines Operators.
// Es zeigt genau die Playout-Channels, die der angemeldete Nutzer laut `/api/v1/me/consoles` bedienen darf
// (Rechte werden im Orchestrator aufgelöst, hier nur gelesen) und folgt Rollen, die kommen und gehen.
import { apiFetch } from "../../shell/connection.ts";
import { ChannelDesk } from "./channel-desk.ts";
import type { ConsoleEntry } from "../../shell/console-view.ts";

const REFRESH_MS = 10_000;

export class ChannelDeskPanel extends HTMLElement {
  #desk?: ChannelDesk;
  #timer?: number;
  #sig = "";

  connectedCallback() {
    this.style.cssText = "display:block;width:100%;height:100%;min-height:0;";
    this.#desk = document.createElement("omp-channel-desk") as ChannelDesk;
    this.append(this.#desk);
    void this.#refresh();
    this.#timer = setInterval(() => void this.#refresh(), REFRESH_MS) as unknown as number;
  }

  disconnectedCallback() {
    clearInterval(this.#timer);
  }

  async #refresh() {
    try {
      const res = await apiFetch("/api/v1/me/consoles");
      if (!res.ok) return;
      const body = (await res.json()) as { consoles?: ConsoleEntry[] | null };
      const entries = body.consoles ?? []; // das Panel selbst ist kein Channel und fällt bei der Prüfung heraus
      const sig = entries.map((e) => `${e.nodeRoleId}|${e.uiBundleUrl}|${e.nodeLabel}`).join(";");
      if (sig === this.#sig) return;
      this.#sig = sig;
      await this.#desk?.setEntries(entries);
    } catch { /* nächster Versuch in 10 s */ }
  }

}

if (!customElements.get("omp-channel-desk")) customElements.define("omp-channel-desk", ChannelDesk);
if (!customElements.get("omp-channel-desk-panel")) customElements.define("omp-channel-desk-panel", ChannelDeskPanel);
