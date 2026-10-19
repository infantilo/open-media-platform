// Kanalplan der Aufnahme (Kapitel 45) — reine Logik des Editors: Zeilen = Ausgabekanäle, jede Zeile verweist auf (Quelle, Kanal) oder Stille.
// Quelle 0 ist die Hauptquelle des Zeitplans, 1… sind die weiteren Quellen des Plans.

export interface PlanChannel {
  /** null = Stille. */
  input: number | null;
  /** 0-basiert. */
  channel: number;
  gainDb: number;
  label: string;
}

export interface PlanInput {
  /** `instanceId|senderLabel` wie bei der Hauptquelle. */
  key: string;
  label: string;
}

export interface AudioPlanForm {
  inputs: PlanInput[];
  channels: PlanChannel[];
}

export const MAX_INPUTS = 7;
export const MAX_CHANNELS_MXF = 32;
export const MAX_CHANNELS_OTHER = 8;
export const MIN_GAIN = -96;
export const MAX_GAIN = 24;

export function emptyPlan(): AudioPlanForm {
  return { inputs: [], channels: [] };
}

/** Alle Kanäle der Hauptquelle 1:1 (Ausgangspunkt zum Umordnen). `count` unbekannt (0) → Stereo. */
export function identityPlan(count: number): AudioPlanForm {
  const n = count > 0 ? count : 2;
  return { inputs: [], channels: Array.from({ length: n }, (_, i) => ({ input: 0, channel: i, gainDb: 0, label: "" })) };
}

export function addChannel(p: AudioPlanForm): AudioPlanForm {
  return { ...p, channels: [...p.channels, { input: null, channel: 0, gainDb: 0, label: "" }] };
}

export function removeChannel(p: AudioPlanForm, i: number): AudioPlanForm {
  return { ...p, channels: p.channels.filter((_, k) => k !== i) };
}

/** Zeile um `delta` (−1/+1) verschieben; außerhalb der Liste: unverändert. */
export function moveChannel(p: AudioPlanForm, i: number, delta: number): AudioPlanForm {
  const j = i + delta;
  if (i < 0 || j < 0 || i >= p.channels.length || j >= p.channels.length) return p;
  const c = [...p.channels];
  [c[i], c[j]] = [c[j], c[i]];
  return { ...p, channels: c };
}

export function setChannel(p: AudioPlanForm, i: number, patch: Partial<PlanChannel>): AudioPlanForm {
  return { ...p, channels: p.channels.map((c, k) => (k === i ? { ...c, ...patch } : c)) };
}

export function addInput(p: AudioPlanForm, input: PlanInput): AudioPlanForm {
  return p.inputs.length >= MAX_INPUTS ? p : { ...p, inputs: [...p.inputs, input] };
}

/** Weitere Quelle entfernen: Zeilen, die sie verwenden, werden still; Verweise auf spätere Quellen rücken nach. */
export function removeInput(p: AudioPlanForm, i: number): AudioPlanForm {
  const gone = i + 1;
  return {
    inputs: p.inputs.filter((_, k) => k !== i),
    channels: p.channels.map((c) => (c.input === gone ? { ...c, input: null, channel: 0 } : c.input !== null && c.input > gone ? { ...c, input: c.input - 1 } : c)),
  };
}

/** Kanalzahl der Quelle `input` laut `counts` (Index = Quelle; 0 = unbekannt). */
export function channelsOf(counts: number[], input: number | null): number {
  return input === null ? 0 : (counts[input] ?? 0);
}

export interface PlanProblem {
  key: string;
  params?: Record<string, string | number>;
}

/** Prüft den Plan wie der Server (Kanalzahl nur, wenn bekannt). `ext` = Dateiendung des Profils. */
export function validatePlan(p: AudioPlanForm, counts: number[], ext: string): PlanProblem[] {
  const out: PlanProblem[] = [];
  if (p.channels.length === 0) return [{ key: "ing.ap.p.none" }];
  const limit = ext.toLowerCase() === ".mxf" ? MAX_CHANNELS_MXF : MAX_CHANNELS_OTHER;
  if (p.channels.length > limit) out.push({ key: "ing.ap.p.tooMany", params: { max: limit } });
  let mapped = 0;
  p.channels.forEach((c, n) => {
    if (c.input === null) return;
    mapped++;
    const cnt = channelsOf(counts, c.input);
    if (cnt > 0 && c.channel >= cnt) out.push({ key: "ing.ap.p.range", params: { n: n + 1, src: c.input + 1, cnt } });
    if (!Number.isFinite(c.gainDb) || c.gainDb < MIN_GAIN || c.gainDb > MAX_GAIN) out.push({ key: "ing.ap.p.gain", params: { n: n + 1 } });
  });
  if (mapped === 0) out.push({ key: "ing.ap.p.allSilent" });
  return out;
}

/** Nutzlast für die API (`audio`) oder undefined, wenn kein Plan. `labelOf`: Anzeigename einer weiteren Quelle. */
export function planToPayload(p: AudioPlanForm | null): Record<string, unknown> | undefined {
  if (!p || p.channels.length === 0) return undefined;
  return {
    inputs: p.inputs.map((i) => {
      const [instanceId, senderLabel] = i.key.split("|");
      return { instanceId, senderLabel: senderLabel || undefined, label: i.label || undefined };
    }),
    channels: p.channels.map((c) => ({ input: c.input, channel: c.channel, gainDb: c.gainDb || 0, label: c.label.trim() || undefined })),
  };
}

/** Formular aus dem gespeicherten Plan (Antwort der API). */
export function planFromServer(a: { inputs?: { instanceId?: string; senderLabel?: string; label?: string }[]; channels?: { input: number | null; channel?: number; gainDb?: number; label?: string }[] } | undefined | null): AudioPlanForm | null {
  if (!a || !a.channels?.length) return null;
  return {
    inputs: (a.inputs ?? []).map((i) => ({ key: `${i.instanceId ?? ""}|${i.senderLabel ?? ""}`, label: i.label ?? "" })),
    channels: a.channels.map((c) => ({ input: c.input ?? null, channel: c.channel ?? 0, gainDb: c.gainDb ?? 0, label: c.label ?? "" })),
  };
}

/** Kurzbeschreibung für Listen: „4 Kanäle · 2 Quellen“. */
export function planSummary(a: { inputs?: unknown[]; channels?: unknown[] } | undefined | null): { channels: number; sources: number } | null {
  if (!a || !a.channels?.length) return null;
  return { channels: a.channels.length, sources: 1 + (a.inputs?.length ?? 0) };
}
