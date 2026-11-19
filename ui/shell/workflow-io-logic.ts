// Reine Logik für Export, Import und Duplizieren eines Workflows (ohne DOM, testbar): was eine exportierte Datei enthält,
// was davon mitgehen soll, und wie Rollennamen beim Duplizieren umbenannt werden.

export interface IoBinding {
  subject: string;
  /** "user" (leer = Nutzer) oder "group". Bei Gruppen ist `subject` eine Gruppen-ID. */
  subjectType?: string;
  /** Lesbarer Name: Gruppenname bzw. Nutzername. Ältere Dateien haben ihn nicht. */
  subjectName?: string;
  role: string;
  verb: string;
}

export interface IoAlertRoute {
  name: string;
  enabled: boolean;
  kinds?: string[];
  severities?: string[];
  to: string;
}

export interface IoRole {
  name: string;
  nodeType: string;
}

export interface IoConnection {
  fromRole: string;
  toRole: string;
  [k: string]: unknown;
}

export interface IoPort {
  members: { role: string; port?: string }[];
  [k: string]: unknown;
}

export interface IoDefinition {
  roles: IoRole[];
  connections: IoConnection[];
  interface?: { inputs?: IoPort[]; outputs?: IoPort[] };
  [k: string]: unknown;
}

export interface IoExport {
  version: number;
  name: string;
  definition: IoDefinition;
  bindings?: IoBinding[];
  alertRules?: IoAlertRoute[];
}

/** Rollenbindung für die Anzeige: „Nutzer — Rolle — Recht“. Die Rolle `*` (ganzer Workflow) heißt „ganzer Workflow“. */
export function describeBinding(b: IoBinding, wholeWorkflowLabel = "ganzer Workflow", groupLabel = "Gruppe", userLabel = "Nutzer"): string {
  const role = b.role === "" || b.role === "*" ? wholeWorkflowLabel : b.role;
  const isGroup = b.subjectType === "group";
  // Name statt ID: eine Gruppen-ID ist nur eine Zeichenkette; ohne Namen (alte Datei) wird die ID gekürzt gezeigt
  const who = b.subjectName || (isGroup && b.subject.length > 12 ? b.subject.slice(0, 8) + "…" : b.subject);
  return `${isGroup ? groupLabel : userLabel} ${who} — ${role} — ${b.verb}`;
}

/** Alarmregel für die Anzeige: Name, Arten/Schweregrade und Empfänger. */
export function describeAlertRoute(r: IoAlertRoute): string {
  const parts: string[] = [r.name || "(ohne Namen)"];
  const what = [...(r.kinds ?? []), ...(r.severities ?? [])];
  if (what.length > 0) parts.push(what.join(", "));
  if (r.to) parts.push(`→ ${r.to}`);
  if (!r.enabled) parts.push("(aus)");
  return parts.join(" · ");
}

/** Die Datei so beschneiden, wie der Nutzer es gewählt hat: ohne Haken verlassen Bindungen/Alarmregeln den Workflow nicht. */
export function applyExportChoices(exp: IoExport, choice: { bindings: boolean; alerts: boolean }): IoExport {
  const out: IoExport = { ...exp };
  if (!choice.bindings) delete out.bindings;
  if (!choice.alerts) delete out.alertRules;
  return out;
}

/**
 * Vorschlag für die neuen Rollennamen beim Duplizieren. Enthält ein Rollenname den alten Workflow-Namen (ohne Rücksicht auf
 * Groß-/Kleinschreibung), wird er durch den neuen ersetzt; alle anderen bekommen den neuen Namen als Zusatz
 * („Mischer“ → „Mischer – Regie 2“). Ohne Umbenennung bleibt jeder Name, wie er ist.
 */
export function proposeRoleNames(roles: IoRole[], oldName: string, newName: string, rename: boolean): Record<string, string> {
  const map: Record<string, string> = {};
  const old = oldName.trim();
  const fresh = newName.trim();
  for (const r of roles) {
    if (!rename || !fresh) {
      map[r.name] = r.name;
      continue;
    }
    if (old && r.name.toLowerCase().includes(old.toLowerCase())) {
      map[r.name] = r.name.replace(new RegExp(old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), () => fresh);
    } else {
      map[r.name] = `${r.name} – ${fresh}`;
    }
  }
  return map;
}

/** Prüft die neuen Rollennamen: keiner leer, keiner doppelt. Gibt die Meldung (deutsch) oder null zurück. */
export function validateRoleNames(map: Record<string, string>): string | null {
  const seen = new Set<string>();
  for (const v of Object.values(map)) {
    const name = v.trim();
    if (!name) return "empty";
    if (seen.has(name)) return "duplicate";
    seen.add(name);
  }
  return null;
}

/** Benennt Rollen in der ganzen Definition um: Rollenliste, Verbindungen und die Mitglieder der Schnittstellen-Ein-/Ausgänge. */
export function renameRolesInExport(exp: IoExport, map: Record<string, string>): IoExport {
  const to = (n: string) => (map[n] ?? n).trim();
  const def = exp.definition;
  const port = (p: IoPort): IoPort => ({ ...p, members: p.members.map((m) => ({ ...m, role: to(m.role) })) });
  const definition: IoDefinition = {
    ...def,
    roles: def.roles.map((r) => ({ ...r, name: to(r.name) })),
    connections: def.connections.map((c) => ({ ...c, fromRole: to(c.fromRole), toRole: to(c.toRole) })),
  };
  if (def.interface) {
    definition.interface = {
      ...def.interface,
      ...(def.interface.inputs ? { inputs: def.interface.inputs.map(port) } : {}),
      ...(def.interface.outputs ? { outputs: def.interface.outputs.map(port) } : {}),
    };
  }
  const out: IoExport = { ...exp, definition };
  if (exp.bindings) out.bindings = exp.bindings.map((b) => ({ ...b, role: map[b.role] !== undefined ? to(b.role) : b.role }));
  return out;
}

export interface ImportIssue {
  level: "error" | "warn" | "info";
  code: string;
  message: string;
  role?: string;
}

export interface DefinitionDiff {
  rolesAdded?: string[];
  rolesRemoved?: string[];
  rolesChanged?: string[];
  connectionsAdded: number;
  connectionsRemoved: number;
  settingsChanged: boolean;
  schedulesChanged: boolean;
}

/** Antwort von POST /api/v1/workflows/import/preview. */
export interface ImportReport {
  name: string;
  exists?: { id: string; name: string; status: string; canReplace: boolean };
  newName: string;
  issues: ImportIssue[];
  diff?: DefinitionDiff;
  fileVersion?: string;
  currentVersion: string;
  canImport: boolean;
}

/** Was „ersetzen“ am vorhandenen Workflow ändern würde, als eine Zeile je Punkt. Leer = keine Unterschiede. */
export function describeDiff(d: DefinitionDiff): string[] {
  const out: string[] = [];
  const list = (n: string[] | undefined) => (n ?? []).join(", ");
  if (d.rolesAdded?.length) out.push(`+ ${d.rolesAdded.length} Rolle${d.rolesAdded.length === 1 ? "" : "n"}: ${list(d.rolesAdded)}`);
  if (d.rolesRemoved?.length) out.push(`− ${d.rolesRemoved.length} Rolle${d.rolesRemoved.length === 1 ? "" : "n"}: ${list(d.rolesRemoved)}`);
  if (d.rolesChanged?.length) out.push(`~ ${d.rolesChanged.length} Rolle${d.rolesChanged.length === 1 ? "" : "n"} geändert: ${list(d.rolesChanged)}`);
  if (d.connectionsAdded || d.connectionsRemoved) out.push(`Verbindungen: +${d.connectionsAdded} / −${d.connectionsRemoved}`);
  if (d.settingsChanged) out.push("Einstellungen geändert");
  if (d.schedulesChanged) out.push("Zeitpläne geändert");
  return out;
}
