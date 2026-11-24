// Umzugsdialog-Vorschau (Kapitel 108): reine Textbildung aus der Antwort von
// GET /api/v1/instances/<id>/migrate-preview. Kein DOM, übersetzt über eine übergebene Funktion (testbar).

export interface BridgePreview {
  medium: string;
  fromHost: string;
  toHost: string;
  peers: string[];
  transport: string;
  candidates: string[];
}

export interface MigratePreview {
  bridges: BridgePreview[];
  dissolvedBridges: number;
}

export type Tr = (key: string, params?: Record<string, string | number>) => string;

const TRANSPORT_LABEL: Record<string, string> = { fabrics: "Fabrics/RDMA", st2110: "ST 2110", aes67: "AES67", srt: "SRT" };

export function transportLabel(id: string): string {
  return TRANSPORT_LABEL[id] ?? id;
}

/** Zeilen für den Bestätigungstext; leer, wenn der Umzug ohne Brücke auskommt. */
export function describePreview(p: MigratePreview, hostLabel: (id: string) => string, tr: Tr): string[] {
  if (!p.bridges || p.bridges.length === 0) return [];
  const lines: string[] = [tr("mig.intro")];
  for (const b of p.bridges) {
    lines.push(tr("mig.bridge", {
      medium: tr("mig." + b.medium),
      peers: (b.peers ?? []).join(", ") || "?",
      transport: transportLabel(b.transport),
      from: hostLabel(b.fromHost),
      to: hostLabel(b.toHost),
    }));
    if (b.candidates && b.candidates.length > 1) {
      lines.push(tr("mig.fallback", { list: b.candidates.slice(1).map(transportLabel).join(", ") }));
    }
  }
  lines.push(tr("mig.note"));
  return lines;
}
