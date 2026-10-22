// Intercom-Layout fürs Stream Deck (Kapitel 47.10): reine Funktion Zustand → Tasten. Die Tasten steuern die eigene
// Sprechstelle des Nutzers über die Vertragsrolle `deck.command` des Intercom-Dienstes (docs/CONTRACT-INTERCOM.md); das Mikrofon bleibt im Browser-Panel (Tab).

import type { DialDef, KeyDef } from "../../../shell/streamdeck/render-logic.ts";

export interface DeckChannel {
  id: number;
  name: string;
  kind?: string;
  talk_allowed: boolean;
  talk: boolean;
  listen: boolean;
  listen_on: boolean;
  level: number;
  speakers: number[];
}
export interface DeckParty {
  id: number;
  name: string;
  online: boolean;
  speaking: boolean;
  dnd?: boolean;
}
export interface DeckState {
  me: { id: number; muted: boolean; forced: boolean; force: boolean; dnd?: boolean };
  channels: DeckChannel[];
  parties: DeckParty[];
}

/** Befehl an die Sprechstelle (wie die Nachrichten des Datenkanals). */
export type Cmd = Record<string, unknown>;
export interface Press {
  down?: Cmd;
  up?: Cmd;
  /** Nur lokal: Rasten-Betrieb umschalten. */
  toggleLatch?: boolean;
}

export interface IntercomLayout {
  keys: (KeyDef | null)[][];
  act: (Press | null)[][];
  dials: (DialDef | null)[];
  dialAct: ({ ch: number; level: number; listenOn: boolean } | null)[];
  pages: number;
}

interface Item {
  key: KeyDef;
  press: Press;
}

export function itemsFor(s: DeckState, latch: boolean): Item[] {
  const items: Item[] = [];
  const me = s.me;
  items.push({
    key: { label: me.forced ? "Gesperrt" : me.muted ? "Stumm" : "Mikro", sub: me.forced ? "On Air" : undefined, state: me.forced || me.muted ? "error" : "off", dim: me.forced },
    press: me.forced ? {} : { down: { t: "mute", on: !me.muted } },
  });
  items.push({ key: { label: "Nicht stören", state: me.dnd ? "preset" : "off" }, press: { down: { t: "dnd", on: !me.dnd } } });
  items.push({ key: { label: "Rasten", sub: latch ? "an" : "Halten", state: latch ? "preset" : "off" }, press: { toggleLatch: true } });
  if (me.force) {
    items.push({ key: { label: "Alle rufen", state: "off" }, press: { down: { t: "call", to: "all", on: true }, up: { t: "call", on: false } } });
  }
  for (const c of s.channels) {
    const others = c.speakers.filter((id) => id !== me.id);
    const sub = others.length ? (s.parties.find((p) => p.id === others[0])?.name ?? "…") : c.talk_allowed ? "Sprechen" : "nur Hören";
    items.push({
      key: { label: c.name, sub, state: c.talk ? "onair" : others.length ? "cue" : "off", dim: !c.talk_allowed || me.forced },
      press: !c.talk_allowed || me.forced
        ? {}
        : latch
        ? { down: { t: "talk", ch: c.id, on: !c.talk } }
        : { down: { t: "talk", ch: c.id, on: true }, up: { t: "talk", ch: c.id, on: false } },
    });
  }
  for (const p of s.parties) {
    if (p.id === me.id) continue;
    items.push({
      key: { label: p.name, sub: p.dnd ? "nicht stören" : p.online ? "rufen" : "offline", state: p.speaking ? "cue" : "off", dim: !p.online || me.forced },
      press: !p.online || me.forced ? {} : { down: { t: "call", to: [p.id], on: true }, up: { t: "call", on: false } },
    });
  }
  for (const c of s.channels.filter((x) => x.listen)) {
    items.push({
      key: { label: `Hören ${c.name}`, sub: `${Math.round(c.level * 100)} %`, state: c.listen_on ? "preset" : "off" },
      press: { down: { t: "listen", ch: c.id, on: !c.listen_on } },
    });
  }
  return items;
}

export function layoutIntercom(s: DeckState, cols: number, rows: number, dialCount: number, page: number, latch: boolean): IntercomLayout {
  const size = Math.max(1, cols * rows);
  const items = itemsFor(s, latch);
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(0, page), pages - 1);
  const keys: (KeyDef | null)[][] = Array.from({ length: rows }, () => Array<KeyDef | null>(cols).fill(null));
  const act: (Press | null)[][] = Array.from({ length: rows }, () => Array<Press | null>(cols).fill(null));
  items.slice(p * size, (p + 1) * size).forEach((it, i) => {
    keys[Math.floor(i / cols)][i % cols] = it.key;
    act[Math.floor(i / cols)][i % cols] = it.press;
  });
  const dials: (DialDef | null)[] = [];
  const dialAct: IntercomLayout["dialAct"] = [];
  s.channels.filter((c) => c.listen).slice(0, dialCount).forEach((c) => {
    dials.push({ label: c.name, value: `${Math.round(c.level * 100)} %`, fill: Math.min(1, c.level / 2) });
    dialAct.push({ ch: c.id, level: c.level, listenOn: c.listen_on });
  });
  return { keys, act, dials, dialAct, pages };
}

/** Neuer Hörpegel nach einer Drehung (0…2, Schritt 4 %). */
export function nudgedLevel(level: number, delta: number): number {
  return Math.round(Math.min(2, Math.max(0, level + delta * 0.04)) * 100) / 100;
}
