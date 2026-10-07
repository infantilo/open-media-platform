import { t } from "../shell/i18n.ts";
// Grafische Audio-Routing-/Mix-/Verzögerungs-Matrix (UMSETZUNG.md
// Kapitel 23, Schritt 3) — DOM-freie Kompilierung, per `deno test`
// geprüft. Allgemeiner Baustein ("beliebige Quellkanäle auf beliebige
// Ausgangsspuren routen/mischen/verzögern"), keine Szenario-Bindung.
//
// Kompiliert zu genau demselben `{filterComplex, outputLabels}`-Paar
// wie der manuelle Filter-Graph-Builder (filter-graph-logic.ts) — die
// Audio-Matrix ist im "Format/Codec konvertieren"-Formular
// (process-step-config.ts) eine ALTERNATIVE Bedienoberfläche für
// dieselben zwei Felder (`ConvertInput.filterComplex`/
// `filterOutputLabels`), kein eigener Ausführungspfad.

// Kanal-Layout-Labels (Kapitel 25 R2, 2026-09-28) — reine Beschriftung
// für die Zeilenüberschriften der Matrix ("L"/"R"/"C" statt "Kanal 1/2/
// 3"), ändert NICHTS an compileAudioMatrix (weiterhin rein index-
// basiertes pan=c0..cN-1, s. oben) — die zugrundeliegende Kompilierung
// bleibt für denselben Zellen-Zustand identisch zu Kapitel 23. Reihen-
// folge je Layout entspricht ffmpegs/libavutils Standard-Kanalreihen-
// folge (AV_CH_LAYOUT_STEREO/5POINT1/7POINT1), keine erfundene Ordnung.
export type ChannelLayoutId = "mono" | "stereo" | "5.1" | "7.1" | "custom";

export interface ChannelLayoutDef {
  id: ChannelLayoutId;
  label: string;
  // Leer für "custom" — dort bleibt es bei der freien Kanalzahl +
  // "Kanal N"-Beschriftung wie vor Kapitel 25 R2.
  channelLabels: string[];
}

export const CHANNEL_LAYOUTS: ChannelLayoutDef[] = [
  { id: "mono", label: t("aml.ec4721"), channelLabels: [t("aml.5d9b47")] },
  { id: "stereo", label: t("aml.490585"), channelLabels: ["L", "R"] },
  { id: "5.1", label: "5.1 (6)", channelLabels: ["L", "R", "C", "LFE", "Ls", "Rs"] },
  { id: "7.1", label: "7.1 (8)", channelLabels: ["L", "R", "C", "LFE", "Lb", "Rb", "Ls", "Rs"] },
  { id: "custom", label: t("aml.64d485"), channelLabels: [] },
];

export function channelLayoutById(id: string): ChannelLayoutDef | undefined {
  return CHANNEL_LAYOUTS.find((l) => l.id === id);
}

export function channelLayoutChannelCount(id: ChannelLayoutId): number {
  return channelLayoutById(id)?.channelLabels.length ?? 0;
}

// Beschriftung einer einzelnen Zeile — fällt für "custom" oder einen
// Index außerhalb der bekannten Labels (z. B. eine freie Kanalzahl >
// Layout-Größe) auf die alte "Kanal N"-Form zurück, nie ein leeres Label.
export function channelLabel(layoutId: ChannelLayoutId, channelIndex: number): string {
  const label = channelLayoutById(layoutId)?.channelLabels[channelIndex];
  return label ?? t("aml.935327", { p0: channelIndex + 1 });
}

export interface AudioMatrixSource {
  inputPath: string; // Index 0 = primäre Eingabedatei des Konvertieren-Formulars, 1..N = additionalInputPaths
  channelCount: number;
  label?: string;
  // Nur Beschriftungs-/Voreinstellungs-Hilfe (s. o.) — optional, damit
  // ältere gespeicherte Quellen ohne dieses Feld weiter funktionieren.
  layout?: ChannelLayoutId;
}

// Eine Zelle mit `gainPercent <= 0` trägt nichts bei (= nicht
// geroutet) — die UI hält typischerweise nur Zellen mit Beitrag in der
// Liste, `compileAudioMatrix` überspringt gainPercent<=0 zusätzlich
// zur Sicherheit.
export interface AudioMatrixCell {
  sourceIndex: number;
  channelIndex: number;
  outputIndex: number;
  gainPercent: number;
  delayMs: number;
}

export interface AudioMatrixInput {
  sources: AudioMatrixSource[];
  outputCount: number;
  cells: AudioMatrixCell[];
}

export interface CompiledAudioMatrix {
  filterComplex: string;
  outputLabels: string[];
  additionalInputPaths: string[];
}

// Eine Ausgangsspur ohne jeden Beitrag wird NICHT erzeugt (kein
// stiller Platzhalter-Stream) — die UI zeigt das an, die Spuren-Zahl
// in der Ausgabedatei entspricht damit immer der Zahl tatsächlich
// belegter Spalten.
export function compileAudioMatrix(input: AudioMatrixInput): CompiledAudioMatrix {
  const parts: string[] = [];
  const perOutput = new Map<number, string[]>();

  for (const cell of input.cells) {
    if (cell.gainPercent <= 0) continue;
    const key = `${cell.sourceIndex}_${cell.channelIndex}_${cell.outputIndex}`;
    let branch = `ext${key}`;
    parts.push(`[${cell.sourceIndex}:a]pan=mono|c0=c${cell.channelIndex}[${branch}]`);
    if (cell.gainPercent !== 100) {
      const g = `g${key}`;
      parts.push(`[${branch}]volume=${(cell.gainPercent / 100).toFixed(4)}[${g}]`);
      branch = g;
    }
    if (cell.delayMs > 0) {
      const d = `d${key}`;
      parts.push(`[${branch}]adelay=${Math.round(cell.delayMs)}|all=1[${d}]`);
      branch = d;
    }
    const arr = perOutput.get(cell.outputIndex) ?? [];
    arr.push(branch);
    perOutput.set(cell.outputIndex, arr);
  }

  const outputLabels: string[] = [];
  for (let o = 0; o < input.outputCount; o++) {
    const branches = perOutput.get(o);
    if (!branches || branches.length === 0) continue;
    const outLabel = `mxout${o}`;
    if (branches.length === 1) {
      parts.push(`[${branches[0]}]anull[${outLabel}]`);
    } else {
      parts.push(`${branches.map((b) => `[${b}]`).join("")}amix=inputs=${branches.length}:duration=longest:dropout_transition=0[${outLabel}]`);
    }
    outputLabels.push(outLabel);
  }

  return {
    filterComplex: parts.join(";"),
    outputLabels,
    additionalInputPaths: input.sources.slice(1).map((s) => s.inputPath),
  };
}

// ---- Downmix-Vorlagen (Kapitel 25 R2) -----------------------------------------------------------
//
// Baukasten-konform (ARCHITECTURE.md §26.4): keine Szenario-Bindung an
// eine bestimmte Datei, nur "übliche Kanal-Layout-Kombination → sinnvolle
// Start-Zellen" — der Nutzer kann jede erzeugte Zelle danach wie jede
// andere per Hand nachjustieren. -3dB/70,7% ist der gebräuchlichste
// Koeffizient für Center-/Surround-Beimischung bei einem Stereo-Downmix
// (z. B. Dolby-Empfehlung) — LFE bleibt bewusst unberücksichtigt (auch
// gängige Praxis), dokumentiert im `help`-Text statt stillschweigend
// weggelassen.
export interface DownmixPresetRoute {
  sourceChannelIndex: number;
  outputOffset: number;
  gainPercent: number;
}

export interface DownmixPreset {
  id: string;
  label: string;
  fromLayout: ChannelLayoutId;
  outputCount: number;
  help: string;
  routes: DownmixPresetRoute[];
}

export const DOWNMIX_PRESETS: DownmixPreset[] = [
  {
    id: "mono-to-stereo",
    label: t("aml.24354f"),
    fromLayout: "mono",
    outputCount: 2,
    help: t("aml.672b84"),
    routes: [
      { sourceChannelIndex: 0, outputOffset: 0, gainPercent: 100 },
      { sourceChannelIndex: 0, outputOffset: 1, gainPercent: 100 },
    ],
  },
  {
    id: "stereo-to-mono",
    label: t("aml.f5f0a7"),
    fromLayout: "stereo",
    outputCount: 1,
    help: t("aml.5284e1"),
    routes: [
      { sourceChannelIndex: 0, outputOffset: 0, gainPercent: 70.7 },
      { sourceChannelIndex: 1, outputOffset: 0, gainPercent: 70.7 },
    ],
  },
  {
    id: "5.1-to-stereo",
    label: "5.1 → Stereo (ITU-Downmix, −3dB)",
    fromLayout: "5.1",
    outputCount: 2,
    help: t("aml.40faff"),
    routes: [
      { sourceChannelIndex: 0, outputOffset: 0, gainPercent: 100 }, // L -> Lo
      { sourceChannelIndex: 2, outputOffset: 0, gainPercent: 70.7 }, // C -> Lo
      { sourceChannelIndex: 4, outputOffset: 0, gainPercent: 70.7 }, // Ls -> Lo
      { sourceChannelIndex: 1, outputOffset: 1, gainPercent: 100 }, // R -> Ro
      { sourceChannelIndex: 2, outputOffset: 1, gainPercent: 70.7 }, // C -> Ro
      { sourceChannelIndex: 5, outputOffset: 1, gainPercent: 70.7 }, // Rs -> Ro
    ],
  },
];

export function downmixPresetsForLayout(layout: ChannelLayoutId | undefined): DownmixPreset[] {
  return DOWNMIX_PRESETS.filter((p) => p.fromLayout === layout);
}

// Reine Berechnung — das Einfügen der Zellen (ggf. unter Beibehaltung
// unberührter bestehender Zellen) ist Sache des Aufrufers (audio-
// matrix.ts), damit ein Preset gezielt nachjustierbar bleibt statt die
// ganze Matrix zu ersetzen.
export function applyDownmixPreset(preset: DownmixPreset, sourceIndex: number, outputStart: number): AudioMatrixCell[] {
  return preset.routes.map((r) => ({
    sourceIndex,
    channelIndex: r.sourceChannelIndex,
    outputIndex: outputStart + r.outputOffset,
    gainPercent: r.gainPercent,
    delayMs: 0,
  }));
}
