// <omp-console-view>: rollen-gescopte Konsolen-Ansicht (ARCHITECTURE.md
// §14, UMSETZUNG.md C13) — zeigt ausschließlich das/die UI-Bundle(s) der
// dem Nutzer zugewiesenen Node-Rolle(n), kein Graph, keine anderen Nodes
// sichtbar. Technisch dieselbe Bundle-Lade-Logik wie das Engineering-
// Panel (`ui-bundle.ts`), nur vollflächig statt im Parameter-Panel.
//
// Bei genau einem Eintrag wird direkt dessen Bundle gezeigt; bei mehreren
// eine schmale Tab-Leiste nur dieser Einträge (§14: "nie ein Graph").
import { mountUIBundle } from "./ui-bundle.ts";

export interface ConsoleEntry {
  workflowId: string;
  workflowLabel: string;
  nodeRoleId: string;
  nodeLabel: string;
  uiBundleUrl: string;
}

export class ConsoleView extends HTMLElement {
  #entries: ConsoleEntry[] = [];
  #activeNodeRoleId: string | null = null;
  #tabs!: HTMLDivElement;
  #panel!: HTMLDivElement;

  connectedCallback() {
    this.style.cssText = "display:flex;flex-direction:column;width:100%;height:100%;background:#181818;color:#eee;font-family:sans-serif;";

    this.#tabs = document.createElement("div");
    this.#tabs.style.cssText = "display:flex;gap:4px;padding:6px;border-bottom:1px solid #333;flex-shrink:0;";

    this.#panel = document.createElement("div");
    this.#panel.style.cssText = "flex:1;min-height:0;overflow:auto;padding:12px;";

    this.append(this.#tabs, this.#panel);
  }

  // Setzt die Konsolen-Liste dieses Nutzers (aus /api/v1/me/consoles) und
  // wählt — falls noch keine Auswahl besteht oder die bisherige Auswahl
  // weggefallen ist — einen Eintrag zum Anzeigen.
  async setEntries(entries: ConsoleEntry[], preselectNodeRoleId?: string) {
    this.#entries = entries;
    const stillValid = this.#entries.some((e) => e.nodeRoleId === this.#activeNodeRoleId);
    const preselected = preselectNodeRoleId
      ? this.#entries.find((e) => e.nodeRoleId === preselectNodeRoleId)
      : undefined;

    this.#renderTabs();

    if (entries.length === 0) {
      this.#activeNodeRoleId = null;
      this.#panel.replaceChildren();
      const p = document.createElement("p");
      p.textContent = "Keine Konsole für diesen Nutzer zugewiesen.";
      this.#panel.appendChild(p);
      return;
    }

    if (preselected) {
      await this.#activate(preselected.nodeRoleId);
    } else if (!stillValid) {
      await this.#activate(entries[0].nodeRoleId);
    }
  }

  #renderTabs() {
    this.#tabs.replaceChildren();
    this.#tabs.style.display = this.#entries.length > 1 ? "flex" : "none";
    for (const entry of this.#entries) {
      const tab = document.createElement("button");
      tab.textContent = entry.nodeLabel;
      tab.style.cssText = `cursor:pointer;padding:6px 12px;border:1px solid #555;border-radius:4px;background:${
        entry.nodeRoleId === this.#activeNodeRoleId ? "#2e7d32" : "#222"
      };color:#eee;`;
      tab.addEventListener("click", () => this.#activate(entry.nodeRoleId));
      this.#tabs.appendChild(tab);
    }
  }

  async #activate(nodeRoleId: string) {
    this.#activeNodeRoleId = nodeRoleId;
    this.#renderTabs();
    const entry = this.#entries.find((e) => e.nodeRoleId === nodeRoleId);
    this.#panel.replaceChildren();
    if (!entry) return;

    const mounted = await mountUIBundle(this.#panel, entry.uiBundleUrl);
    if (!mounted) {
      const p = document.createElement("p");
      p.textContent = `UI-Bundle für "${entry.nodeLabel}" konnte nicht geladen werden.`;
      this.#panel.appendChild(p);
    }
  }
}

if (!customElements.get("omp-console-view")) {
  customElements.define("omp-console-view", ConsoleView);
}
