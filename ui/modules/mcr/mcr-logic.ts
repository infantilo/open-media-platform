// Reine Logik der MCR-Oberfläche (UMSETZUNG 106.15): Zustände, Übergänge, Ampel nach EBU R 37, Formatanzeige, Prüfungen.
// Keine DOM-Zugriffe — alles hier ist ohne Browser testbar.

export type EventState = "planned" | "testing" | "live" | "teardown" | "done" | "cancelled";
export const STATES: EventState[] = ["planned", "testing", "live", "teardown", "done"];

/** Farbe und Rang je Zustand (Rang = Stelle im Ablauf, cancelled steht außerhalb). */
export const STATE_INFO: Record<EventState, { color: string; rank: number }> = {
  planned: { color: "var(--omp-text-dim)", rank: 0 },
  testing: { color: "var(--omp-cue)", rank: 1 },
  live: { color: "var(--omp-onair)", rank: 2 },
  teardown: { color: "var(--omp-info)", rank: 3 },
  done: { color: "var(--omp-preset)", rank: 4 },
  cancelled: { color: "var(--omp-text-disabled)", rank: -1 },
};

export const stateColor = (s: string): string => STATE_INFO[s as EventState]?.color ?? "var(--omp-text-dim)";

export type Graph = Record<string, string[]>;

/** Der nächste Schritt vorwärts im Ablauf (der Hauptknopf), sonst null. */
export function nextStep(state: string, graph: Graph): EventState | null {
  const cur = STATE_INFO[state as EventState];
  if (!cur) return null;
  const forward = (graph[state] ?? []).filter((to) => (STATE_INFO[to as EventState]?.rank ?? -1) > cur.rank);
  forward.sort((a, b) => STATE_INFO[a as EventState].rank - STATE_INFO[b as EventState].rank);
  return (forward[0] as EventState) ?? null;
}

/** Übergänge, die **nicht** der Hauptknopf sind (zurück in die Planung, Abbrechen). */
export function otherSteps(state: string, graph: Graph): EventState[] {
  const main = nextStep(state, graph);
  return (graph[state] ?? []).filter((to) => to !== main) as EventState[];
}

/** Braucht der Übergang eine Bestätigung? Alles, was auf Sendung wirkt oder etwas abbaut. */
export function needsConfirm(from: string, to: string): boolean {
  return from === "live" || to === "live" || to === "teardown" || to === "cancelled" || to === "done";
}

// ---- A/V-Versatz, Ampel nach EBU R 37 (positiv = Ton eilt dem Bild voraus) -------------------------------------------------

export type Light = "ok" | "warn" | "bad" | "none";

/** Grenzen: je Stufe +5 ms früh / −15 ms spät (grün), am Ausgang +40 / −60 ms (gelb), darüber hinaus rot. */
export const R37 = { stageEarly: 5, stageLate: -15, outEarly: 40, outLate: -60 } as const;

export function avLight(ms: number | null | undefined): Light {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "none";
  if (ms <= R37.stageEarly && ms >= R37.stageLate) return "ok";
  if (ms <= R37.outEarly && ms >= R37.outLate) return "warn";
  return "bad";
}

/** Lage des Zeigers auf der Skala −100…+80 ms in Prozent (0 … 100), begrenzt. */
export const SCALE = { min: -100, max: 80 } as const;
export function scalePct(ms: number): number {
  const p = ((ms - SCALE.min) / (SCALE.max - SCALE.min)) * 100;
  return Math.max(0, Math.min(100, p));
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "–";
  const r = Math.round(ms * 10) / 10;
  return `${r > 0 ? "+" : ""}${r.toFixed(Math.abs(r) < 100 && !Number.isInteger(r) ? 1 : 0)} ms`;
}

export function fmtConfidence(c: number | null | undefined): string {
  if (c === null || c === undefined || !Number.isFinite(c)) return "–";
  return `${Math.round(c * 100)} %`;
}

// ---- Formate ------------------------------------------------------------------------------------------------------------

export interface VideoFmt {
  width?: number;
  height?: number;
  rate?: { num: number; den: number } | string;
  scan?: string;
}

function rateOf(r: VideoFmt["rate"]): number | null {
  if (!r) return null;
  if (typeof r === "string") {
    const [a, b] = r.split("/");
    const n = Number(a);
    const d = Number(b ?? 1);
    return d > 0 && n > 0 ? n / d : null;
  }
  return r.den > 0 ? r.num / r.den : null;
}

/** „1080i50“, „720p50“, „1080p29,97“ (Zeilensprung: Halbbildrate wie im Studio üblich). */
export function fmtVideo(v: VideoFmt | null | undefined): string {
  if (!v || !v.height) return "–";
  const r = rateOf(v.rate);
  const interlaced = typeof v.scan === "string" && v.scan.startsWith("interlaced");
  const shown = r === null ? null : interlaced ? r * 2 : r;
  const rs = shown === null ? "" : Number.isInteger(Math.round(shown * 100) / 100) ? String(Math.round(shown)) : (Math.round(shown * 100) / 100).toString().replace(".", ",");
  return `${v.height}${interlaced ? "i" : "p"}${rs}`;
}

export function fmtAudio(a: { sampleRate?: number; channels?: number } | null | undefined): string {
  if (!a || !a.channels) return "–";
  const khz = a.sampleRate ? `${a.sampleRate / 1000} kHz` : "";
  return `${a.channels} ${khz}`.trim();
}

/** Stufen aus `normalize.stages` (JSON mit video/audio) → Liste. */
export function parseStages(raw: unknown): { video: string[]; audio: string[] } {
  try {
    const o = typeof raw === "string" ? JSON.parse(raw) : raw;
    const arr = (x: unknown): string[] => (Array.isArray(x) ? x.map(String) : []);
    return { video: arr((o as any)?.video), audio: arr((o as any)?.audio) };
  } catch {
    return { video: [], audio: [] };
  }
}

export type LineMode = "copy" | "convert" | "blocked" | "error" | "waiting";

export function lineMode(norm: Record<string, unknown> | undefined): LineMode {
  const s = String(norm?.["normalize.state"] ?? "");
  return s === "copy" || s === "convert" || s === "blocked" || s === "error" ? s : "waiting";
}

export const MODE_COLOR: Record<LineMode, string> = {
  copy: "var(--omp-preset)",
  convert: "var(--omp-accent-cyan)",
  blocked: "var(--omp-cue)",
  error: "var(--omp-error)",
  waiting: "var(--omp-text-disabled)",
};

// ---- Leitungen ----------------------------------------------------------------------------------------------------------

export const KINDS = ["srt", "rist", "st2110", "hls", "mxl"] as const;
export type Kind = (typeof KINDS)[number];

export interface LineDraft {
  id?: string;
  name: string;
  kind: Kind;
  transport: Record<string, unknown>;
  houseFormat?: Record<string, unknown> | null;
  avsync?: Record<string, unknown>;
  intercom?: Record<string, unknown>;
  normalize?: Record<string, unknown>;
  /** Verarbeitungsstufen dieser Leitung; fehlt = erbt vom Event/global. */
  chain?: unknown[] | null;
  monitoring?: Record<string, unknown> | null;
  record?: Record<string, unknown> | null;
}

/** Prüft eine Leitung vor dem Speichern; Rückgabe = Liste der Probleme (leer = in Ordnung). */
export function validateLine(l: LineDraft): string[] {
  const p: string[] = [];
  if (!l.name.trim()) p.push("name");
  const tr = l.transport ?? {};
  const s = (k: string) => String(tr[k] ?? "").trim();
  const ex = tr.existing as Record<string, unknown> | undefined;
  const useExisting = !!ex && !!(ex.nodeId || ex.nodeLabel || ex.videoSenderId || ex.audioSenderId || ex.videoNodeId || ex.audioNodeId || ex.dataNodeId || ex.dataSenderId);
  if (useExisting) {
    // vorhandener Node als Quelle: Adresse/Port der Leitungsart entfällt
  } else if (l.kind === "srt") {
    if (!/^srt:\/\/[^/?@]*:\d+/i.test(s("uri"))) p.push("uri");
    if (/passphrase=/i.test(s("uri"))) p.push("secret");
  } else if (l.kind === "rist") {
    if (!/^rist:\/\/.+:\d+/i.test(s("uri"))) p.push("uri");
  } else if (l.kind === "hls") {
    if (!/^https?:\/\/.+/i.test(s("url"))) p.push("url");
  } else if (l.kind === "st2110") {
    if (!/^\d+$/.test(s("videoPort")) || !/^\d+$/.test(s("audioPort"))) p.push("ports");
  }
  for (const k of ["passphrase", "password", "token", "secret"]) if (k in tr) p.push("secret");
  return [...new Set(p)];
}

export interface HouseDraft {
  video?: { width: number; height: number; rate: string; scan: string; colorspace?: string; transfer?: string; transferPolicy?: string };
  audio?: { sampleRate: number; channels: number };
}

/** Prüft das Hausformat wie der Server (gleiche Regeln, damit Fehler schon im Formular erscheinen). */
export function validateHouse(h: HouseDraft): string[] {
  const p: string[] = [];
  const v = h.video;
  if (v) {
    if (!(v.width > 0) || !(v.height > 0)) p.push("size");
    if (!["progressive", "interlaced_tff", "interlaced_bff"].includes(v.scan)) p.push("scan");
    if (v.scan.startsWith("interlaced") && v.height % 2 !== 0) p.push("interlaceHeight");
    const m = /^(\d+)(?:\/(\d+))?$/.exec(v.rate.trim());
    if (!m || Number(m[1]) <= 0 || Number(m[2] ?? 1) <= 0) p.push("rate");
  }
  const a = h.audio;
  if (a) {
    if (!(a.sampleRate >= 8000 && a.sampleRate <= 384000)) p.push("sampleRate");
    if (!(a.channels >= 1 && a.channels <= 64)) p.push("channels");
  }
  return p;
}

/** Gängige Formate zum Ausfüllen (nur Eingabehilfe; im Hausformat steht, was der Nutzer speichert). */
export const FORMAT_PRESETS: { id: string; video: NonNullable<HouseDraft["video"]> }[] = [
  { id: "1080i50", video: { width: 1920, height: 1080, rate: "25/1", scan: "interlaced_tff", colorspace: "BT709", transfer: "SDR" } },
  { id: "1080p50", video: { width: 1920, height: 1080, rate: "50/1", scan: "progressive", colorspace: "BT709", transfer: "SDR" } },
  { id: "1080p25", video: { width: 1920, height: 1080, rate: "25/1", scan: "progressive", colorspace: "BT709", transfer: "SDR" } },
  { id: "720p50", video: { width: 1280, height: 720, rate: "50/1", scan: "progressive", colorspace: "BT709", transfer: "SDR" } },
  { id: "2160p50", video: { width: 3840, height: 2160, rate: "50/1", scan: "progressive", colorspace: "BT2020", transfer: "SDR" } },
];

// ---- Zeit ---------------------------------------------------------------------------------------------------------------

/** „in 2 h 05 min“ / „seit 14 min“ relativ zu `now`; leer ohne Zeit. */
export function relTime(iso: string | undefined, now: number, lang: "de" | "en" = "de"): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return "";
  const abs = Math.abs(ms);
  const min = Math.floor(abs / 60000);
  const h = Math.floor(min / 60);
  const body = h >= 24 ? `${Math.floor(h / 24)} ${lang === "de" ? "d" : "d"}` : h > 0 ? `${h} h ${String(min % 60).padStart(2, "0")} min` : `${min} min`;
  if (lang === "de") return ms >= 0 ? `in ${body}` : `seit ${body}`;
  return ms >= 0 ? `in ${body}` : `${body} ago`;
}

/** Statuslampe der Eingangsleitung aus `contrib.state` o. Ä. */
export function inputLamp(inp: Record<string, unknown> | undefined): LineMode {
  const s = String(inp?.["contrib.state"] ?? inp?.["state"] ?? "");
  if (s === "playing" || s === "running") return "copy";
  if (s === "connecting" || s === "reconnecting" || s === "waiting") return "blocked";
  if (s === "error") return "error";
  return "waiting";
}
