// Broker-Logik (Kap. 40.4): Kopfzeile (Home + Tabs + Blättern) und
// Komposition mit dem Inhalt des aktiven Tabs. Rein, ohne DOM/Gerät.

import type { AdapterLayout } from "./adapter.ts";
import type { DeckModel } from "./models.ts";
import type { DialDef, KeyDef } from "./render-logic.ts";

export interface TabInfo {
  id: string;
  label: string;
}

export type Press =
  | { kind: "none" }
  | { kind: "home" }
  | { kind: "tab"; id: string }
  | { kind: "tabPage" }
  | { kind: "content"; row: number; col: number }
  | { kind: "contentPage" };

export interface Composed {
  keys: (KeyDef | null)[]; // flach, Zeile für Zeile
  presses: Press[];
  dials: (DialDef | null)[];
  tabPages: number;
  contentPages: number;
}

/** Tabs pro Kopfzeilen-Seite: Home belegt Spalte 0; bei Überlauf eine Taste „weiter“. */
export function tabSlots(cols: number, tabCount: number): number {
  const all = cols - 1;
  return tabCount > all ? Math.max(1, all - 1) : all;
}

export function composeLayout(
  model: DeckModel,
  tabs: TabInfo[],
  active: string | null,
  tabPage: number,
  content: AdapterLayout | null,
  contentPage: number,
): Composed {
  const { cols, rows } = model;
  const keys: (KeyDef | null)[] = Array(cols * rows).fill(null);
  const presses: Press[] = Array(cols * rows).fill({ kind: "none" });

  keys[0] = { icon: "⌂", label: "Home", state: active === null ? "preset" : "off" };
  presses[0] = { kind: "home" };

  const slots = tabSlots(cols, tabs.length);
  const tabPages = Math.max(1, Math.ceil(tabs.length / slots));
  const tp = Math.min(Math.max(0, tabPage), tabPages - 1);
  tabs.slice(tp * slots, tp * slots + slots).forEach((tab, i) => {
    keys[1 + i] = { label: tab.label, state: tab.id === active ? "preset" : "off" };
    presses[1 + i] = { kind: "tab", id: tab.id };
  });
  if (tabs.length > cols - 1 && cols >= 3) {
    keys[cols - 1] = { icon: "⇄", label: `${tp + 1}/${tabPages}` };
    presses[cols - 1] = { kind: "tabPage" };
  }

  const contentRows = rows - 1;
  let contentPages = 1;
  let dials: (DialDef | null)[] = [];
  if (active === null) {
    // Home: nur Tabs, die in der Kopfzeile (aktuelle Seite) keinen Platz haben — sonst doppelt.
    const shown = new Set(tabs.slice(tp * slots, tp * slots + slots).map((x) => x.id));
    tabs.filter((x) => !shown.has(x.id)).slice(0, cols * contentRows).forEach((tab, i) => {
      const idx = cols + i;
      keys[idx] = { label: tab.label, state: "off" };
      presses[idx] = { kind: "tab", id: tab.id };
    });
  } else if (content) {
    for (let r = 0; r < contentRows; r++) {
      for (let c = 0; c < cols; c++) {
        const k = content.keys[r]?.[c];
        if (k) {
          keys[(r + 1) * cols + c] = k;
          presses[(r + 1) * cols + c] = { kind: "content", row: r, col: c };
        }
      }
    }
    contentPages = Math.max(1, content.pages ?? 1);
    if (contentPages > 1) {
      const last = cols * rows - 1;
      keys[last] = { icon: "⇄", label: `${Math.min(contentPage, contentPages - 1) + 1}/${contentPages}` };
      presses[last] = { kind: "contentPage" };
    }
    dials = content.dials ?? [];
  } else {
    // aktiver Tab ohne Inhalt (lädt noch)
    keys[cols] = { label: "…", dim: true };
  }
  return { keys, presses, dials, tabPages, contentPages };
}

/** Fasst Dial-Drehungen zusammen: Summe je Dial, wird periodisch abgeholt. */
export class DialCoalescer {
  #sum = new Map<number, number>();
  add(i: number, delta: number) {
    this.#sum.set(i, (this.#sum.get(i) ?? 0) + delta);
  }
  take(): [number, number][] {
    const out = [...this.#sum].filter(([, d]) => d !== 0);
    this.#sum.clear();
    return out;
  }
}
