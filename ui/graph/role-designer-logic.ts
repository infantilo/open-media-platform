// Reine Entwurfs-Logik für <omp-role-designer> (Kapitel 12 Teil 6,
// §22.3 Punkt 1) — DOM-frei, per `deno test` geprüft, gleiches
// Trennungsmuster wie geometry.ts/compatibility.ts/groups.ts. Eigene
// Datei statt Teil von role-designer.ts: Letzteres definiert das
// Custom Element (`extends HTMLElement`, `customElements.define`) und
// importiert damit transitiv DOM-Globals, die unter `deno test` nicht
// existieren — ein Test dieser Datei würde beim bloßen Import bereits
// scheitern (per Testlauf gefunden: "document is not defined" via
// ui/kit/omp-toast.ts).

export interface DraftRole {
  name: string;
  nodeType: string;
  hostId?: string;
  format?: string;
}

export interface DraftConnection {
  fromRole: string;
  toRole: string;
}

// removeRole: entfernt eine Rolle und jede Verbindung, die sie
// referenziert — eine Kante ohne eines ihrer beiden Enden wäre ein
// Definitions-Torso, den das Backend (workflows.validate) ohnehin
// ablehnen würde.
export function removeRole(
  roles: DraftRole[],
  connections: DraftConnection[],
  name: string,
): { roles: DraftRole[]; connections: DraftConnection[] } {
  return {
    roles: roles.filter((r) => r.name !== name),
    connections: connections.filter((c) => c.fromRole !== name && c.toRole !== name),
  };
}

// renameRole: Nutzerwunsch 2026-07-30 ("wir müssen in der Lage sein,
// jedem Service und Stream einen sprechenden Namen zu geben") — der
// Rollenname IST bereits das Sender-Label (`OMP_LABEL`,
// `workflows.Service.StartLabeled`, s. dortige Doku), landet also 1:1
// in den Crosspoint-Tasten des Mixers; bisher aber nur beim Anlegen
// automatisch vergeben (`uniqueRoleName`), nie danach änderbar. Lehnt
// wie `addConnection` leere/duplizierte Namen ab statt sie still zu
// ignorieren; benennt jede Verbindung, die die alte Rolle referenziert,
// mit um (sonst ein Definitions-Torso, gleicher Grund wie bei
// `removeRole`).
export function renameRole(
  roles: DraftRole[],
  connections: DraftConnection[],
  oldName: string,
  newName: string,
): { roles: DraftRole[]; connections: DraftConnection[]; ok: boolean } {
  const trimmed = newName.trim();
  if (!trimmed || trimmed === oldName) return { roles, connections, ok: false };
  if (!roles.some((r) => r.name === oldName)) return { roles, connections, ok: false };
  if (roles.some((r) => r.name === trimmed)) return { roles, connections, ok: false };
  return {
    roles: roles.map((r) => (r.name === oldName ? { ...r, name: trimmed } : r)),
    connections: connections.map((c) => ({
      fromRole: c.fromRole === oldName ? trimmed : c.fromRole,
      toRole: c.toRole === oldName ? trimmed : c.toRole,
    })),
    ok: true,
  };
}

// addConnection: lehnt Selbstschleifen (fromRole === toRole, ergäbe
// keinen sinnvollen Signalfluss) und exakte Duplikate ab (ok=false)
// statt sie still zu ignorieren oder eine zweite identische Kante zu
// zeichnen.
export function addConnection(
  connections: DraftConnection[],
  fromRole: string,
  toRole: string,
): { connections: DraftConnection[]; ok: boolean } {
  if (!fromRole || !toRole || fromRole === toRole) return { connections, ok: false };
  if (connections.some((c) => c.fromRole === fromRole && c.toRole === toRole)) {
    return { connections, ok: false };
  }
  return { connections: [...connections, { fromRole, toRole }], ok: true };
}
