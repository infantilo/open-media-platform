// Reine Logik des Startdialogs im Node-Katalog des Flow-Editors (ohne DOM, testbar).

export interface StartForm {
  /** Anzeigename (leer = automatisch). */
  name: string;
  /** Zielhost ("" = lokal). */
  hostId: string;
  /** Capture-Karte: Hersteller der gewählten Anschlüsse (`cardType`) und ihre Port-IDs (leer = nicht zutreffend). */
  ioCardType: string;
  ioPorts: string[];
  /** Eingaben je Option (Schlüssel → Text); leere Felder bedeuten „Standard“. */
  options: Record<string, string>;
}

export interface StartBody {
  type: string;
  version?: string;
  hostId?: string;
  label?: string;
  requiredIoPort?: { cardType: string; ports: string[] };
  options?: Record<string, string>;
}

/** Nur ausgefüllte Optionen (getrimmt) — der Rest bleibt beim Standard bzw. beim Wert des Node-Typs. */
export function filledOptions(options: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(options)) {
    const t = v.trim();
    if (t !== "") out[k] = t;
  }
  return out;
}

/** Anfragekörper für `POST /api/v1/instances` aus Katalogeintrag und Formular. */
export function buildStartBody(type: string, version: string | undefined, f: StartForm): StartBody {
  const body: StartBody = { type };
  if (version) body.version = version;
  if (f.hostId) body.hostId = f.hostId;
  const name = f.name.trim();
  if (name) body.label = name;
  if (f.ioPorts.length > 0) body.requiredIoPort = { cardType: f.ioCardType, ports: f.ioPorts };
  const opts = filledOptions(f.options);
  if (Object.keys(opts).length > 0) body.options = opts;
  return body;
}

/** Was ein leeres Feld bedeutet: der für den Node-Typ gespeicherte Wert, sonst der Standard des Nodes. */
export function emptyMeaning(o: { value?: string; default?: string }): { text: string; source: "type" | "default" | "node" } {
  if (o.value) return { text: o.value, source: "type" };
  if (o.default) return { text: o.default, source: "default" };
  return { text: "", source: "node" };
}

/** Lässt der Dialog überhaupt etwas einzustellen übrig (sonst genügt eine Bestätigung)? */
export function needsDialogFields(hasHosts: boolean, optionCount: number, ioPort: boolean): boolean {
  return hasHosts || optionCount > 0 || ioPort;
}

// ---- Auflösung und Bildrate als Auswahl statt vier Zahlenfelder ----
// Nutzerfund 2026-10-27: „Auswahl für Höhe, Breite, Framerate ist nicht intuitiv“ — wer 1080p25 will, soll nicht Breite, Höhe, Zähler und Nenner einzeln kennen müssen.

export interface Resolution { w: number; h: number; label: string }
export interface Rate { num: number; den: number; label: string }

export const RESOLUTIONS: Resolution[] = [
  { w: 3840, h: 2160, label: "3840 × 2160 (UHD)" },
  { w: 1920, h: 1080, label: "1920 × 1080 (Full HD)" },
  { w: 1280, h: 720, label: "1280 × 720 (HD)" },
  { w: 960, h: 540, label: "960 × 540" },
  { w: 720, h: 576, label: "720 × 576 (SD, PAL)" },
  { w: 720, h: 480, label: "720 × 480 (SD, NTSC)" },
];

export const RATES: Rate[] = [
  { num: 24000, den: 1001, label: "23,976" },
  { num: 24, den: 1, label: "24" },
  { num: 25, den: 1, label: "25" },
  { num: 30000, den: 1001, label: "29,97" },
  { num: 30, den: 1, label: "30" },
  { num: 50, den: 1, label: "50" },
  { num: 60000, den: 1001, label: "59,94" },
  { num: 60, den: 1, label: "60" },
];

export interface OptionPair { kind: "resolution" | "rate"; first: string; second: string; prefix: string }

/** Findet zusammengehörige Optionen (…_WIDTH/…_HEIGHT bzw. …_FRAMERATE_NUM/…_FRAMERATE_DEN mit gleichem Präfix). Jede Option gehört höchstens einem Paar. */
export function findPairs(keys: string[]): OptionPair[] {
  const set = new Set(keys);
  const out: OptionPair[] = [];
  for (const k of keys) {
    let m = /^(.*?)_?WIDTH$/.exec(k);
    if (m && set.has(`${m[1]}${k.slice(m[1].length, k.length - 5)}HEIGHT`)) {
      out.push({ kind: "resolution", first: k, second: `${m[1]}${k.slice(m[1].length, k.length - 5)}HEIGHT`, prefix: m[1] });
      continue;
    }
    m = /^(.*FRAMERATE)_NUM$/.exec(k);
    if (m && set.has(`${m[1]}_DEN`)) out.push({ kind: "rate", first: k, second: `${m[1]}_DEN`, prefix: m[1] });
  }
  return out;
}

/** Welche Voreinstellung entspricht den beiden Feldwerten? "" = leer (Standard), "custom" = keine passende. */
export function presetFor(pair: OptionPair["kind"], a: string, b: string): string {
  const x = a.trim(), y = b.trim();
  if (x === "" && y === "") return "";
  if (pair === "resolution") {
    const i = RESOLUTIONS.findIndex((r) => String(r.w) === x && String(r.h) === y);
    return i >= 0 ? String(i) : "custom";
  }
  const i = RATES.findIndex((r) => String(r.num) === x && String(r.den) === y);
  return i >= 0 ? String(i) : "custom";
}

/** Feldwerte einer Voreinstellung (leer/"custom" lässt die Felder unverändert → null). */
export function valuesForPreset(kind: OptionPair["kind"], preset: string): [string, string] | null {
  if (preset === "") return ["", ""];
  const i = Number(preset);
  if (!Number.isInteger(i)) return null;
  if (kind === "resolution") {
    const r = RESOLUTIONS[i];
    return r ? [String(r.w), String(r.h)] : null;
  }
  const r = RATES[i];
  return r ? [String(r.num), String(r.den)] : null;
}
