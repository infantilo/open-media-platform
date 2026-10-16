// Knopf + einklappbares Panel „Stream Deck“ (Kap. 40.4), gemeinsam für
// Konsolen-Board und Einzelansicht. Panel enthält die Verbindung (echtes
// Gerät/Simulator) und gehört dem Broker (Attribut `broker`).

import { t } from "../i18n.ts";
import "./sim.ts";

export function createDeckToggle(buttonStyle: string): { button: HTMLButtonElement; panel: HTMLDivElement } {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = t("board.streamDeck");
  button.style.cssText = buttonStyle;
  const panel = document.createElement("div");
  panel.style.cssText =
    "display:none;position:fixed;right:12px;bottom:56px;width:fit-content;max-width:96vw;max-height:80vh;overflow:auto;" +
    "z-index:1000001;background:var(--omp-surface);border:1px solid var(--omp-border);border-radius:var(--omp-radius);box-shadow:0 4px 16px rgba(0,0,0,0.6);";
  button.addEventListener("click", () => {
    if (panel.style.display === "none") {
      if (!panel.firstChild) {
        const sim = document.createElement("omp-streamdeck-sim");
        sim.setAttribute("broker", "");
        panel.appendChild(sim);
      }
      panel.style.display = "block";
    } else panel.style.display = "none";
  });
  return { button, panel };
}
