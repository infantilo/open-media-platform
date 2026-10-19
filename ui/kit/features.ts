// Funktionsrechte (Kapitel 44) — reine Logik, von Shell und Modul-Oberflächen gemeinsam genutzt. Spiegel von
// authz.FeatureMatches im Orchestrator: `modul.*` deckt alle Rechte des Moduls ab, `*` alle.

/** Meldung von GET /api/v1/me/features: `all` = globales „configure“ (alles erlaubt), sonst die vergebenen Muster. */
export interface FeatureSet {
  all: boolean;
  patterns: string[];
  /** IDs der Gruppen der Person (erkennt „meine“ Gruppenaufgaben). */
  groups?: string[];
}

/** Auswahl-Liste für Verantwortliche (GET /api/v1/directory). */
export interface Directory {
  users: { username: string }[];
  groups: { id: string; name: string }[];
}

/** Gehört ein Gegenstand der Person (persönlich oder über eine ihrer Gruppen)? */
export function isMine(set: FeatureSet | null | undefined, username: string | undefined, owner?: string, ownerGroup?: string): boolean {
  if (owner && username && owner === username) return true;
  return !!ownerGroup && !!set?.groups?.includes(ownerGroup);
}

/** Anzeigename einer Gruppe (ID → Name); unbekannt: die ID. */
export function groupName(dir: Directory | null | undefined, id: string): string {
  return dir?.groups.find((g) => g.id === id)?.name ?? id;
}

export function featureMatches(grant: string, want: string): boolean {
  if (grant === want || grant === "*") return true;
  if (grant.endsWith(".*")) return want.startsWith(grant.slice(0, -1));
  return false;
}

/** Darf die Person die Funktion? */
export function hasFeature(set: FeatureSet | null | undefined, want: string): boolean {
  if (!set) return false;
  return set.all || set.patterns.some((p) => featureMatches(p, want));
}

/** Hat die Person mindestens eines der Rechte (Muster der Kachel, z. B. `ingest.*`)? */
export function hasAnyFeature(set: FeatureSet | null | undefined, needs: string[]): boolean {
  if (!set) return false;
  if (set.all) return true;
  return needs.some((n) => set.patterns.some((p) => featureMatches(p, n) || featureMatches(n, p)));
}
