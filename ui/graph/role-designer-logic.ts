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
