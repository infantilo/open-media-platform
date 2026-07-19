// Reine Auswahl-Logik für <omp-console-view> (console-view.ts) — als
// eigenes, DOM-freies Modul gehalten, damit `deno test` sie direkt
// prüfen kann (gleiches Muster wie ui/graph/groups.ts+groups_test.ts:
// reine Logik separat vom Custom Element, das DOM/Netzwerk anfasst und
// deshalb nur per Browser-Test verifizierbar ist).
export interface ConsoleEntryLike {
  nodeRoleId: string;
  uiBundleUrl: string;
}

// pickActiveEntry entscheidet, welche Rolle (falls überhaupt) nach
// einem setEntries()-Aufruf (neu) aktiviert werden soll — auch bei
// einem wiederholten Aufruf mit einer frisch aufgelösten Liste (§7.6,
// docs/END-GOAL-FEATURES.md, 2026-07-17: "Operator-UI muss der
// Übernahme unmerklich folgen"). `uiBundleUrl` trägt die aktuell
// aufgelöste Node-ID; `nodeRoleId` selbst bleibt über einen Prozess-
// Restart hinweg stabil (K7-Teil-1: gleiche Launcher-Instanz-ID), die
// dahinterliegende NMOS-Node-ID aber NICHT — ein reiner
// nodeRoleId-Vergleich würde einen Neustart/Failover deshalb übersehen
// und den Operator unbemerkt auf einem toten Node sitzen lassen.
//
// Rückgabe: die zu aktivierende nodeRoleId, oder null, wenn keine
// Änderung nötig ist (bereits aktive Rolle unverändert erreichbar).
// Der Aufrufer ist dafür verantwortlich, entries.length === 0 vorher
// gesondert zu behandeln (eigener "keine Konsole zugewiesen"-Zustand,
// kein "welche Rolle aktivieren").
export function pickActiveEntry<T extends ConsoleEntryLike>(
  entries: T[],
  activeNodeRoleId: string | null,
  previousUrl: string | undefined,
  preselectNodeRoleId?: string,
): string | null {
  const preselected = preselectNodeRoleId
    ? entries.find((e) => e.nodeRoleId === preselectNodeRoleId)
    : undefined;
  if (preselected) return preselected.nodeRoleId;

  const stillValidEntry = entries.find((e) => e.nodeRoleId === activeNodeRoleId);
  if (!stillValidEntry) return entries.length > 0 ? entries[0].nodeRoleId : null;

  if (stillValidEntry.uiBundleUrl !== previousUrl) return stillValidEntry.nodeRoleId;

  return null;
}
