// Reine Logik der Mehrkanal-Ansicht (Kapitel 96) — ohne DOM, ohne Netz, testbar.
// Ein Operator, der mehrere Playout-Channels betreut, sieht alle auf einen Blick:
// Sendestand, Restzeit, Zeitleiste, Kennzahlen; wählt Channels für den Gruppen-Start aus.

export interface ChannelItem {
  id: string;
  label: string;
  durationMs: number;
  eventType?: string;
  startType?: string;
  endType?: string;
  senderId?: string;
  available?: boolean;
  asset?: unknown;
  readiness?: string;
  children?: ChildEvent[];
}

export interface ChildEvent {
  id: string;
  type?: string;
  timing?: string;
  relativeTo?: string;
  delayMs?: number;
  durationMs?: number;
  endAfterEndMs?: number | null;
  endBeforeEndMs?: number | null;
  templateId?: string;
  target?: string;
  url?: string;
}

export interface ChildRuntime {
  itemId: string;
  id: string;
  state?: string;
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
  schedule?: { entries?: { id: string; warnings?: string[] }[] } | null;
  childEvents?: ChildRuntime[];
  operatorWait?: { kind?: string; itemId?: string; remainingMs?: number | null } | string | null;
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
  /** Hinweistext (Warnungen); leer, wenn es keinen gibt. */
  note: string;
}

/** Farbklassen eines Events — dieselben Regeln wie die Zeitleiste der Playlist selbst. */
export function blockClass(it: ChannelItem | undefined, currentItemId?: string, cuedItemId?: string, problem = false): string {
  if (!it) return "";
  const c: string[] = [];
  const ctl = it.eventType === "HOLD" || it.eventType === "JUMP";
  if (!ctl) {
    if (it.available === false) c.push("miss");
    else if ((it.asset && it.readiness === "NOT_READY") || problem) c.push("bad");
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
  opts: BlockOptions = {},
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
      cls: blockClass(byId.get(e.itemId), currentItemId, cuedItemId, problemNotes(e.itemId, opts).length > 0),
      note: problemNotes(e.itemId, opts).join("\n"),
    });
  }
  return out;
}

export interface BlockOptions {
  /** Warnungen aus dem Sendeplan je Event-ID (nur gesetzt, wenn die Option „Warnungen“ an ist). */
  warnings?: Map<string, string[]>;
  /** Laufzeitstand der Child Events (fehlgeschlagene Children zählen als Warnung, wenn `warnings` gesetzt ist). */
  childRuntime?: ChildRuntime[];
}

function problemNotes(itemId: string, o: BlockOptions): string[] {
  if (!o.warnings) return [];
  const w = [...(o.warnings.get(itemId) ?? [])];
  if (o.childRuntime?.some((c) => c.itemId === itemId && c.state === "Failed")) w.push("Child Event fehlgeschlagen");
  return w;
}

/** Warnungen je Event-ID aus dem Sendeplan (`schedule.entries[].warnings`). */
export function planWarnings(schedule: ChannelValues["schedule"]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const e of schedule?.entries ?? []) if (e.warnings && e.warnings.length) m.set(e.id, e.warnings);
  return m;
}

export interface ChildBar {
  leftPct: number;
  widthPct: number;
  label: string;
  state: string;
}

/** Zeitfenster eines Child Events relativ zum Beginn seines Events (ms) oder null (ABSOLUTE: nicht auf dieser Achse) — wie die Playlist-Zeitleiste. */
export function childSpan(c: ChildEvent, dur: number, horizon: number): [number, number] | null {
  const t = c.timing || (c.relativeTo === "END" ? "RELATIVE_TO_END" : "RELATIVE_TO_START");
  if (t === "ABSOLUTE") return null;
  const end = dur > 0 ? dur : horizon;
  const d = c.delayMs || 0;
  let a = 0;
  if (t === "RELATIVE_TO_START") a = d;
  else if (t === "RELATIVE_TO_END") a = Math.max(0, end - d);
  else if (t === "BEFORE_START") a = -d;
  else if (t === "AFTER_END") a = end + d;
  const b = t === "FULL_PRIMARY"
    ? end
    : c.endAfterEndMs != null && dur > 0
    ? dur + c.endAfterEndMs
    : c.endBeforeEndMs != null && dur > 0
    ? Math.max(a + 1, dur - c.endBeforeEndMs)
    : !c.durationMs
    ? end
    : t === "AFTER_END" || t === "BEFORE_START"
    ? a + c.durationMs
    : Math.min(end, a + c.durationMs);
  return [a, Math.max(b, a + 1)];
}

/** Child-Event-Balken in Zeilen, so verteilt, dass sich überlappende nicht verdecken (wie in der Playlist-Zeitleiste). */
export function childRows(
  items: ChannelItem[],
  tl: TimelineEntry[],
  runtime: ChildRuntime[],
  playlistNowMs: number,
  pastMs: number,
  futureMs: number,
): ChildBar[][] {
  const span = pastMs + futureMs;
  if (span <= 0) return [];
  const from = playlistNowMs - pastMs;
  const to = playlistNowMs + futureMs;
  const byId = new Map(items.map((i) => [i.id, i]));
  const spans: [number, number][][] = [];
  const rows: ChildBar[][] = [];
  for (const e of tl) {
    for (const c of byId.get(e.itemId)?.children ?? []) {
      const sp = childSpan(c, e.durationMs, Math.max(0, to - e.startMs));
      if (!sp) continue;
      const a = Math.max(e.startMs + sp[0], from);
      const b = Math.min(e.startMs + sp[1], to);
      if (b <= a) continue;
      let r = spans.findIndex((row) => row.every(([x, y]) => b <= x || a >= y));
      if (r < 0) { r = spans.length; spans.push([]); rows.push([]); }
      spans[r].push([a, b]);
      rows[r].push({
        leftPct: ((a - from) / span) * 100,
        widthPct: Math.max(0.4, ((b - a) / span) * 100),
        label: c.templateId || c.target || c.url || c.type || "",
        state: runtime.find((x) => x.itemId === e.itemId && x.id === c.id)?.state ?? "",
      });
    }
  }
  return rows;
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

// ---- Zähler: nächstes Live-/manuelles/fehlendes Event ----------------------------------------------------------------

export type UpcomingKind = "live" | "manual" | "missing";

export interface Upcoming {
  kind: UpcomingKind;
  label: string;
  /** Abstand bis zum Eintritt in ms (0 = jetzt/wartet bereits). */
  inMs: number;
  /** Manuell am Ende eines Events (Manual Hold), nicht an dessen Beginn. */
  atEnd?: boolean;
  /** Der Operator wird gerade erwartet (HOLD läuft, Manual Hold erreicht, gecued). */
  waiting?: boolean;
}

/**
 * Alle kommenden Ereignisse, die den Operator oder die Regie betreffen, nach Abstand sortiert — dieselben Regeln wie die
 * Zähler der Playlist: Live = Event mit Quelle, manuell = manueller Start oder HOLD (zusätzlich Manual Hold am Ende eines
 * Events), fehlend = Quelle nicht verfügbar. Bezug ist die Sendeposition; ohne laufendes Event gibt es keine Abstände.
 */
export function upcomingList(
  items: ChannelItem[],
  tl: TimelineEntry[],
  currentItemId: string | undefined,
  playheadMs: number,
  wait?: ChannelValues["operatorWait"],
): Upcoming[] {
  const out: Upcoming[] = [];
  const byId = new Map(items.map((i) => [i.id, i]));
  const w = typeof wait === "string" ? safeParse(wait) : wait;
  if (w && w.kind) {
    out.push({ kind: "manual", label: byId.get(w.itemId ?? "")?.label ?? "", inMs: 0, waiting: true, atEnd: w.kind === "endHold" });
  }
  const cur = currentItemId ? tl.find((e) => e.itemId === currentItemId) : undefined;
  if (!cur) return out;
  const now = cur.startMs + playheadMs;
  for (const e of tl) {
    const it = byId.get(e.itemId);
    if (!it) continue;
    const ctl = it.eventType === "HOLD" || it.eventType === "JUMP";
    if (e.index > cur.index) {
      const inMs = e.startMs - now;
      if (inMs < 0) continue;
      if (it.senderId) out.push({ kind: "live", label: it.label, inMs });
      if (it.startType === "manual" || it.eventType === "HOLD") out.push({ kind: "manual", label: it.label, inMs });
      if (!ctl && it.available === false) out.push({ kind: "missing", label: it.label, inMs });
    }
    if (e.index >= cur.index && it.endType === "manual" && !(w && w.kind && w.itemId === it.id)) {
      const inMs = e.endMs - now;
      if (inMs >= 0) out.push({ kind: "manual", label: it.label, inMs, atEnd: true });
    }
  }
  return out.sort((a, b) => a.inMs - b.inMs);
}

function safeParse(s: string): { kind?: string; itemId?: string } | null {
  try { return JSON.parse(s); } catch { return null; }
}

/** Je Art das nächste Ereignis (für die drei Zähler einer Kachel). */
export function nextByKind(list: Upcoming[]): Partial<Record<UpcomingKind, Upcoming>> {
  const out: Partial<Record<UpcomingKind, Upcoming>> = {};
  for (const u of list) out[u.kind] ??= u;
  return out;
}

export interface AttentionItem extends Upcoming {
  channel: string;
  key: string;
}

/** Kanalübergreifend: die nächsten manuellen und Live-Ereignisse (wann muss der Operator etwas tun, z. B. einen externen Regieplatz starten). */
export function attentionList(channels: { key: string; name: string; list: Upcoming[] }[], limit = 4): AttentionItem[] {
  return channels
    .flatMap((c) => c.list.filter((u) => u.kind !== "missing").map((u) => ({ ...u, channel: c.name, key: c.key })))
    .sort((a, b) => a.inMs - b.inMs)
    .slice(0, limit);
}

export type Urgency = "now" | "soon" | "later";

/** Farbstufe eines Abstands: rot ab 15 s (oder wartend), gelb ab 60 s. */
export function urgencyOf(u: { inMs: number; waiting?: boolean }): Urgency {
  if (u.waiting || u.inMs < 15_000) return "now";
  return u.inMs < 60_000 ? "soon" : "later";
}
