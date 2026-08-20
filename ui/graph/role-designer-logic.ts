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
  // standbyFor (K7 Teil 4, docs/END-GOAL-FEATURES.md §7.4): Name einer
  // anderen Rolle, für die diese Rolle als warmer Standby dient — s.
  // orchestrator/internal/workflows/types.go Role.StandbyFor (einzige
  // Quelle der Durchsetzungs-Wahrheit, hier nur Dropdown-Komfort).
  standbyFor?: string;
  // placement (D6 Teil 4, ARCHITECTURE.md §6.1 Erweiterung 2026-07-13
  // Punkt 2): Placement-Eskalationsstufe dieser Rolle — bewusst als
  // verschachteltes Objekt statt flacher Felder, identisch zum
  // Backend-Wire-Format (orchestrator/internal/workflows/types.go
  // Role.Placement), damit role-designer.ts es unverändert
  // durchreichen kann (kein Flatten/Un-Flatten beim Laden/Speichern
  // nötig). undefined/leeres escalation = "advisory" (Default).
  placement?: { escalation?: string; confirmWindowSeconds?: number };
  // mixerLevels (Nutzerwunsch 2026-08-14: "dynamische Anzahl an
  // Mischerebenen... jede mit eigenem Output") — nur für
  // nodeType==="omp-video-mixer-me" gezeigt (s. role-designer.ts
  // #renderRoleTile), aber wie orchestrator/internal/workflows/
  // types.go Role.MixerLevels generisch am DraftRole gehalten, kein
  // Sonderfall im Wire-Format. undefined/0 = Node-eigener Default
  // (1 Ebene).
  mixerLevels?: number;
  // requiredIoPort (Nutzerauftrag 2026-08-20, im Anschluss an den
  // DeckLink-Crash-Loop-Fix): spiegelt orchestrator/internal/workflows/
  // types.go Role.RequiredIOPort — deklariert, dass diese Rolle für ihre
  // gesamte Laufzeit einen exklusiven physischen I/O-Port braucht (D13,
  // ARCHITECTURE.md §6.1 Erweiterung 2026-07-10). Bislang nur per
  // Roh-JSON/API setzbar, was live gefundene Folgefehler hatte: ohne
  // requiredIoPort startet jede omp-decklink-Instanz mit ihrem
  // eingebauten Default (device-number=0, ingest, s. nodes/omp-decklink/
  // src/main.rs) — auf einem Host ohne Karte an genau diesem Index ein
  // Crash-Loop statt einer ehrlichen "kein freier Port"-Ablehnung. Nur
  // für nodeType==="omp-decklink" gezeigt/gesetzt (s. role-designer.ts
  // #renderRoleTile/#addRole) — cardType ist dort fix "decklink", da das
  // bislang einzige I/O-Karten-nodeType; direction ("in"|"out") steuert
  // zugleich OMP_DECKLINK_DIRECTION (ioports.go ioPortExtraEnv).
  requiredIoPort?: { cardType: string; direction: string };
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
    // Eine Rolle, die `name` als standbyFor referenzierte, wird zu einer
    // normalen Rolle statt eines Torsos mit einer toten Referenz (gleicher
    // Grund wie das Herausfiltern der Connections unten).
    roles: roles
      .filter((r) => r.name !== name)
      .map((r) => (r.standbyFor === name ? { ...r, standbyFor: undefined } : r)),
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
    roles: roles.map((r) => {
      if (r.name === oldName) return { ...r, name: trimmed };
      if (r.standbyFor === oldName) return { ...r, standbyFor: trimmed };
      return r;
    }),
    connections: connections.map((c) => ({
      fromRole: c.fromRole === oldName ? trimmed : c.fromRole,
      toRole: c.toRole === oldName ? trimmed : c.toRole,
    })),
    ok: true,
  };
}

// standbyCandidates: welche anderen Rollen kann `role` als Standby
// referenzieren (K7 Teil 4) — spiegelt orchestrator/internal/workflows/
// service.go validate()s Regeln rein für die Dropdown-Optionsliste (das
// Backend bleibt die eigentliche Durchsetzung, s. dortige Doku): gleicher
// NodeType, keine Selbstreferenz, keine Ketten (ein Kandidat, der selbst
// bereits ein Standby ist, scheidet aus), höchstens ein Standby pro
// Primärrolle (ein Kandidat, der schon einen ANDEREN Standby hat,
// scheidet aus).
export function standbyCandidates(roles: DraftRole[], role: DraftRole): DraftRole[] {
  return roles.filter((r) =>
    r.name !== role.name &&
    r.nodeType === role.nodeType &&
    !r.standbyFor &&
    !roles.some((other) => other.name !== role.name && other.standbyFor === r.name)
  );
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
