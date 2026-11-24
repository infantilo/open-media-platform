// MCR-Adapter, reine Logik (Hauptkontrollraum, Kap. 106 + Stream Deck Kap. 40): Eventliste → ein Event mit Zustandswechsel,
// Quittieren und Leitungstasten. Zustandsregeln (nächster Schritt, Bestätigung) kommen aus der Oberflächenlogik des Moduls —
// ein Regelwerk, zwei Bedienwege.

import type { AdapterLayout } from "../adapter.ts";
import type { DialDef, KeyDef, KeyState } from "../render-logic.ts";
import { type Graph, needsConfirm, nextStep, otherSteps } from "../../../modules/mcr/mcr-logic.ts";

export type LineAct = "listen" | "meter" | "ack" | "pip";
export const LINE_ACTS: LineAct[] = ["listen", "meter", "ack", "pip"];
const ACT_TEXT: Record<LineAct, string> = { listen: "HÖREN", meter: "MESSGERÄT", ack: "QUITTIEREN", pip: "PIP HALTEN" };

export interface DeckAlarm { id: string; kind: string; severity: string }
export interface DeckLine { id: string; name: string; level: string; alarms: DeckAlarm[] }
export interface DeckEvent {
  id: string;
  name: string;
  state: string;
  level: string;
  access?: { view?: boolean; test?: boolean; live?: boolean; edit?: boolean };
  lines: DeckLine[];
}

export interface McrState {
  events: DeckEvent[];
  graph: Graph;
  /** Gewähltes Event (Detailseite) oder null (Eventliste). */
  sel: string | null;
  act: LineAct;
  /** Zustandswechsel, der auf die zweite Bestätigung wartet (Zielzustand). */
  armed: string | null;
  /** Warnhinweis zur Kapazität: der Wechsel nach „Test“ braucht dann ebenfalls die Bestätigung. */
  warn?: string | null;
}

export type McrAction =
  | { t: "open"; id: string }
  | { t: "back" }
  | { t: "step"; to: string; confirm: boolean }
  | { t: "ackAll" }
  | { t: "cycleAct" }
  | { t: "line"; id: string };

export interface McrLayout extends AdapterLayout {
  act: (McrAction | null)[][];
}

export const STATE_TEXT: Record<string, string> = {
  planned: "GEPLANT", testing: "TEST", live: "LIVE", teardown: "ABBAU", done: "BEENDET", cancelled: "ABGEBR.",
};

/** Darf die Person den Wechsel? Geplant ↔ Test bedient die Technik, alles andere die Leitung (ohne Angabe entscheidet der Server). */
export function canStep(ev: DeckEvent, to: string): boolean {
  const a = ev.access;
  if (!a) return true;
  return (to === "testing" || to === "planned" ? a.test : a.live) === true;
}

export function levelState(level: string): KeyState {
  return level === "bad" ? "error" : level === "warn" ? "cue" : level === "ok" ? "preset" : "off";
}

export function eventKey(ev: DeckEvent): KeyDef {
  const alarms = ev.lines.reduce((n, l) => n + l.alarms.length, 0);
  const live = ev.state === "live";
  const running = live || ev.state === "testing";
  return {
    label: ev.name,
    sub: alarms ? `${STATE_TEXT[ev.state] ?? ev.state} · ${alarms}⚠` : STATE_TEXT[ev.state] ?? ev.state,
    state: ev.level === "bad" ? "error" : live ? "onair" : ev.state === "testing" ? "cue" : "off",
    dim: !running && ev.state !== "planned",
  };
}

export function lineKey(l: DeckLine, act: LineAct): KeyDef {
  const n = l.alarms.length;
  return {
    label: l.name,
    sub: n ? `${n} Alarm${n > 1 ? "e" : ""}` : l.level === "ok" ? "OK" : l.level === "warn" ? "WARNUNG" : l.level === "bad" ? "FEHLER" : "–",
    state: n && l.level !== "bad" && l.level !== "warn" ? "cue" : levelState(l.level),
    dim: act === "ack" && n === 0,
  };
}

const arrow = (to: string) => `→ ${STATE_TEXT[to] ?? to}`;

/** Seitenaufteilung: Bedientasten stehen auf jeder Seite vorn, danach die Listeneinträge; mehrere Seiten → letzte Taste für den Broker frei. */
function paged<T>(fixed: T[], list: T[], slots: number, page: number): { items: T[]; pages: number } {
  if (fixed.length + list.length <= slots) return { items: [...fixed, ...list], pages: 1 };
  const fx = fixed.slice(0, Math.max(0, slots - 2));
  const cap = Math.max(1, slots - 1 - fx.length);
  const pages = Math.max(1, Math.ceil(list.length / cap));
  const p = Math.min(Math.max(0, page), pages - 1);
  return { items: [...fx, ...list.slice(p * cap, p * cap + cap)], pages };
}

export function layoutMcr(st: McrState, cols: number, rows: number, dialCount: number, page: number): McrLayout {
  const slots = Math.max(1, rows * cols);
  const ev = st.sel ? st.events.find((e) => e.id === st.sel) : undefined;
  type It = { key: KeyDef; act: McrAction | null };
  let fixed: It[] = [];
  let list: It[] = [];
  let dials: DialDef[];

  if (!ev) {
    list = st.events.map((e) => ({ key: eventKey(e), act: { t: "open", id: e.id } as McrAction }));
    if (!list.length) list = [{ key: { label: "Keine Events", dim: true }, act: null }];
    const live = st.events.filter((e) => e.state === "live").length;
    const bad = st.events.filter((e) => e.level === "bad").length;
    dials = [
      { label: "Events", value: String(st.events.length) },
      { label: "Live", value: String(live), dim: live === 0 },
      { label: "Fehler", value: String(bad), dim: bad === 0 },
    ];
  } else {
    const alarms = ev.lines.reduce((n, l) => n + l.alarms.length, 0);
    fixed.push({ key: { label: "ZURÜCK", sub: ev.name, icon: "◀" }, act: { t: "back" } });
    const main = nextStep(ev.state, st.graph);
    const stepKey = (to: string): It => {
      const allowed = canStep(ev, to);
      const needs = needsConfirm(ev.state, to) || (to === "testing" && !!st.warn);
      const armed = st.armed === to;
      return {
        key: armed
          ? { label: "NOCHMAL", sub: st.warn && to === "testing" ? "Kapazität knapp" : arrow(to), state: "error" }
          : { label: arrow(to), sub: needs ? "2× drücken" : undefined, state: to === main ? "preset" : "off", dim: !allowed },
        act: allowed ? { t: "step", to, confirm: needs && !armed } : null,
      };
    };
    if (main) fixed.push(stepKey(main));
    for (const to of otherSteps(ev.state, st.graph)) fixed.push(stepKey(to));
    fixed.push({
      key: { label: "QUITT. ALLE", sub: alarms ? `${alarms} offen` : "keine", state: alarms ? "error" : "off", dim: alarms === 0 },
      act: alarms && ev.access?.test !== false ? { t: "ackAll" } : null,
    });
    fixed.push({ key: { label: ACT_TEXT[st.act], sub: "Leitungstaste", state: "cue" }, act: { t: "cycleAct" } });
    list = ev.lines.map((l) => ({ key: lineKey(l, st.act), act: { t: "line", id: l.id } as McrAction }));
    dials = [
      { label: ev.name, value: STATE_TEXT[ev.state] ?? ev.state, fill: undefined },
      { label: "Alarme", value: String(alarms), dim: alarms === 0 },
      { label: "Leitungen", value: String(ev.lines.length) },
      { label: "Taste", value: ACT_TEXT[st.act] },
    ];
  }

  const { items, pages } = paged(fixed, list, slots, page);
  const keys: (KeyDef | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null));
  const act: (McrAction | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null));
  items.forEach((it, i) => {
    keys[Math.floor(i / cols)][i % cols] = it.key;
    act[Math.floor(i / cols)][i % cols] = it.act;
  });
  return { keys, act, dials: dials.slice(0, dialCount), pages };
}

export function nextAct(a: LineAct): LineAct {
  return LINE_ACTS[(LINE_ACTS.indexOf(a) + 1) % LINE_ACTS.length];
}
