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

// Standard-Format-Presets je Rolle (Nutzerwunsch 2026-07-28) — geteilt
// zwischen dem Text-Formular (ui/shell/workflows-view.ts) und dem
// grafischen Role-Designer (ui/graph/role-designer.ts), damit beide
// Dropdowns bei einer künftigen Preset-Änderung nicht auseinanderlaufen
// können. Muss exakt die Namen aus
// orchestrator/internal/workflows/formats.go spiegeln (einzige Quelle
// der Wahrheit bleibt dort, validate() lehnt jeden anderen Namen ab).
export const ROLE_FORMATS = [
  "480p25", "480p29.97",
  "576p25", "576p50",
  "720p25", "720p29.97", "720p50", "720p59.94", "720p60",
  "1080p25", "1080p29.97", "1080p30", "1080p50", "1080p59.94", "1080p60",
  "2160p25", "2160p29.97", "2160p30", "2160p50", "2160p59.94", "2160p60",
];
