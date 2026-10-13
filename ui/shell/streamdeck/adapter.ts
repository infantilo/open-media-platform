// Adapter-Schnittstelle (Kap. 40.1/40.4, docs/ENTWURF-STREAMDECK.md §3).
// Ein Node-UI-Element darf eine Eigenschaft `streamDeck` bereitstellen.

import type { DialDef, KeyDef } from "./render-logic.ts";

export interface LayoutContext {
  cols: number;
  /** Zeilen UNTER der Kopfzeile. */
  rows: number;
  dials: number;
  page: number;
}

export interface AdapterLayout {
  keys: (KeyDef | null)[][]; // [zeile][spalte]
  dials?: (DialDef | null)[];
  /** Anzahl Seiten (>1: der Broker belegt die letzte Taste mit „Seite weiter“). */
  pages?: number;
}

export interface StreamDeckAdapter {
  getLayout(ctx: LayoutContext): AdapterLayout;
  onKey(row: number, col: number, down: boolean): void;
  onDial?(index: number, delta: number): void;
  onDialPress?(index: number, down: boolean): void;
  /** Wird alle ~1,5 s für den aktiven Tab aufgerufen (Werte nachladen). */
  refresh?(): void | Promise<void>;
  dispose?(): void;
}

export const RELAYOUT_EVENT = "omp-streamdeck-relayout";

/** Liest den optionalen Adapter eines Node-UI-Elements. */
export function adapterOf(el: Element | null | undefined): StreamDeckAdapter | null {
  const a = (el as unknown as { streamDeck?: StreamDeckAdapter } | null | undefined)?.streamDeck;
  return a && typeof a.getLayout === "function" && typeof a.onKey === "function" ? a : null;
}
