// Reine Logik der Workflow-Schnittstelle (Kap. 88): benannte Ausgänge/Eingänge eines Workflows, hinter denen
// Sender/Empfänger einzelner Rollen stehen. Kein DOM; alle Funktionen liefern eine neue Struktur zurück.
// Gegenstück im Orchestrator: orchestrator/internal/workflows/interface.go (Validierung + Auflösung).

export type InterfaceSide = "outputs" | "inputs";

export interface InterfaceMember {
  role: string;
  /** Port-Label ohne Node-Präfix; leer = erster/passender Port der Rolle. */
  port?: string;
}

export interface InterfacePort {
  name: string;
  label?: string;
  members: InterfaceMember[];
  /** Nur Eingänge: dauerhaft von diesem Workflow-Ausgang gespeist (Orchestrator löst beim Start auf). */
  feed?: { workflowId: string; output: string };
}

export interface WorkflowInterface {
  outputs?: InterfacePort[];
  inputs?: InterfacePort[];
}

const INSTANCE_PREFIX = /^.*? \([0-9a-f]{6,}\) /;

/** Wie portName() im Orchestrator: Port-Label ohne "<Node-Label> " bzw. "<Name> (<Instanz-ID>) " davor. */
export function portNameOf(label: string, nodeLabel = ""): string {
  if (nodeLabel && label.startsWith(nodeLabel + " ")) return label.slice(nodeLabel.length + 1);
  return label.replace(INSTANCE_PREFIX, "");
}

/** Leere Schnittstelle → undefined, damit das Feld gar nicht erst in der Definition steht. */
export function normalize(ifc: WorkflowInterface | undefined): WorkflowInterface | undefined {
  if (!ifc) return undefined;
  const outputs = ifc.outputs ?? [];
  const inputs = ifc.inputs ?? [];
  if (outputs.length === 0 && inputs.length === 0) return undefined;
  return { ...(outputs.length ? { outputs } : {}), ...(inputs.length ? { inputs } : {}) };
}

export function hasName(ifc: WorkflowInterface | undefined, side: InterfaceSide, name: string): boolean {
  return (ifc?.[side] ?? []).some((p) => p.name === name);
}

/** Legt einen Ausgang/Eingang an; null bei leerem oder doppeltem Namen (je Seite eindeutig). */
export function addPort(
  ifc: WorkflowInterface | undefined,
  side: InterfaceSide,
  name: string,
  members: InterfaceMember[] = [],
): WorkflowInterface | null {
  const n = name.trim();
  if (!n || hasName(ifc, side, n)) return null;
  return { ...ifc, [side]: [...(ifc?.[side] ?? []), { name: n, members }] };
}

export function removePort(ifc: WorkflowInterface | undefined, side: InterfaceSide, name: string): WorkflowInterface | undefined {
  if (!ifc) return ifc;
  return normalize({ ...ifc, [side]: (ifc[side] ?? []).filter((p) => p.name !== name) });
}

/** Benennt um (null bei leerem/doppeltem Zielnamen). */
export function renamePort(
  ifc: WorkflowInterface,
  side: InterfaceSide,
  oldName: string,
  newName: string,
): WorkflowInterface | null {
  const n = newName.trim();
  if (!n) return null;
  if (n !== oldName && hasName(ifc, side, n)) return null;
  return { ...ifc, [side]: (ifc[side] ?? []).map((p) => (p.name === oldName ? { ...p, name: n } : p)) };
}

export function setLabel(ifc: WorkflowInterface, side: InterfaceSide, name: string, label: string): WorkflowInterface {
  const l = label.trim();
  return {
    ...ifc,
    [side]: (ifc[side] ?? []).map((p) => {
      if (p.name !== name) return p;
      const { label: _old, ...rest } = p;
      return l ? { ...rest, label: l } : rest;
    }),
  };
}

/** Fügt ein Mitglied hinzu; identisches (Rolle, Port)-Paar wird nicht doppelt aufgenommen. */
export function addMember(ifc: WorkflowInterface, side: InterfaceSide, name: string, member: InterfaceMember): WorkflowInterface {
  const m: InterfaceMember = member.port ? { role: member.role, port: member.port } : { role: member.role };
  return {
    ...ifc,
    [side]: (ifc[side] ?? []).map((p) => {
      if (p.name !== name) return p;
      if (p.members.some((x) => x.role === m.role && (x.port ?? "") === (m.port ?? ""))) return p;
      return { ...p, members: [...p.members, m] };
    }),
  };
}

export function removeMember(ifc: WorkflowInterface, side: InterfaceSide, name: string, index: number): WorkflowInterface {
  return {
    ...ifc,
    [side]: (ifc[side] ?? []).map((p) => (p.name === name ? { ...p, members: p.members.filter((_, i) => i !== index) } : p)),
  };
}

/** Wird eine Rolle gelöscht/umbenannt, müssen ihre Mitglieder folgen (sonst lehnt der Orchestrator die Definition ab). */
export function renameRoleIn(ifc: WorkflowInterface | undefined, oldRole: string, newRole: string | null): WorkflowInterface | undefined {
  if (!ifc) return ifc;
  const fix = (ports: InterfacePort[] | undefined) =>
    (ports ?? [])
      .map((p) => ({
        ...p,
        members: newRole === null
          ? p.members.filter((m) => m.role !== oldRole)
          : p.members.map((m) => (m.role === oldRole ? { ...m, role: newRole } : m)),
      }))
      .filter((p) => p.members.length > 0);
  return normalize({ outputs: fix(ifc.outputs), inputs: fix(ifc.inputs) });
}

/** Ungültige Stellen (für die Anzeige im Dialog) — spiegelt validateInterface im Orchestrator. */
export function problems(ifc: WorkflowInterface | undefined, roles: string[]): string[] {
  const out: string[] = [];
  for (const side of ["outputs", "inputs"] as const) {
    for (const p of ifc?.[side] ?? []) {
      if (p.members.length === 0) out.push(`${side}:${p.name}:noMembers`);
      for (const m of p.members) if (!roles.includes(m.role)) out.push(`${side}:${p.name}:unknownRole:${m.role}`);
    }
  }
  return out;
}

/** Hebt die dauerhafte Zuordnung eines Eingangs auf. */
export function clearFeed(ifc: WorkflowInterface, name: string): WorkflowInterface {
  return {
    ...ifc,
    inputs: (ifc.inputs ?? []).map((p) => {
      if (p.name !== name) return p;
      const { feed: _feed, ...rest } = p;
      return rest;
    }),
  };
}
