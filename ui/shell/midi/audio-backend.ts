// Anbindung an den Audiomischer (Kap. 93): liest `mixState` (eine Abfrage für alle Kanäle), die Live-Meldungen (Pegel, On-Air) und
// schreibt über die `channel.<id>.set*`-Methoden — dieselben Aufrufe wie die Bildschirmoberfläche (Range-Prüfung im Node).

import type { MixerActions, NudgeAction, StripInfo } from "./surface-logic.ts";

export interface MixerIO {
  getParam(name: string): Promise<unknown>;
  call(name: string, body?: Record<string, unknown>): Promise<void>;
}

interface RawChannel {
  id: string;
  label?: string;
  gainDb?: number;
  mute?: boolean;
  pfl?: boolean;
  proc?: { pan?: number };
}
interface RawAux {
  id: string;
  label?: string;
  masterDb?: number;
}

export interface ParsedMix {
  channels: StripInfo[];
  aux: { id: string; label: string; masterDb: number }[];
}

/** `mixState` → Pult-Modell. Pegel und On-Air bleiben aus dem Live-Strom (`live`). */
export function parseMixState(raw: unknown, live: Map<string, { level: number; onAir: boolean }> = new Map()): ParsedMix {
  const doc = (typeof raw === "string" ? JSON.parse(raw) : raw) as { channels?: RawChannel[]; auxBuses?: RawAux[] } | null;
  const channels = (doc?.channels ?? []).map((c): StripInfo => ({
    id: c.id,
    label: c.label ?? c.id,
    gainDb: typeof c.gainDb === "number" ? c.gainDb : null,
    mute: !!c.mute,
    pfl: !!c.pfl,
    onAir: live.get(c.id)?.onAir ?? false,
    level: live.get(c.id)?.level ?? 0,
    pan: typeof c.proc?.pan === "number" ? c.proc.pan : null,
    raw: c as unknown as Record<string, unknown>,
  }));
  const aux = (doc?.auxBuses ?? []).map((a) => ({ id: a.id, label: a.label ?? a.id, masterDb: typeof a.masterDb === "number" ? a.masterDb : 0 }));
  return { channels, aux };
}

/** Eine Live-Meldung (SSE `levelsUrl`) in die Tabelle einarbeiten. Gibt die Kanal-ID zurück, wenn sich etwas geändert hat. */
export function applyLiveMessage(live: Map<string, { level: number; onAir: boolean }>, m: { type?: string; channelId?: string | null; peak?: number; rms?: number; onAir?: boolean }): string | null {
  if (m.channelId == null) return null;
  const cur = live.get(m.channelId) ?? { level: 0, onAir: false };
  if (m.type === "dsp") {
    if (typeof m.onAir === "boolean") cur.onAir = m.onAir;
  } else if (typeof m.peak === "number") {
    cur.level = Math.max(0, Math.min(1, m.peak));
  } else return null;
  live.set(m.channelId, cur);
  return m.channelId;
}

export class AudioMixerBackend implements MixerActions {
  readonly live = new Map<string, { level: number; onAir: boolean }>();
  errors: ((e: unknown) => void)[] = [];
  /** Aux-Bus, dessen Master-Fader der Master-Fader des Pults führt (leer = keiner). */
  masterAux = "";
  setMaster?: (db: number) => void;
  /** Zugriff auf andere Nodes (Tastenbelegung mit `node`). */
  external: { call(node: string, method: string, args: Record<string, unknown>): Promise<void>; read(node: string, param: string): Promise<unknown> } | null = null;

  constructor(private io: MixerIO, masterAux = "") {
    this.setMasterTarget(masterAux);
  }

  setMasterTarget(aux: string) {
    this.masterAux = aux;
    this.setMaster = aux ? (db) => this.#call(`aux.${aux}.setMaster`, { db }) : undefined;
  }

  #call(name: string, body: Record<string, unknown>) {
    this.io.call(name, body).catch((e) => {
      for (const l of this.errors) l(e);
    });
  }

  async refresh(): Promise<{ channels: StripInfo[]; master: { db: number | null } | null; aux: ParsedMix["aux"] }> {
    const p = parseMixState(await this.io.getParam("mixState"), this.live);
    const m = this.masterAux ? p.aux.find((a) => a.id === this.masterAux) : undefined;
    return { channels: p.channels, master: m ? { db: m.masterDb } : null, aux: p.aux };
  }

  setGain(id: string, db: number) {
    this.#call(`channel.${id}.setGain`, { db });
  }
  setMute(id: string, muted: boolean) {
    this.#call(`channel.${id}.setMute`, { muted });
  }
  setPfl(id: string, enabled: boolean) {
    this.#call(`channel.${id}.setPfl`, { enabled });
  }
  setPan(id: string, pan: number) {
    this.#call(`channel.${id}.setPan`, { pan });
  }
  /** Tastenbelegung: ohne Node-Name am Audiomischer, sonst über `external` (Auflösung nach Anzeigename). */
  call(node: string, method: string, args: Record<string, unknown>) {
    if (!node) return this.#call(method, args);
    this.external?.call(node, method, args).catch((e) => this.errors.forEach((l) => l(e)));
  }
  nudge(a: NudgeAction) {
    const caller = a.node ? this.external : { call: (_n: string, m: string, x: Record<string, unknown>) => this.io.call(m, x), read: (_n: string, p: string) => this.io.getParam(p) };
    if (!caller) return;
    void runNudge(caller, a).catch((e) => this.errors.forEach((l) => l(e)));
  }
}

/** Lesen-Ändern-Schreiben: Parameter lesen, `delta` addieren, auf min/max klemmen, über die Methode zurückschreiben. */
export async function runNudge(c: { call(node: string, method: string, args: Record<string, unknown>): Promise<void>; read(node: string, param: string): Promise<unknown> }, a: NudgeAction): Promise<void> {
  const cur = await c.read(a.node, a.readParam);
  if (typeof cur !== "number") return;
  let v = cur + a.delta;
  if (a.min !== undefined) v = Math.max(a.min, v);
  if (a.max !== undefined) v = Math.min(a.max, v);
  await c.call(a.node, a.method, { ...a.args, [a.arg]: Math.round(v * 10000) / 10000 });
}
