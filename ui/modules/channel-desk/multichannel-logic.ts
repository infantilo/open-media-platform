// Reine Logik der Mehrkanal-Ansicht (Kapitel 96) — ohne DOM, ohne Netz, testbar.
// Ein Operator, der mehrere Playout-Channels betreut, sieht alle auf einen Blick:
// Sendestand, Restzeit, Zeitleiste, Kennzahlen; wählt Channels für den Gruppen-Start aus.

export interface ChannelItem {
  id: string;
  label: string;
  durationMs: number;
  eventType?: string;
  startType?: string;
  senderId?: string;
  available?: boolean;
  asset?: unknown;
  readiness?: string;
}

export interface ChannelValues {
  items?: ChannelItem[];
  currentItemId?: string;
  cuedItemId?: string;
  mode?: string;
  connected?: boolean;
  playheadPositionMs?: number;
  currentDurationMs?: number;
  channelName?: string;
  operatorWait?: { kind?: string; remainingMs?: number | null } | string | null;
}

export interface TimelineEntry {
  index: number;
  itemId: string;
  startMs: number;
  durationMs: number;
  endMs: number;
}

export type ChannelHealth = "ok" | "wait" | "warn" | "offline";

export interface ChannelSummary {
  name: string;
  mode: string;
  onAir: string;
  nextLabel: string;
  remainingMs: number | null;
  progress: number; // 0..1 des laufenden Events
  waitKind: string; // "" | hold | endHold | manualStart | cued
  itemCount: number;
  remainingTotalMs: number; // Rest der Playlist ab jetzt
  health: ChannelHealth;
}

export function waitKindOf(w: ChannelValues["operatorWait"]): string {
  if (!w) return "";
  if (typeof w === "string") {
    try { return waitKindOf(JSON.parse(w)); } catch { return w; }
  }
  return w.kind ?? "";
}

/** Verdichtet die gelesenen Parameter eines Channels zu den Anzeigewerten der Kachel. */
export function summarize(v: ChannelValues | null, fallbackName: string): ChannelSummary {
  if (!v || v.connected === false) {
    return {
      name: v?.channelName || fallbackName, mode: "", onAir: "", nextLabel: "", remainingMs: null, progress: 0,
      waitKind: "", itemCount: v?.items?.length ?? 0, remainingTotalMs: 0, health: "offline",
    };
  }
  const items = v.items ?? [];
  const idx = items.findIndex((i) => i.id === v.currentItemId);
  const cur = idx >= 0 ? items[idx] : undefined;
  const dur = v.currentDurationMs || cur?.durationMs || 0;
  const pos = v.playheadPositionMs ?? 0;
  const remainingMs = cur && dur > 0 ? Math.max(0, dur - pos) : null;
  const next = idx >= 0 ? items[idx + 1] : v.cuedItemId ? items.find((i) => i.id === v.cuedItemId) : items[0];
  const waitKind = waitKindOf(v.operatorWait);
  let remainingTotalMs = remainingMs ?? 0;
  for (let i = idx + 1; i < items.length && idx >= 0; i++) remainingTotalMs += items[i].durationMs || 0;
  let health: ChannelHealth = "ok";
  if (!cur) health = "warn"; // nichts auf Sendung
  else if (waitKind) health = "wait";
  else if (remainingMs !== null && remainingMs < 10_000 && !next) health = "warn"; // läuft leer
  return {
    name: v.channelName || fallbackName,
    mode: v.mode ?? "",
    onAir: cur?.label ?? "",
    nextLabel: next?.label ?? "",
    remainingMs,
    progress: dur > 0 ? Math.min(1, pos / dur) : 0,
    waitKind,
    itemCount: items.length,
    remainingTotalMs,
    health,
  };
}

export interface TimelineBlock {
  id: string;
  label: string;
  leftPct: number;
  widthPct: number;
  current: boolean;
  /** Farbklassen wie in der Playlist-Zeitleiste: onair, cued, live, ctl, fix, miss, bad (leer = geplant). */
  cls: string;
}

/** Farbklassen eines Events — dieselben Regeln wie die Zeitleiste der Playlist selbst. */
export function blockClass(it: ChannelItem | undefined, currentItemId?: string, cuedItemId?: string): string {
  if (!it) return "";
  const c: string[] = [];
  const ctl = it.eventType === "HOLD" || it.eventType === "JUMP";
  if (!ctl) {
    if (it.available === false) c.push("miss");
    else if (it.asset && it.readiness === "NOT_READY") c.push("bad");
  }
  if (it.id === currentItemId) c.push("onair");
  else if (it.id === cuedItemId) c.push("cued");
  if (it.startType === "fixtime") c.push("fix");
  if (it.senderId) c.push("live");
  if (ctl) c.push("ctl");
  return c.join(" ");
}

/**
 * Zeitleiste für ein Fenster `[-pastMs, +futureMs]` um die Sendeposition.
 * `tl` = Fenster des Nodes (`/timeline/window`), `playlistNowMs` = Playlist-Zeit der Sendeposition
 * (Beginn des laufenden Events + Playhead).
 */
export function buildBlocks(
  items: ChannelItem[],
  tl: TimelineEntry[],
  playlistNowMs: number,
  currentItemId: string | undefined,
  pastMs: number,
  futureMs: number,
  cuedItemId?: string,
): TimelineBlock[] {
  const span = pastMs + futureMs;
  if (span <= 0) return [];
  const from = playlistNowMs - pastMs;
  const to = playlistNowMs + futureMs;
  const byId = new Map(items.map((i) => [i.id, i]));
  const out: TimelineBlock[] = [];
  for (const e of tl) {
    if (e.endMs <= from || e.startMs >= to) continue;
    const s = Math.max(e.startMs, from);
    const f = Math.min(e.endMs, to);
    out.push({
      id: e.itemId,
      label: byId.get(e.itemId)?.label ?? "",
      leftPct: ((s - from) / span) * 100,
      widthPct: Math.max(0.4, ((f - s) / span) * 100),
      current: e.itemId === currentItemId,
      cls: blockClass(byId.get(e.itemId), currentItemId, cuedItemId),
    });
  }
  return out;
}

export function nowOffsetPct(pastMs: number, futureMs: number): number {
  const span = pastMs + futureMs;
  return span > 0 ? (pastMs / span) * 100 : 0;
}

/**
 * Bezugspunkt der Zeitleiste in Playlist-Zeit — wie die Zeitleiste der Playlist selbst: laufendes Event + Playhead,
 * sonst Beginn des gecueten Events, sonst des ersten. So zeigt auch ein Channel ohne Sendung seine geplanten Balken.
 */
export function playlistNow(tl: TimelineEntry[], currentItemId: string | undefined, playheadMs: number, cuedItemId?: string): number | null {
  const cur = currentItemId ? tl.find((x) => x.itemId === currentItemId) : undefined;
  if (cur) return cur.startMs + playheadMs;
  const cued = cuedItemId ? tl.find((x) => x.itemId === cuedItemId) : undefined;
  return (cued ?? tl[0])?.startMs ?? null;
}

/** Anteil des Fensters vor dem Bezugspunkt (wie in der Playlist-Zeitleiste). */
export const TIMELINE_PAST_SHARE = 0.06;

export function fmtRemain(ms: number | null): string {
  if (ms === null) return "–:––";
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}

export type GangAction = "next" | "take" | "nextLive" | "hold" | "auto";

/** Aufruf je Channel für eine Gruppen-Aktion: Methode oder Parameter. */
export function gangCall(a: GangAction): { kind: "method"; name: string } | { kind: "param"; name: string; value: string } {
  switch (a) {
    case "hold": return { kind: "param", name: "mode", value: "hold" };
    case "auto": return { kind: "param", name: "mode", value: "auto" };
    default: return { kind: "method", name: a };
  }
}

export interface GangResult {
  channel: string;
  ok: boolean;
  error?: string;
}

export function summarizeGang(results: GangResult[]): { ok: number; failed: GangResult[] } {
  return { ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok) };
}

/** Auswahl nach Neuaufbau der Liste: nur noch vorhandene Channels bleiben ausgewählt. */
export function pruneSelection(selected: Set<string>, existing: string[]): Set<string> {
  const have = new Set(existing);
  return new Set([...selected].filter((s) => have.has(s)));
}

/** Nächster/vorheriger Channel für die Tastatur (Strg+Alt+←/→), ringförmig. */
export function stepChannel(ids: string[], current: string | null, delta: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const i = current ? ids.indexOf(current) : -1;
  if (i < 0) return ids[delta === 1 ? 0 : ids.length - 1];
  return ids[(i + delta + ids.length) % ids.length];
}

/** Node-ID aus der Konsolen-`uiBundleUrl` (`/api/v1/nodes/<id>`). */
export function nodeIdFromBundleUrl(url: string): string {
  return url.replace(/\/+$/, "").split("/").pop() ?? "";
}

export interface AxisTick {
  leftPct: number;
  epochMs: number;
}

/** Zeitmarken der gemeinsamen Achse (Wanduhr), auf runde Minuten, höchstens ~8 Stück. */
export function axisTicks(nowEpochMs: number, pastMs: number, futureMs: number): AxisTick[] {
  const span = pastMs + futureMs;
  if (span <= 0) return [];
  const stepMin = [1, 2, 5, 10, 15, 30, 60].find((m) => span / (m * 60_000) <= 8) ?? 60;
  const step = stepMin * 60_000;
  const from = nowEpochMs - pastMs;
  const out: AxisTick[] = [];
  for (let t = Math.ceil(from / step) * step; t <= nowEpochMs + futureMs; t += step) {
    out.push({ leftPct: ((t - from) / span) * 100, epochMs: t });
  }
  return out;
}
