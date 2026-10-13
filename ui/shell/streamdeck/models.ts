// Stream-Deck-Modelltabelle (Kap. 40.2). Reine Daten, Quelle: offizielle
// HID-Beschreibung des Herstellers (docs/ENTWURF-STREAMDECK.md §1).
// v1: XL, XL 2022, 15-Tasten-Familie, „+“. Neo/Mini/MK.1 bewusst nicht
// (Protokoll nicht verifiziert).

export const VENDOR_ID = 0x0fd9;

export interface DeckModel {
  pid: number;
  name: string;
  cols: number;
  rows: number;
  /** Kantenlänge eines Tastenbilds in Pixeln (JPEG, quadratisch). */
  keySize: number;
  /** Bild vor dem Senden um 180° drehen (laut Hersteller XL/15-Tasten). */
  rotate180: boolean;
  /** Anzahl Dials (nur „+“). */
  dials: number;
  /** Touch-Streifen (nur „+“): logische Größe in Pixeln. */
  strip?: { w: number; h: number };
}

const key15 = { cols: 5, rows: 3, keySize: 72, rotate180: true, dials: 0 } as const;
const xl = { cols: 8, rows: 4, keySize: 96, rotate180: true, dials: 0 } as const;

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
    rotate180: false,
    dials: 4,
    strip: { w: 800, h: 100 },
  },
];

export function modelForPid(pid: number): DeckModel | undefined {
  return MODELS.find((m) => m.pid === pid);
}

export function keyCount(m: DeckModel): number {
  return m.cols * m.rows;
}
