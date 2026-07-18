// Reine Rollennamen-Logik für den Flow-Editor (Kapitel 12 Teil 2/6,
// docs/END-GOAL-FEATURES.md §12.3b/§12.3g) — DOM-frei, per `deno test`
// geprüft, unabhängig von flow-canvas.ts/role-designer.ts (gleiches
// Trennungsmuster wie geometry.ts/compatibility.ts/groups.ts). Eigene,
// kleine Datei statt eines der bestehenden Module: von zwei
// DOM-bindenden Custom Elements gebraucht (<omp-flow-canvas>s "Gruppe
// als Workflow speichern" und <omp-role-designer>s "+ Rolle"), keines
// davon darf das jeweils andere importieren müssen, nur um an diese
// eine Funktion zu kommen.

// Rollenname aus dem Node-Typ ableiten, eindeutig gemacht bei mehreren
// Rollen desselben Typs (z. B. drei Kamera-Rollen "omp-source",
// "omp-source-2", "omp-source-3").
export function uniqueRoleName(nodeType: string, used: Set<string>): string {
  if (!used.has(nodeType)) return nodeType;
  let i = 2;
  while (used.has(`${nodeType}-${i}`)) i++;
  return `${nodeType}-${i}`;
}
