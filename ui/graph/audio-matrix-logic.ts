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

export interface AudioMatrixSource {
  inputPath: string; // Index 0 = primäre Eingabedatei des Konvertieren-Formulars, 1..N = additionalInputPaths
  channelCount: number;
  label?: string;
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
