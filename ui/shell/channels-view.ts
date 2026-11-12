// <omp-channels-view>: Engineering-Tab „Kanäle“ (Kapitel 96) — die Mehrkanal-Übersicht über alle Playout-Channels des
// Bestands. Der Node-Bestand wird regelmäßig neu gelesen, damit neue/entfernte Channels von selbst auftauchen.
import { apiFetch } from "./connection.ts";
import "./channel-desk.ts";
import type { ChannelDesk } from "./channel-desk.ts";
import type { ConsoleEntry } from "./console-view.ts";

interface NodeView { id: string; label?: string; instanceId?: string }

export class ChannelsView extends HTMLElement {
  #desk!: ChannelDesk;
  #timer?: number;
  #sig = "";

  connectedCallback() {
    this.style.cssText = "display:block;width:100%;height:100%;";
    this.#desk = document.createElement("omp-channel-desk") as ChannelDesk;
    this.append(this.#desk);
    void this.#refresh();
    this.#timer = setInterval(() => void this.#refresh(), 10_000) as unknown as number;
  }

  disconnectedCallback() {
    clearInterval(this.#timer);
  }

  async #refresh() {
    try {
      const res = await apiFetch("/api/v1/nodes");
      if (!res.ok) return;
      const nodes = ((await res.json()) as NodeView[] | null) ?? [];
      const entries: ConsoleEntry[] = nodes.map((n) => ({
        workflowId: "", workflowLabel: "", nodeRoleId: n.instanceId || n.id, nodeLabel: n.label || n.id,
        uiBundleUrl: `/api/v1/nodes/${n.id}`,
      }));
      const sig = entries.map((e) => `${e.nodeRoleId}|${e.uiBundleUrl}|${e.nodeLabel}`).join(";");
      if (sig === this.#sig) return;
      this.#sig = sig;
      await this.#desk.setEntries(entries);
    } catch { /* nächster Versuch in 10 s */ }
  }
}

if (!customElements.get("omp-channels-view")) {
  customElements.define("omp-channels-view", ChannelsView);
}
