// Reine Graph-Logik für <omp-process-editor> (Kapitel 21 Phase 6 Teil 2)
// — DOM-frei, per `deno test` geprüft, gleiches Trennungsmuster wie
// geometry.ts/compatibility.ts/groups.ts/role-designer-logic.ts. Eigene
// Datei statt Teil von process-editor.ts, aus demselben Grund wie dort
// dokumentiert (role-designer.ts-Kopfkommentar): das Custom Element
// importiert transitiv DOM-Globals, die unter `deno test` nicht
// existieren.
//
// DraftStep spiegelt orchestrator/internal/process/types.go Step 1:1
// im Wire-Format (JSON-Feldnamen identisch) — der Editor produziert am
// Ende exakt das JSON, das process.Definition.Validate()/
// Store.CreateVersion erwartet, ohne Transformation.

export interface RetryPolicy {
  maxAttempts: number;
  backoff?: string;
  initialDelay?: string;
  maxDelay?: string;
}

export interface DraftStep {
  id: string;
  type: string;
  name?: string;
  // Wie im Backend json.RawMessage: hier als bereits geparstes unknown
  // gehalten (der Editor selbst validiert Config nie inhaltlich — das
  // bleibt Aufgabe der jeweiligen Runtime-Executors, A1-A5), nur beim
  // Laden/Speichern serialisiert.
  config?: unknown;
  next?: string[];
  branches?: Record<string, string>;
  retry?: RetryPolicy;
  timeoutSeconds?: number;
  compensationStepId?: string;
}

export interface DraftDefinition {
  steps: DraftStep[];
  startStepId: string;
  // Event-Trigger (A8) referenzieren keine Schritt-IDs — der Editor
  // bearbeitet sie (noch) nicht, reicht sie aber unverändert durch,
  // damit "Version als Basis bearbeiten" einen bestehenden Trigger
  // nicht stillschweigend verliert.
  triggers?: unknown[];
}

// Die kanonische Liste aller 17 Step-Typen aus der Aufgabenstellung
// (orchestrator/internal/process/types.go StepType-Konstanten) — auch
// die zur Laufzeit noch unregistrierten (loop/event_trigger, s. dortige
// Moduldoku) sind hier wählbar: der Editor bildet das vollständige
// Domain-Modell ab, ob ein Typ heute schon einen Executor hat, ist eine
// Runtime-Frage, keine Graph-Struktur-Frage (Definition.Validate()
// prüft ebenfalls nur Struktur, keine Executor-Verfügbarkeit).
export const STEP_TYPES = [
  "task",
  "media_function",
  "service_call",
  "script",
  "condition",
  "branch",
  "parallel",
  "join",
  "loop",
  "wait",
  "timer",
  "human_task",
  "approval",
  "notification",
  "event_trigger",
  "subworkflow",
  "compensation",
] as const;

export type StepType = (typeof STEP_TYPES)[number];

// uniqueStepId: Schritt-ID aus dem Typ ableiten, eindeutig gemacht bei
// mehreren Schritten desselben Typs — gleiches Muster wie
// roles.ts#uniqueRoleName (dort für Rollennamen aus Node-Typen).
export function uniqueStepId(type: string, used: Set<string>): string {
  if (!used.has(type)) return type;
  let i = 2;
  while (used.has(`${type}_${i}`)) i++;
  return `${type}_${i}`;
}

export function addStep(def: DraftDefinition, id: string, type: string): DraftDefinition {
  const step: DraftStep = { id, type };
  const steps = [...def.steps, step];
  // Der allererste Schritt wird automatisch zum Start-Schritt — ein
  // frisch angelegter Graph ohne Start-Schritt wäre sonst sofort
  // ungültig (Definition.Validate() verlangt startStepId), ohne dass
  // der Nutzer das beim Anlegen des ersten Blocks schon wissen müsste.
  const startStepId = def.startStepId || id;
  return { ...def, steps, startStepId };
}

// removeStep: entfernt einen Schritt und jede Referenz auf ihn — eine
// Kante/ein Branch/eine compensationStepId ohne ihr Ziel wäre ein
// Definitions-Torso, den das Backend (Definition.Validate()) ohnehin
// ablehnen würde (gleicher Grund wie role-designer-logic.ts#removeRole).
export function removeStep(def: DraftDefinition, id: string): DraftDefinition {
  const steps = def.steps
    .filter((s) => s.id !== id)
    .map((s) => {
      const next = s.next?.filter((n) => n !== id);
      const branches = s.branches
        ? Object.fromEntries(Object.entries(s.branches).filter(([, target]) => target !== id))
        : undefined;
      const compensationStepId = s.compensationStepId === id ? undefined : s.compensationStepId;
      return { ...s, next, branches, compensationStepId };
    });
  const startStepId = def.startStepId === id ? "" : def.startStepId;
  return { ...def, steps, startStepId };
}

// renameStepId: aktualisiert jede next-/branches-/compensationStepId-/
// startStepId-Referenz mit — sonst bräche jede Umbenennung stillschweigend
// den Graphen (gleiches Muster wie role-designer-logic.ts#renameRole,
// dort für Rollennamen statt Schritt-IDs). ok=false bei leerer/
// duplizierter ID statt eines stillen No-Op.
export function renameStepId(
  def: DraftDefinition,
  oldId: string,
  newId: string,
): { def: DraftDefinition; ok: boolean } {
  const trimmed = newId.trim();
  if (!trimmed || trimmed === oldId) return { def, ok: false };
  if (def.steps.some((s) => s.id === trimmed)) return { def, ok: false };
  if (!def.steps.some((s) => s.id === oldId)) return { def, ok: false };

  const steps = def.steps.map((s) => {
    const renamed = s.id === oldId ? { ...s, id: trimmed } : s;
    const next = renamed.next?.map((n) => (n === oldId ? trimmed : n));
    const branches = renamed.branches
      ? Object.fromEntries(Object.entries(renamed.branches).map(([label, target]) => [label, target === oldId ? trimmed : target]))
      : undefined;
    const compensationStepId = renamed.compensationStepId === oldId ? trimmed : renamed.compensationStepId;
    return { ...renamed, next, branches, compensationStepId };
  });
  const startStepId = def.startStepId === oldId ? trimmed : def.startStepId;
  return { def: { ...def, steps, startStepId }, ok: true };
}

// addNextConnection: unbedingte Kante (AND-Fan-out-fähig, s.
// engine.go computeFrontier-Doku) — lehnt Selbstschleifen und exakte
// Duplikate ab statt sie still zu ignorieren (gleiches Muster wie
// role-designer-logic.ts#addConnection).
export function addNextConnection(
  def: DraftDefinition,
  fromId: string,
  toId: string,
): { def: DraftDefinition; ok: boolean } {
  if (!fromId || !toId || fromId === toId) return { def, ok: false };
  const from = def.steps.find((s) => s.id === fromId);
  if (!from) return { def, ok: false };
  if (from.next?.includes(toId)) return { def, ok: false };
  const steps = def.steps.map((s) => (s.id === fromId ? { ...s, next: [...(s.next ?? []), toId] } : s));
  return { def: { ...def, steps }, ok: true };
}

export function removeNextConnection(def: DraftDefinition, fromId: string, toId: string): DraftDefinition {
  const steps = def.steps.map((s) => (s.id === fromId ? { ...s, next: s.next?.filter((n) => n !== toId) } : s));
  return { ...def, steps };
}

// addBranchConnection: bedingte Kante über ein Label (Condition/Branch/
// HumanTask/Approval-Entscheidungsrouting, s. engine.go
// resolveSuccessors-Doku) — jedes label ist innerhalb EINES Schritts
// eindeutig (branches ist eine Map, ein zweites addBranchConnection mit
// demselben label ersetzt bewusst das Ziel, wie die Map-Semantik es
// ohnehin täte — kein separater Ablehnungsfall nötig, anders als bei
// addNextConnection, wo ein Duplikat sonst zwei ununterscheidbare
// Pfeile zur selben Kachel zeichnen würde).
export function addBranchConnection(
  def: DraftDefinition,
  fromId: string,
  label: string,
  toId: string,
): { def: DraftDefinition; ok: boolean } {
  const trimmedLabel = label.trim();
  if (!fromId || !toId || !trimmedLabel || fromId === toId) return { def, ok: false };
  const from = def.steps.find((s) => s.id === fromId);
  if (!from) return { def, ok: false };
  const steps = def.steps.map((s) =>
    s.id === fromId ? { ...s, branches: { ...(s.branches ?? {}), [trimmedLabel]: toId } } : s
  );
  return { def: { ...def, steps }, ok: true };
}

export function removeBranchConnection(def: DraftDefinition, fromId: string, label: string): DraftDefinition {
  const steps = def.steps.map((s) => {
    if (s.id !== fromId || !s.branches) return s;
    const branches = { ...s.branches };
    delete branches[label];
    return { ...s, branches };
  });
  return { ...def, steps };
}

export function setStartStep(def: DraftDefinition, id: string): DraftDefinition {
  if (!def.steps.some((s) => s.id === id)) return def;
  return { ...def, startStepId: id };
}

export function setCompensationStep(def: DraftDefinition, id: string, compensationStepId: string | undefined): DraftDefinition {
  const steps = def.steps.map((s) => (s.id === id ? { ...s, compensationStepId } : s));
  return { ...def, steps };
}

export function updateStepFields(
  def: DraftDefinition,
  id: string,
  fields: Partial<Pick<DraftStep, "name" | "config" | "retry" | "timeoutSeconds">>,
): DraftDefinition {
  const steps = def.steps.map((s) => (s.id === id ? { ...s, ...fields } : s));
  return { ...def, steps };
}
