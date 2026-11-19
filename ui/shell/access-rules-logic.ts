// Reine Logik der Zugriffsregeln für Quellen und Senken (ohne DOM, testbar): Wire-Format, Anzeige als Satz, Gruppierung.

export interface AccessRule {
  id: string;
  subjectType: "global" | "user" | "group";
  subject?: string;
  kind: "source" | "sink";
  action: "see" | "route";
  effect: "allow" | "deny";
  selectorType: "all" | "endpoint" | "node" | "workflow" | "tag" | "media" | "label";
  selectorValue?: string;
  note?: string;
  createdBy?: string;
  createdAt?: string;
}

/** Namen für die Anzeige: ID → lesbarer Name (Gruppen, Nodes, Workflows, Endpunkte). */
export interface Lookups {
  groups: Map<string, string>;
  nodes: Map<string, string>;
  workflows: Map<string, string>;
  endpoints: Map<string, string>;
}

export function emptyLookups(): Lookups {
  return { groups: new Map(), nodes: new Map(), workflows: new Map(), endpoints: new Map() };
}

export const SELECTOR_TYPES: AccessRule["selectorType"][] = ["all", "node", "endpoint", "workflow", "tag", "media", "label"];

/** Wer: „Alle“, „Nutzer anna“, „Gruppe Bildmeister“ (Name statt ID). */
export function subjectLabel(r: Pick<AccessRule, "subjectType" | "subject">, lk: Lookups, words = { all: "Alle", user: "Nutzer", group: "Gruppe" }): string {
  if (r.subjectType === "global") return words.all;
  if (r.subjectType === "group") return `${words.group} ${lk.groups.get(r.subject ?? "") ?? shortId(r.subject ?? "")}`;
  return `${words.user} ${r.subject ?? ""}`;
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) + "…" : id;
}

/** Ziel der Regel: der Selektor als Text, mit Namen statt IDs, soweit bekannt. */
export function selectorLabel(
  r: Pick<AccessRule, "selectorType" | "selectorValue">,
  lk: Lookups,
  words: Record<string, string> = { all: "alles", node: "Node", endpoint: "Endpunkt", workflow: "Workflow", tag: "Tag", media: "Medientyp", label: "Name" },
): string {
  const v = r.selectorValue ?? "";
  switch (r.selectorType) {
    case "all":
      return words.all;
    case "node":
      return `${words.node} ${lk.nodes.get(v) ?? shortId(v)}`;
    case "endpoint":
      return `${words.endpoint} ${lk.endpoints.get(v) ?? shortId(v)}`;
    case "workflow":
      return `${words.workflow} ${lk.workflows.get(v) ?? shortId(v)}`;
    case "tag":
      return `${words.tag} ${v}`;
    case "media":
      return `${words.media} ${v}`;
    case "label":
      return `${words.label} „${v}“`;
  }
}

/** Sortierung: nach Wer (alle zuerst, dann Gruppen, dann Nutzer), dann Art, Handlung, Wirkung. */
export function sortRules(rules: AccessRule[], lk: Lookups): AccessRule[] {
  const rank = { global: 0, group: 1, user: 2 } as const;
  return [...rules].sort((a, b) =>
    rank[a.subjectType] - rank[b.subjectType] ||
    subjectLabel(a, lk).localeCompare(subjectLabel(b, lk)) ||
    a.kind.localeCompare(b.kind) ||
    a.action.localeCompare(b.action) ||
    a.effect.localeCompare(b.effect)
  );
}

/** Auf welche Art Regeln wirken sich Sperren/Freigabeliste aus: eine Zusammenfassung je Art und Handlung („Freigabeliste“/„nur Sperren“). */
export function modeOf(rules: AccessRule[], kind: "source" | "sink", action: "see" | "route"): "open" | "blacklist" | "whitelist" {
  const mine = rules.filter((r) => r.kind === kind && r.action === action);
  if (mine.some((r) => r.effect === "allow")) return "whitelist";
  if (mine.some((r) => r.effect === "deny")) return "blacklist";
  return "open";
}

/** Prüft ein Formular, bevor es gesendet wird. Gibt den Fehler-Schlüssel oder null zurück. */
export function validateDraft(d: Pick<AccessRule, "subjectType" | "subject" | "selectorType" | "selectorValue">): "subject" | "value" | null {
  if (d.subjectType !== "global" && !(d.subject ?? "").trim()) return "subject";
  if (d.selectorType !== "all" && !(d.selectorValue ?? "").trim()) return "value";
  return null;
}
