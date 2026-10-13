// Stream-Deck-Modelltabelle (Kap. 40.2). Reine Daten, Quelle: offizielle
// HID-Beschreibung des Herstellers (docs/ENTWURF-STREAMDECK.md §1).
// v1: XL, XL 2022, 15-Tasten-Familie, „+“. Neo/Mini/MK.1 bewusst nicht
// (Protokoll nicht verifiziert).

export const VENDOR_ID = 0x0fd9;

export type Rotation = 0 | 90 | 180;

/** Canvas-Matrix [a,b,c,d,e,f]: logisches Bild (w×h) → hochzuladendes, gedrehtes Bild (90°: h×w). */
export function rotationMatrix(r: Rotation, w: number, h: number): [number, number, number, number, number, number] {
  if (r === 180) return [-1, 0, 0, -1, w, h];
  if (r === 90) return [0, -1, 1, 0, 0, w];
  return [1, 0, 0, 1, 0, 0];
}

/** Umkehrung (Anzeige im Simulator): gedrehtes Bild → logische Lage (w×h). */
export function unrotationMatrix(r: Rotation, w: number, h: number): [number, number, number, number, number, number] {
  if (r === 180) return [-1, 0, 0, -1, w, h];
  if (r === 90) return [0, 1, -1, 0, w, 0];
  return [1, 0, 0, 1, 0, 0];
}

/** Abmessungen des hochzuladenden Bilds. */
export function rotatedSize(r: Rotation, w: number, h: number): [number, number] {
  return r === 90 ? [h, w] : [w, h];
}

export interface DeckModel {
  pid: number;
  name: string;
  cols: number;
  rows: number;
  /** Kantenlänge eines Tastenbilds in Pixeln (JPEG, quadratisch). */
  keySize: number;
  /** Bild vor dem Senden drehen (Grad gegen den Uhrzeigersinn; XL/15-Tasten 180°, „+ XL“ 90°). */
  rotation: Rotation;
  /** Anzahl Dials (nur „+“). */
  dials: number;
  /** Touch-Streifen (nur „+“): logische Größe in Pixeln. */
  strip?: { w: number; h: number };
}

const key15 = { cols: 5, rows: 3, keySize: 72, rotation: 180, dials: 0 } as const;
const xl = { cols: 8, rows: 4, keySize: 96, rotation: 180, dials: 0 } as const;

export const MODELS: readonly DeckModel[] = [
  { pid: 0x006c, name: "Stream Deck XL", ...xl },
  { pid: 0x008f, name: "Stream Deck XL 2022", ...xl },
  { pid: 0x006d, name: "Stream Deck 2019", ...key15 },
  { pid: 0x0080, name: "Stream Deck MK.2", ...key15 },
  { pid: 0x00a5, name: "Stream Deck MK.2 Scissor", ...key15 },
  {
    pid: 0x0084,
    name: "Stream Deck +",
    cols: 4,
    rows: 2,
    keySize: 120,
    // Hersteller: „keine Drehung“; Vorlage dreht. Am Gerät zu klären (40.2-Gerätetest).
    rotation: 0,
    dials: 4,
    strip: { w: 800, h: 100 },
  },
  {
    // Hersteller-HID-Seite „Stream Deck + XL“ (2026-10-13): 9×4 Tasten 112 px, 6 Dials,
    // Streifen 1200×100; alle Bilder (Tasten, Streifen) 90° gegen den Uhrzeigersinn gedreht.
    pid: 0x00c6,
    name: "Stream Deck + XL",
    cols: 9,
    rows: 4,
    keySize: 112,
    rotation: 90,
    dials: 6,
    strip: { w: 1200, h: 100 },
  },
];

export function modelForPid(pid: number): DeckModel | undefined {
  return MODELS.find((m) => m.pid === pid);
}

export function keyCount(m: DeckModel): number {
  return m.cols * m.rows;
}
