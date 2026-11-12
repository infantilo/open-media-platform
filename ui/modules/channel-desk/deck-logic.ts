// Stream-Deck-Belegung des Mehrkanal-Platzes (Kapitel 96) — reine Logik, ohne DOM und Netz.
//
// Übersicht (Standard): Channel-Taste öffnet den Channel am Bildschirm; Steuerzeile mit Nächster Handlung und „GANG ROLL“.
// Untermenü Gang Roll: Channel-Tasten fügen Channels der Gruppe hinzu/entfernen sie (✓), darunter Next/Take/Next Live/
// Hold/Auto auf die Gruppe, Alle/Keine. Channel-Ansicht (ein Channel ist geöffnet): Zurück, Channel-Tasten zum Wechseln,
// Aktionen nur für diesen Channel und „GANG +/−“ (diesen Channel der Gruppe hinzufügen/entfernen).
// Die Größe kommt vom Gerät (`ctx`), nie feste Indizes; passt nicht alles auf eine Seite, wird geblättert.
import type { KeyDef } from "../../shell/streamdeck/render-logic.ts";
import { t } from "../../shell/i18n.ts";
import { fmtRemain, urgencyOf, type ChannelHealth, type GangAction } from "./multichannel-logic.ts";

export interface DeckChannel {
  key: string;
  name: string;
  health: ChannelHealth;
  remainingMs: number | null;
  onAir: boolean;
  selected: boolean;
}

export interface DeckAttention {
  key: string;
  channel: string;
  label: string;
  inMs: number;
  waiting?: boolean;
  kind: "live" | "manual";
}

export interface DeckInput {
  channels: DeckChannel[];
  openKey: string | null;
  /** Untermenü Gang Roll: Channel-Tasten fügen hinzu/entfernen statt zu öffnen. */
  gangView: boolean;
  attention?: DeckAttention;
  /** Zur Bestätigung vorgemerkte Aktion (zweiter Druck führt sie aus). */
  armed: GangAction | null;
}

export type DeckAct =
  | { t: "select"; key: string }
  | { t: "open"; key: string }
  | { t: "back" }
  | { t: "all" }
  | { t: "none" }
  | { t: "gang" }
  | { t: "info"; key: string | null }
  | { t: "action"; a: GangAction };

export interface DeckCell {
  key: KeyDef;
  act: DeckAct;
}

export const DECK_ACTIONS: { a: GangAction; label: string }[] = [
  { a: "next", label: "NEXT" },
  { a: "take", label: "TAKE" },
  { a: "nextLive", label: "N.LIVE" },
  { a: "hold", label: "HOLD" },
  { a: "auto", label: "AUTO" },
];

const STATE_OF: Record<ChannelHealth, KeyDef["state"]> = { ok: "preset", wait: "cue", warn: "error", offline: "off" };

function channelKey(c: DeckChannel, picked: boolean): KeyDef {
  return {
    label: c.name,
    sub: c.health === "offline" ? t("mc.health.offline") : c.onAir ? fmtRemain(c.remainingMs) : "",
    icon: picked ? "✓" : undefined,
    state: STATE_OF[c.health],
    dim: c.health === "offline",
  };
}

/** Alle Zellen in Reihenfolge (ohne Seiten/Raster). */
export function buildCells(input: DeckInput, cols: number): DeckCell[] {
  const cells: DeckCell[] = [];
  const open = input.openKey;
  const gang = open === null && input.gangView;
  if (open !== null || gang) cells.push({ key: { label: t("mc.deck.back"), icon: "◀" }, act: { t: "back" } });
  for (const c of input.channels) {
    cells.push({
      key: open !== null
        ? { ...channelKey(c, false), icon: c.key === open ? "▶" : undefined }
        : channelKey(c, c.selected), // Haken = gehört zur Gang-Roll-Gruppe
      act: gang ? { t: "select", key: c.key } : { t: "open", key: c.key },
    });
  }
  // Steuerzeile beginnt in einer neuen Reihe.
  while (cells.length % Math.max(cols, 1) !== 0) cells.push({ key: {}, act: { t: "info", key: null } });
  const selCount = input.channels.filter((c) => c.selected).length;
  const targets = open !== null ? 1 : selCount;
  const a = input.attention;
  if (a) {
    cells.push({
      key: {
        label: a.channel,
        sub: `${a.kind === "live" ? "●" : "✋"} ${a.waiting ? t("mc.cnt.waiting") : fmtRemain(a.inMs)}`,
        state: urgencyOf(a) === "now" ? "error" : urgencyOf(a) === "soon" ? "cue" : "off",
      },
      act: { t: "info", key: a.key },
    });
  } else {
    cells.push({ key: { label: t("mc.deck.noAttn"), dim: true }, act: { t: "info", key: null } });
  }
  if (open === null && !gang) {
    // Standardansicht: nur der Einstieg in das Untermenü.
    cells.push({
      key: { label: t("mc.deck.gang"), icon: "▸", sub: selCount > 0 ? t("mc.deck.members", { n: selCount }) : "", state: selCount > 0 ? "cue" : "off" },
      act: { t: "gang" },
    });
    return cells;
  }
  for (const { a: act, label } of DECK_ACTIONS) {
    const armed = input.armed === act;
    cells.push({
      key: {
        label,
        sub: armed ? t("mc.deck.again") : targets > 1 ? `${targets}×` : "",
        state: armed ? "cue" : "off",
        dim: targets === 0,
      },
      act: { t: "action", a: act },
    });
  }
  if (open !== null) {
    const member = input.channels.find((c) => c.key === open)?.selected ?? false;
    cells.push({
      key: { label: member ? t("mc.deck.gangRemove") : t("mc.deck.gangAdd"), icon: member ? "✓" : undefined, state: member ? "cue" : "off" },
      act: { t: "select", key: open },
    });
  } else {
    cells.push({ key: { label: t("mc.selectAll") }, act: { t: "all" } });
    cells.push({ key: { label: t("mc.selectNone") }, act: { t: "none" } });
  }
  return cells;
}

export interface DeckGrid {
  keys: (KeyDef | null)[][];
  acts: (DeckAct | null)[][];
  pages: number;
}

/** Verteilt die Zellen auf das Raster des Geräts; bei Platzmangel blättern (letzte Taste gehört dann der Shell). */
export function layoutCells(cells: DeckCell[], ctx: { cols: number; rows: number; page: number }): DeckGrid {
  const per = ctx.cols * ctx.rows;
  const pages = cells.length <= per ? 1 : Math.ceil(cells.length / Math.max(per - 1, 1));
  const size = pages > 1 ? per - 1 : per;
  const page = Math.min(Math.max(ctx.page, 0), pages - 1);
  const slice = cells.slice(page * size, page * size + size);
  const keys: (KeyDef | null)[][] = Array.from({ length: ctx.rows }, () => Array(ctx.cols).fill(null));
  const acts: (DeckAct | null)[][] = Array.from({ length: ctx.rows }, () => Array(ctx.cols).fill(null));
  slice.forEach((c, i) => {
    const r = Math.floor(i / ctx.cols);
    const k = i % ctx.cols;
    const empty = c.act.t === "info" && c.act.key === null && !c.key.label;
    keys[r][k] = empty ? null : c.key;
    acts[r][k] = empty ? null : c.act;
  });
  return { keys, acts, pages };
}

/** Wie viele Channels eine Aktion trifft: geöffneter Channel, sonst die Auswahl. */
export function actionTargets(input: DeckInput): string[] {
  return input.openKey !== null ? [input.openKey] : input.channels.filter((c) => c.selected).map((c) => c.key);
}

/** Gruppen-Aktion auf mehrere Channels braucht einen zweiten Druck (kein Dialog am Gerät möglich). */
export function needsConfirm(targets: number, armed: GangAction | null, a: GangAction): boolean {
  return targets > 1 && armed !== a;
}
