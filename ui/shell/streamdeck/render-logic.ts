// Render-Engine, reine Logik (Kap. 40.3): Fingerprint-Cache + Debounce.
// Rasterisierung (Canvas → JPEG) und Gerät sind injiziert → ohne DOM testbar.

import type { DeckModel } from "./models.ts";
import { keyCount } from "./models.ts";

export type KeyState = "onair" | "preset" | "cue" | "off" | "error";

export interface KeyDef {
  label?: string;
  sub?: string;
  icon?: string;
  state?: KeyState;
  /** Farbe als Token-Name (`--omp-…`) oder Farbwert; sonst aus `state`. */
  color?: string;
  /** Gedimmt (offline/inaktiv). */
  dim?: boolean;
}

export interface DialDef {
  label: string;
  value: string;
  /** Füllstand 0..1 (Balken); fehlt → keiner. */
  fill?: number;
  dim?: boolean;
}

/** Schreibziel (Teilmenge von `DeckDevice`). */
export interface RenderTarget {
  model: DeckModel;
  setKeyImage(i: number, jpeg: Uint8Array): Promise<void>;
  setStripImage(x: number, y: number, w: number, h: number, jpeg: Uint8Array): Promise<void>;
}

export interface Rasterizer {
  key(def: KeyDef | null, model: DeckModel): Promise<Uint8Array>;
  dial(def: DialDef | null, w: number, h: number): Promise<Uint8Array>;
}

export interface RenderOptions {
  /** Wartezeit zwischen erster Änderung und Senden (Standard 60 ms). */
  debounceMs?: number;
  /** Test-Hook für Zeitgeber. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  onError?: (e: unknown) => void;
}

/** Stabiler Fingerprint: gleiche Eingabe → gleiche Zeichenkette. */
export function fingerprint(def: KeyDef | DialDef | null): string {
  if (!def) return "-";
  const o = def as unknown as Record<string, unknown>;
  return JSON.stringify(Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
}

export class DeckRenderer {
  #keys: (KeyDef | null)[];
  #dials: (DialDef | null)[];
  #sentKeys: string[];
  #sentDials: string[];
  #dirty = false;
  #timer: unknown = null;
  #flushing: Promise<void> | null = null;
  readonly stats = { keyImages: 0, stripImages: 0, flushes: 0 };

  constructor(
    private target: RenderTarget,
    private raster: Rasterizer,
    private opts: RenderOptions = {},
  ) {
    const n = keyCount(target.model);
    this.#keys = Array(n).fill(null);
    this.#dials = Array(target.model.dials).fill(null);
    // Anfangszustand „unbekannt“: erster Flush sendet alles, auch leere Tasten.
    this.#sentKeys = Array(n).fill("?");
    this.#sentDials = Array(target.model.dials).fill("?");
  }

  /** Setzt den gewünschten Zustand; fehlende Einträge = leer. */
  set(keys: (KeyDef | null | undefined)[], dials: (DialDef | null | undefined)[] = []) {
    for (let i = 0; i < this.#keys.length; i++) this.#keys[i] = keys[i] ?? null;
    for (let i = 0; i < this.#dials.length; i++) this.#dials[i] = dials[i] ?? null;
    this.#schedule();
  }

  /** Alles neu senden (z. B. nach Wiederverbinden). */
  invalidate() {
    this.#sentKeys.fill("?");
    this.#sentDials.fill("?");
    this.#schedule();
  }

  /** Wartet auf einen gerade laufenden Durchgang (Tests/Schließen). */
  async idle(): Promise<void> {
    while (this.#flushing) await this.#flushing;
  }

  /** Sofort senden (ohne Debounce). */
  async flushNow(): Promise<void> {
    this.#timer = null;
    while (this.#flushing) await this.#flushing;
    this.#flushing = this.#flush().finally(() => (this.#flushing = null));
    await this.#flushing;
  }

  #schedule() {
    this.#dirty = true;
    if (this.#timer !== null) return; // erste Änderung bestimmt den Zeitpunkt (kein ewiges Verschieben)
    const set = this.opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#timer = set(() => {
      void this.flushNow();
    }, this.opts.debounceMs ?? 60);
  }

  async #flush() {
    this.stats.flushes++;
    this.#dirty = false;
    try {
      // Erst alle geänderten Bilder parallel rastern (Encoder läuft off-thread),
      // dann der Reihe nach senden — Senden bleibt seriell (ein HID-Kanal).
      const model = this.target.model;
      const keyJobs: { i: number; fp: string; jpeg: Promise<Uint8Array> }[] = [];
      for (let i = 0; i < this.#keys.length; i++) {
        const fp = fingerprint(this.#keys[i]);
        if (fp !== this.#sentKeys[i]) keyJobs.push({ i, fp, jpeg: this.raster.key(this.#keys[i], model) });
      }
      const strip = model.strip;
      const dialJobs: { i: number; fp: string; w: number; h: number; jpeg: Promise<Uint8Array> }[] = [];
      if (strip && this.#dials.length) {
        const w = strip.w / this.#dials.length;
        for (let i = 0; i < this.#dials.length; i++) {
          const fp = fingerprint(this.#dials[i]);
          if (fp !== this.#sentDials[i]) dialJobs.push({ i, fp, w, h: strip.h, jpeg: this.raster.dial(this.#dials[i], w, strip.h) });
        }
      }
      // Fehlgeschlagene Raster-Versprechen sollen nicht als „unhandled“ enden.
      for (const j of [...keyJobs, ...dialJobs]) j.jpeg.catch(() => {});
      for (const j of keyJobs) {
        await this.target.setKeyImage(j.i, await j.jpeg);
        this.#sentKeys[j.i] = j.fp; // erst nach erfolgreichem Senden
        this.stats.keyImages++;
      }
      for (const j of dialJobs) {
        await this.target.setStripImage(j.w * j.i, 0, j.w, j.h, await j.jpeg);
        this.#sentDials[j.i] = j.fp;
        this.stats.stripImages++;
      }
    } catch (e) {
      this.opts.onError?.(e);
      this.#dirty = true; // Fehler: Rest beim nächsten Anstoß erneut versuchen
    }
    // Während des Sendens kam eine Änderung dazu → noch ein Durchgang.
    if (this.#dirty && this.#timer === null) this.#schedule();
  }
}
