// Reine Logik für <omp-asset-view> (Kapitel 21 Phase 6 Teil 3) — DOM-
// frei, per `deno test` geprüft, gleiches Trennungsmuster wie
// console-logic.ts/process-editor-logic.ts.
//
// Wire-Formate identisch zu orchestrator/internal/asset/types.go (JSON-
// Feldnamen 1:1) — eigene, lokale Deklaration statt eines Imports, wie
// jede andere View-Datei in diesem Projekt.

export interface AssetMetadata {
  system?: Record<string, unknown>;
  technical?: Record<string, unknown>;
  descriptive?: Record<string, unknown>;
  editorial?: Record<string, unknown>;
  custom?: Record<string, unknown>;
  ai?: Record<string, unknown>;
}

export interface Asset {
  id: string;
  type: string;
  title: string;
  description?: string;
  status: string;
  currentVersionId?: string;
  metadata: AssetMetadata;
  createdBy: string;
  updatedBy: string;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface AssetVersion {
  id: string;
  assetId: string;
  versionNumber: number;
  parentVersionId?: string;
  status: string;
  changeReason?: string;
  createdBy: string;
  createdAt: string;
}

export interface Representation {
  id: string;
  assetVersionId: string;
  type: string;
  storage: { provider: string; uri: string };
  format?: string;
  codec?: string;
  container?: string;
  width?: number;
  height?: number;
  frameRate?: number;
  sampleRate?: number;
  channels?: number;
  bitrate?: number;
  sizeBytes?: number;
  checksum?: string;
  createdAt: string;
}

// GET /api/v1/asset-lifecycle — erlaubte Übergänge direkt aus
// asset.LifecycleTransitions/VersionTransitions (kein Duplikat hier).
export interface LifecycleGraph {
  asset: Record<string, string[]>;
  version: Record<string, string[]>;
}

// B6: die sechs Metadaten-Kategorien, Reihenfolge = Anzeige-Reihenfolge.
export const METADATA_CATEGORIES: { key: keyof AssetMetadata; label: string }[] = [
  { key: "descriptive", label: "Beschreibend" },
  { key: "editorial", label: "Redaktionell" },
  { key: "technical", label: "Technisch" },
  { key: "custom", label: "Eigene Felder" },
  { key: "ai", label: "KI-generiert" },
  { key: "system", label: "System" },
];

// Anzeige-Texte für den Asset-Lifecycle (B8). Unbekannte Zustände
// (Backend erweitert, UI noch nicht) fallen auf den Rohwert zurück.
export const ASSET_STATUS_LABEL: Record<string, string> = {
  ingesting: "Eingang",
  registered: "Registriert",
  processing: "In Verarbeitung",
  ready: "Bereit",
  in_review: "In Prüfung",
  approved: "Freigegeben",
  published: "Veröffentlicht",
  archived: "Archiviert",
  expired: "Abgelaufen",
  deleted: "Gelöscht",
};

export function statusLabel(status: string): string {
  return ASSET_STATUS_LABEL[status] ?? status;
}

// Vorschläge für die freien Typ-Felder (Backend: TEXT ohne Enum, B2/B4)
// — nur <datalist>-Hinweise, jeder andere Wert bleibt erlaubt.
export const ASSET_TYPE_SUGGESTIONS = ["video", "audio", "image", "graphic", "document", "subtitle"];
export const REPRESENTATION_TYPE_SUGGESTIONS = [
  "master",
  "mezzanine",
  "proxy",
  "thumbnail",
  "audio_stem",
  "caption",
  "transcoded",
];
export const STORAGE_PROVIDER_SUGGESTIONS = ["filesystem", "s3", "http"];

// ---- Metadaten-Editor ------------------------------------------------------------------------

// Eine Zeile im Schlüssel/Wert-Editor. json=true: der Wert war im
// Original kein String (Zahl/Bool/Objekt/Liste) und wird als JSON
// bearbeitet — sonst würde ein Speichern ohne jede Änderung z. B. eine
// Zahl stillschweigend in einen String verwandeln. Neue Zeilen sind
// immer Strings (json=false): ein Titel "2024" darf nicht zur Zahl
// werden, nur weil er wie eine aussieht.
export interface MetadataRow {
  key: string;
  value: string;
  json: boolean;
}

export type MetadataRows = Record<keyof AssetMetadata, MetadataRow[]>;

export function metadataToRows(meta: AssetMetadata | undefined): MetadataRows {
  const out = {} as MetadataRows;
  for (const { key } of METADATA_CATEGORIES) {
    const entries = Object.entries(meta?.[key] ?? {});
    out[key] = entries.map(([k, v]) =>
      typeof v === "string" ? { key: k, value: v, json: false } : { key: k, value: JSON.stringify(v), json: true }
    );
  }
  return out;
}

// rowsToMetadata: Rückweg mit Validierung — leere Zeilen (Schlüssel UND
// Wert leer) werden ignoriert, ein leerer Schlüssel mit Wert, doppelte
// Schlüssel je Kategorie und ungültiges JSON sind Fehler (mit Kategorie
// + Schlüssel im Text, damit die Meldung ohne Technik-Wissen auffindbar
// ist). Leere Kategorien werden weggelassen (Backend: omitempty).
export function rowsToMetadata(rows: MetadataRows): { ok: true; metadata: AssetMetadata } | { ok: false; error: string } {
  const metadata: AssetMetadata = {};
  for (const { key: cat, label } of METADATA_CATEGORIES) {
    const obj: Record<string, unknown> = {};
    for (const row of rows[cat] ?? []) {
      const k = row.key.trim();
      if (!k && !row.value.trim()) continue;
      if (!k) return { ok: false, error: `${label}: Feld ohne Namen (Wert "${row.value}")` };
      if (k in obj) return { ok: false, error: `${label}: Feld "${k}" doppelt` };
      if (row.json) {
        try {
          obj[k] = JSON.parse(row.value);
        } catch {
          return { ok: false, error: `${label}: Feld "${k}" ist kein gültiger Wert (JSON erwartet)` };
        }
      } else {
        obj[k] = row.value;
      }
    }
    if (Object.keys(obj).length > 0) metadata[cat] = obj;
  }
  return { ok: true, metadata };
}

// ---- Anzeige-Formatierung --------------------------------------------------------------------

export function formatBytes(n: number | undefined): string {
  if (n === undefined || n === null) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return i === 0 ? `${v} B` : `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatBitrate(bps: number | undefined): string {
  if (bps === undefined || bps === null) return "";
  if (bps >= 1_000_000) return `${+(bps / 1_000_000).toFixed(1)} Mbit/s`;
  if (bps >= 1000) return `${+(bps / 1000).toFixed(0)} kbit/s`;
  return `${bps} bit/s`;
}

// Kompakte technische Zusammenfassung einer Representation — nur
// tatsächlich gesetzte Felder (B4: nicht jede Representation hat z. B.
// eine Framerate), "·"-getrennt.
export function representationSummary(r: Representation): string {
  const parts: string[] = [];
  if (r.width && r.height) parts.push(`${r.width}×${r.height}`);
  if (r.frameRate) parts.push(`${+r.frameRate.toFixed(3)} fps`);
  const codec = [r.codec, r.container || r.format].filter(Boolean).join("/");
  if (codec) parts.push(codec);
  if (r.sampleRate) parts.push(`${+(r.sampleRate / 1000).toFixed(1)} kHz`);
  if (r.channels) parts.push(`${r.channels} ch`);
  if (r.bitrate) parts.push(formatBitrate(r.bitrate));
  if (r.sizeBytes) parts.push(formatBytes(r.sizeBytes));
  return parts.join(" · ");
}

// parseOptionalNumber: Formularfeld → Zahl oder "nicht gesetzt". Leer =
// undefined (Feld wird weggelassen), ungültig = Fehler statt stiller 0.
export function parseOptionalNumber(
  text: string,
  opts: { integer?: boolean } = {},
): { ok: true; value: number | undefined } | { ok: false } {
  const t = text.trim().replace(",", ".");
  if (!t) return { ok: true, value: undefined };
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  if (opts.integer && !Number.isInteger(n)) return { ok: false };
  return { ok: true, value: n };
}

// filterAssets: clientseitige Filterung — Freitext über Titel/
// Beschreibung/Typ, plus Typ/Status exakt. Gelöschte Assets (B8-
// Endzustand, bleiben als Datensatz erhalten) sind standardmäßig
// ausgeblendet, außer es wird explizit nach Status "deleted" gefiltert
// oder showDeleted gesetzt. Bewusst clientseitig statt ?type=&status=:
// die Typ-Auswahl leitet sich aus der geladenen Gesamtliste ab und
// würde bei serverseitiger Filterung mitschrumpfen.
export interface AssetFilter {
  query: string;
  type: string;
  status: string;
  showDeleted: boolean;
}

export function filterAssets(assets: Asset[], f: AssetFilter): Asset[] {
  const q = f.query.trim().toLowerCase();
  return assets.filter((a) => {
    if (f.type && a.type !== f.type) return false;
    if (f.status && a.status !== f.status) return false;
    if (!f.status && !f.showDeleted && a.status === "deleted") return false;
    if (!q) return true;
    return a.title.toLowerCase().includes(q) || (a.description ?? "").toLowerCase().includes(q) ||
      a.type.toLowerCase().includes(q);
  });
}
