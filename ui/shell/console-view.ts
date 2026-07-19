// <omp-console-view>: rollen-gescopte Konsolen-Ansicht (ARCHITECTURE.md
// §14, UMSETZUNG.md C13) — zeigt ausschließlich das/die UI-Bundle(s) der
// dem Nutzer zugewiesenen Node-Rolle(n), kein Graph, keine anderen Nodes
// sichtbar. Technisch dieselbe Bundle-Lade-Logik wie das Engineering-
// Panel (`ui-bundle.ts`), nur vollflächig statt im Parameter-Panel.
//
// Bei genau einem Eintrag wird direkt dessen Bundle gezeigt; bei mehreren
// eine schmale Tab-Leiste nur dieser Einträge (§14: "nie ein Graph").
import { mountUIBundle } from "./ui-bundle.ts";
import { pickActiveEntry } from "./console-logic.ts";

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
  // weggefallen ist — einen Eintrag zum Anzeigen. Aufrufbar auch
  // wiederholt mit einer frisch aufgelösten Liste (§7.6, Kapitel-10-
  // Ergänzung 2026-07-17: "Operator-UI muss der Übernahme unmerklich
  // folgen") — shell.ts pollt/lauscht dafür live, s. dort.
  async setEntries(entries: ConsoleEntry[], preselectNodeRoleId?: string) {
    const previousUrl = this.#activeNodeRoleId
      ? this.#entries.find((e) => e.nodeRoleId === this.#activeNodeRoleId)?.uiBundleUrl
      : undefined;

    this.#entries = entries;
    this.#renderTabs();

    if (entries.length === 0) {
      this.#activeNodeRoleId = null;
      this.#panel.replaceChildren();
      const p = document.createElement("p");
      p.textContent = "Keine Konsole für diesen Nutzer zugewiesen.";
      this.#panel.appendChild(p);
      return;
    }

    const toActivate = pickActiveEntry(entries, this.#activeNodeRoleId, previousUrl, preselectNodeRoleId);
    if (toActivate) await this.#activate(toActivate);
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

    // Kurzer Platzhalter statt einer leeren Fläche während des
    // await mountUIBundle() unten — v. a. bei einem durch §7.6 neu
    // ausgelösten Remount (Rolle jetzt auf anderer Node-ID) macht das
    // sichtbar, dass gerade übernommen wird, statt kommentarlos zu
    // flackern.
    const loading = document.createElement("p");
    loading.textContent = "Lädt …";
    loading.style.cssText = "color:#999;";
    this.#panel.appendChild(loading);

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
