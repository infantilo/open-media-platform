// Verteilung importierter Microservices auf Hosts (Kap. 85): reine Logik, ohne DOM — testbar.

export interface DistRow {
  type: string;
  version: string;
  hostId: string;
  desired: "present" | "absent";
  state: "pending" | "installing" | "ok" | "failed" | "offline" | "removing";
  detail?: string;
  attempts: number;
  updatedAt: string;
}

export interface HostLite {
  id: string;
  label: string;
}

/** Zeilen eines Katalogeintrags (Typ + Version; eine leere Version gilt als „keine“). */
export function rowsFor(rows: DistRow[], type: string, version: string | undefined): DistRow[] {
  return rows.filter((r) => r.type === type && r.version === (version ?? ""));
}

/** Noch in Bewegung? Dann lohnt sich Nachladen. */
export function isBusy(rows: DistRow[]): boolean {
  return rows.some((r) => r.state === "pending" || r.state === "installing" || r.state === "removing" || r.state === "offline");
}

/** Hosts, die für „Verteilen“ noch zur Auswahl stehen (keine aktive Zeile mit Soll „installiert“). */
export function selectableHosts(hosts: HostLite[], rows: DistRow[]): HostLite[] {
  const active = new Set(rows.filter((r) => r.desired === "present").map((r) => r.hostId));
  return hosts.filter((h) => !active.has(h.id));
}

/** Schlüssel des Textes für den Zustand einer Zeile. */
export function stateKey(r: DistRow): "cathost.state.ok" | "cathost.state.pending" | "cathost.state.installing" | "cathost.state.failed" | "cathost.state.offline" | "cathost.state.removing" {
  return `cathost.state.${r.state}` as ReturnType<typeof stateKey>;
}

/** Farbe (CSS-Variable) des Zustands. */
export function stateColor(r: DistRow): string {
  switch (r.state) {
    case "ok":
      return "var(--omp-ok, #3a3)";
    case "failed":
      return "var(--omp-error)";
    case "offline":
      return "var(--omp-warn, #c80)";
    default:
      return "var(--omp-text-dim)";
  }
}

/** Anzeigename eines Hosts (fällt auf die ID zurück). */
export function hostLabel(hosts: HostLite[], id: string): string {
  return hosts.find((h) => h.id === id)?.label || id;
}

/** Zusammenfassung für die Kartenzeile, z. B. „2 von 3 Hosts“. */
export function summary(rows: DistRow[]): { ok: number; total: number; failed: number } {
  const present = rows.filter((r) => r.desired === "present");
  return { ok: present.filter((r) => r.state === "ok").length, total: present.length, failed: present.filter((r) => r.state === "failed").length };
}
