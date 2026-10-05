// Audio-Ausgabe (Kapitel 27 / A5): Datenmodell des Dokuments `audio-rules` (Wire-Format identisch zu
// orchestrator/internal/httpapi/audio_rules_handlers.go bzw. Rust-Crate `omp-audio-rules`) und die reine
// Logik des Editors (ohne DOM, deshalb testbar).

export interface ProcessorRef { name: string; params?: Record<string, unknown> }
export interface SourceSpec { tracks?: number[]; select?: string; via?: string; chain?: ProcessorRef[] }
export interface TargetGroup { id: string; label: string; layout?: string; channels?: string[]; tags?: string[]; default?: SourceSpec }
export interface SourceTrack { n: number; layout?: string; channels?: string[]; tags?: string[] }
export interface TrackSchema { id: string; match: { format?: string; tracks?: number; path?: string }; tracks: SourceTrack[] }
export interface Mapping { id: string; label?: string; groups: Record<string, SourceSpec> }
export interface Action { use?: SourceSpec; silence?: boolean; fail?: boolean; warn?: string }
export interface Rule { id?: string; group: string; when: { missing?: string; has?: string; source?: string }; then: Action[] }
export interface AudioRulesDoc {
  outputProfile: { groups: TargetGroup[] };
  trackSchemas: TrackSchema[];
  mappings: Mapping[];
  ruleSet: { rules: Rule[] };
}

export const LAYOUTS: [string, string][] = [["mono", "Mono"], ["stereo", "Stereo"], ["5.1", "5.1"], ["7.1", "7.1"], ["custom", "Eigene Kanäle"]];

// Matrix-Prozessoren (Rust `processors::MATRIX_PROCESSORS`) mit verständlichen Namen.
export const VIA_OPTIONS: [string, string][] = [
  ["", "automatisch (gleiche Kanalzahl / Mono↔Stereo)"],
  ["upmix51", "Upmix Stereo → 5.1"],
  ["downmix", "Downmix 5.1 → Stereo"],
  ["downmix-mono", "Downmix 5.1 → Mono"],
  ["mono-to-stereo", "Mono → Stereo"],
  ["stereo-to-mono", "Stereo → Mono"],
];

const DEFAULT_CHANNELS: Record<string, string[]> = {
  mono: ["M"],
  stereo: ["L", "R"],
  "5.1": ["L", "R", "C", "LFE", "Ls", "Rs"],
  "7.1": ["L", "R", "C", "LFE", "Ls", "Rs", "Lb", "Rb"],
  custom: [],
};

export function channelNames(layout: string | undefined, channels: string[] | undefined): string[] {
  return channels && channels.length > 0 ? channels : [...(DEFAULT_CHANNELS[layout ?? "mono"] ?? [])];
}

export function parseTags(text: string): string[] {
  return text.split(/[,\s]+/).map((t) => t.trim()).filter((t) => t.length > 0);
}

export function joinTags(tags: string[] | undefined): string {
  return (tags ?? []).join(", ");
}

/** Eine Zeile im Editor („1, 2“ = Spuren, sonst Tag-Ausdruck) als Quellvorgabe; leer = keine. */
export function parseSourceText(text: string): SourceSpec | undefined {
  const t = text.trim();
  if (t === "") return undefined;
  if (/^[0-9,\s]+$/.test(t)) return { tracks: t.split(/[,\s]+/).filter(Boolean).map(Number) };
  return { select: t };
}

export function sourceText(spec: SourceSpec | undefined): string {
  if (!spec) return "";
  if (spec.tracks) return spec.tracks.join(", ");
  return spec.select ?? "";
}

export function hasBitExact(tags: string[] | undefined): boolean {
  return (tags ?? []).some((t) => t.toLowerCase() === "bitexact");
}

export function setBitExact(tags: string[] | undefined, on: boolean): string[] {
  const rest = (tags ?? []).filter((t) => t.toLowerCase() !== "bitexact");
  return on ? [...rest, "bitexact"] : rest;
}

/** Kurzform einer Quellvorgabe für Listen („Spur 1, 2“, „role:pt“, optional „über Upmix 5.1“). */
export function specSummary(spec: SourceSpec | undefined): string {
  if (!spec) return "—";
  const src = spec.tracks ? `Spur ${spec.tracks.map((n) => (n === 0 ? "–" : String(n))).join(", ")}` : spec.select ?? "?";
  const via = spec.via ? ` · ${VIA_OPTIONS.find(([v]) => v === spec.via)?.[1] ?? spec.via}` : "";
  return src + via;
}

/**
 * Matrix-Klick: Spur `track` dem Zielkanal `channel` zuordnen. Ein Zielkanal hat genau eine Quellspur;
 * erneuter Klick auf die gewählte Zelle macht den Kanal still (0). Ergebnis hat immer `channels` Einträge.
 */
export function toggleTrack(spec: SourceSpec | undefined, channel: number, track: number, channels: number): SourceSpec {
  const tracks = Array.from({ length: channels }, (_, i) => spec?.tracks?.[i] ?? 0);
  tracks[channel] = tracks[channel] === track ? 0 : track;
  const next: SourceSpec = { ...(spec ?? {}), tracks };
  delete next.select;
  return next;
}

/** Wie viele Quellspuren die Matrix zeigen soll: Maximum aus Schema, genutzten Spuren und Mindestwert. */
export function trackRowCount(schemaTracks: number, mapping: Mapping | undefined, minimum = 8): number {
  let max = Math.max(schemaTracks, minimum);
  for (const spec of Object.values(mapping?.groups ?? {})) for (const n of spec.tracks ?? []) max = Math.max(max, n);
  return max;
}

export function slug(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Eindeutige ID aus einem Namen (`name`, bei Kollision `name-2`, `name-3` …). */
export function uniqueId(label: string, existing: string[], fallback = "neu"): string {
  const base = slug(label) || fallback;
  if (!existing.includes(base)) return base;
  for (let i = 2; ; i++) if (!existing.includes(`${base}-${i}`)) return `${base}-${i}`;
}

export function moveItem<T>(arr: T[], index: number, dir: -1 | 1): T[] {
  const j = index + dir;
  if (j < 0 || j >= arr.length) return arr;
  const out = [...arr];
  [out[index], out[j]] = [out[j], out[index]];
  return out;
}

/** N Mono-Spuren `pos:1…N` (Schnellstart für ein neues Spurschema). */
export function monoTracks(count: number): SourceTrack[] {
  return Array.from({ length: count }, (_, i) => ({ n: i + 1, layout: "mono", tags: [`pos:${i + 1}`] }));
}

/** Alle in Gruppen und Schemata bekannten Tags (für Vorschlagslisten). */
export function knownTags(doc: AudioRulesDoc): string[] {
  const set = new Set<string>();
  for (const g of doc.outputProfile.groups) for (const t of g.tags ?? []) set.add(t);
  for (const s of doc.trackSchemas) for (const t of s.tracks) for (const x of t.tags ?? []) set.add(x);
  for (const l of ["mono", "stereo", "5.1", "7.1"]) set.add(`layout:${l}`);
  return [...set].sort();
}

export function actionKind(a: Action): "use" | "silence" | "fail" {
  return a.use ? "use" : a.fail ? "fail" : "silence";
}

/** Leere Regel für die angegebene Gruppe mit einer Quellaktion. */
export function newRule(group: string): Rule {
  return { id: "", group, when: {}, then: [{ use: { select: "" } }] };
}

/** Entfernt Leerfelder, die der Server als ungültig ablehnen würde (leere Ausdrücke, leere IDs). */
export function cleanDoc(doc: AudioRulesDoc): AudioRulesDoc {
  const spec = (s: SourceSpec | undefined): SourceSpec | undefined => {
    if (!s) return undefined;
    const out: SourceSpec = {};
    if (s.tracks) out.tracks = s.tracks;
    else out.select = s.select ?? "";
    if (s.via) out.via = s.via;
    if (s.chain && s.chain.length > 0) out.chain = s.chain;
    return out;
  };
  return {
    outputProfile: {
      groups: doc.outputProfile.groups.map((g) => {
        const out: TargetGroup = { id: g.id, label: g.label || g.id, layout: g.layout || "stereo" };
        if (g.layout === "custom" && g.channels && g.channels.length > 0) out.channels = g.channels;
        if (g.tags && g.tags.length > 0) out.tags = g.tags;
        const d = spec(g.default);
        if (d && (d.tracks || d.select)) out.default = d;
        return out;
      }),
    },
    trackSchemas: doc.trackSchemas.map((s) => ({
      id: s.id,
      match: Object.fromEntries(Object.entries(s.match).filter(([, v]) => v !== undefined && v !== "" && v !== 0)),
      tracks: s.tracks.map((t) => ({ n: t.n, layout: t.layout || "mono", ...(t.tags && t.tags.length > 0 ? { tags: t.tags } : {}) })),
    })),
    mappings: doc.mappings.map((m) => ({
      id: m.id,
      label: m.label || m.id,
      groups: Object.fromEntries(Object.entries(m.groups).map(([k, v]) => [k, spec(v)!]).filter(([, v]) => v)),
    })),
    ruleSet: {
      rules: doc.ruleSet.rules.map((r) => ({
        ...(r.id ? { id: r.id } : {}),
        group: r.group,
        when: Object.fromEntries(Object.entries(r.when).filter(([, v]) => v !== undefined && v !== "")),
        then: r.then.map((a) => {
          const out: Action = {};
          if (a.use) out.use = spec(a.use);
          if (a.silence) out.silence = true;
          if (a.fail) out.fail = true;
          if (a.warn) out.warn = a.warn;
          return out;
        }),
      })),
    },
  };
}

/** Wert eines Verarbeitungsschritts (z. B. gain/db, delay/ms) einer Quellvorgabe. */
export function chainParam(spec: SourceSpec | undefined, name: string, key: string): number | undefined {
  const v = spec?.chain?.find((p) => p.name === name)?.params?.[key];
  return typeof v === "number" ? v : undefined;
}

/** Setzt/entfernt einen Verarbeitungsschritt; leer oder 0 entfernt ihn (Durchgriff). */
export function setChainParam(spec: SourceSpec, name: string, key: string, value: number | undefined): void {
  const rest = (spec.chain ?? []).filter((p) => p.name !== name);
  if (value !== undefined && Number.isFinite(value) && value !== 0) rest.push({ name, params: { [key]: value } });
  if (rest.length > 0) spec.chain = rest;
  else delete spec.chain;
}

// ---- Testwerkzeug (Plan anzeigen) --------------------------------------------------------------------

export interface PlanGroup { group: string; matrix: number[][]; silent: boolean; rule?: string; failed: boolean; warnings: string[] }
export interface AudioPlan { src_channels: { track: number; name: string }[]; groups: PlanGroup[]; warnings: string[]; ok: boolean }

export interface PlanRow { label: string; text: string; tone: "ok" | "rule" | "silent" | "failed" }

/** Plan → eine lesbare Zeile je Zielgruppe (welche Spuren, gemischt?, Ersatzregel, still, Fehler). */
export function planRows(plan: AudioPlan, groupLabel: (id: string) => string): PlanRow[] {
  return plan.groups.map((g) => {
    const tracks = new Set<number>();
    g.matrix.forEach((row) => row.forEach((c, col) => { if (c) tracks.add(plan.src_channels[col].track); }));
    const mixed = g.matrix.some((row) => row.filter((c) => c).length > 1 || row.some((c) => c && c !== 1));
    const label = groupLabel(g.group);
    if (g.failed) return { label, text: "Event würde NICHT gesendet (Regel „Fehler“)", tone: "failed" };
    if (g.silent) return { label, text: "still", tone: "silent" };
    const src = `Spur ${[...tracks].sort((a, b) => a - b).join(", ")}${mixed ? " (gemischt/umgerechnet)" : ""}`;
    return { label, text: g.rule ? `${src} · Ersatz per Regel „${g.rule}“` : src, tone: g.rule ? "rule" : "ok" };
  });
}

/** Quellvarianten des Testwerkzeugs → Beschreibung für `audio-sim`. */
export function simulatedSource(kind: string, count: number, schema?: TrackSchema): { kind: "file" | "live"; tracks: SourceTrack[] } {
  switch (kind) {
    case "schema":
      return { kind: "file", tracks: schema?.tracks ?? [] };
    case "mono-n":
      return { kind: "file", tracks: monoTracks(Math.max(1, count)) };
    case "live-mono":
      return { kind: "live", tracks: [{ n: 1, layout: "mono", tags: ["role:pt"] }] };
    case "live-51":
      return { kind: "live", tracks: [{ n: 1, layout: "5.1", tags: ["role:pt"] }] };
    default:
      return { kind: "live", tracks: [{ n: 1, layout: "stereo", tags: ["role:pt"] }] };
  }
}
