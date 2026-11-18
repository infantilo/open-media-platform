// Reine Logik der Domain-Ansicht im Flow-Editor (Kap. 103, ohne DOM, testbar): welche Domain hat eine Instanz, welche
// Zonen gibt es, welche Farbe trägt eine Domain.

export const DEFAULT_DOMAIN = "default";

export interface DomainInfo {
  name: string;
  path?: string;
  description?: string;
  default?: boolean;
  flows?: number;
  instances?: number;
}

/** Domainname einer Instanz (extraEnv `OMP_MXL_DOMAIN_NAME`); ohne Eintrag die Standarddomain. */
export function instanceDomain(inst: { extraEnv?: Record<string, string> } | undefined): string {
  const n = inst?.extraEnv?.OMP_MXL_DOMAIN_NAME;
  return n && n !== "" ? n : DEFAULT_DOMAIN;
}

/** Zieldomain einer Domain-Brücke (extraEnv `OMP_MXL_TARGET_DOMAIN_NAME`); sonst leer. */
export function instanceTargetDomain(inst: { extraEnv?: Record<string, string> } | undefined): string {
  return inst?.extraEnv?.OMP_MXL_TARGET_DOMAIN_NAME ?? "";
}

/** Text des Domain-Reiters: "name" bzw. bei einer Brücke "eingang → ziel". */
export function domainTabText(inputDomain: string, targetDomain: string): string {
  return targetDomain ? `${inputDomain} → ${targetDomain}` : inputDomain;
}

/** Domain einer Workflow-Rolle: die der Rolle, sonst die des Workflows, sonst Standard. */
export function roleDomain(role: { domain?: string } | undefined, settings: { domain?: string } | undefined): string {
  const d = role?.domain || settings?.domain || "";
  return d === "" ? DEFAULT_DOMAIN : d;
}

/** Zone eines (nicht gestarteten) Workflows in der Domain-Ansicht: die gemeinsame Domain aller Rollen, sonst "mixed". */
export function workflowDomainZone(
  roles: { domain?: string }[] | undefined,
  settings: { domain?: string } | undefined,
): string {
  const set = new Set((roles ?? []).map((r) => roleDomain(r, settings)));
  if (set.size === 0) return roleDomain(undefined, settings);
  return set.size === 1 ? [...set][0] : "mixed";
}

export interface DomainZone {
  id: string;
  label: string;
  subtitle?: string;
}

/**
 * Zonen der Domain-Ansicht: Standarddomain zuerst, dann die angelegten Domains nach Namen, dann Domains, die nur
 * Instanzen nennen, aber nicht (mehr) angelegt sind (z. B. nach Löschen des Eintrags) — sie sollen nicht verschwinden.
 */
export function domainZones(known: DomainInfo[], usedNames: Iterable<string>): DomainZone[] {
  const info = new Map(known.map((d) => [d.default ? DEFAULT_DOMAIN : d.name, d]));
  const names = new Set<string>([DEFAULT_DOMAIN]);
  for (const k of [...info.keys()].sort()) names.add(k);
  const extra = [...new Set(usedNames)].filter((n) => !names.has(n) && n !== "mixed").sort();
  const out: DomainZone[] = [];
  for (const n of [...names, ...extra]) {
    const d = info.get(n);
    out.push({ id: n, label: n === DEFAULT_DOMAIN ? DEFAULT_DOMAIN : n, subtitle: d?.description || (d || n === DEFAULT_DOMAIN ? "" : "nicht angelegt") });
  }
  return out;
}

const HUES = [210, 28, 150, 285, 340, 55, 185, 100];

/** Stabile Farbe je Domainname (Standarddomain neutral); `alpha` (0–1) für Tönungen von Flächen. */
export function domainColor(name: string, alpha?: number): string {
  if (name === DEFAULT_DOMAIN || name === "") return alpha === undefined ? "#7c8798" : `rgba(124,135,152,${alpha})`;
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = HUES[h % HUES.length];
  return alpha === undefined ? `hsl(${hue} 62% 58%)` : `hsl(${hue} 62% 58% / ${alpha})`;
}

/** Kurzname eines Hosts für Kachel-Reiter: Platzhalter für den Orchestrator-Rechner, sonst das Label, gekürzt. */
export function hostChipLabel(hostLabel: string | undefined, localLabel: string, max = 16): string {
  const l = (hostLabel ?? "").trim() || localLabel;
  return l.length > max ? l.slice(0, max - 1) + "…" : l;
}

/** Eindeutige, sortierte Hostnamen für die Zusammenfassung im Zonenkopf. */
export function hostSummary(hostLabels: string[]): { count: number; text: string } {
  const set = [...new Set(hostLabels.filter((h) => h !== ""))].sort((a, b) => a.localeCompare(b));
  return { count: set.length, text: set.join(", ") };
}

/** Ob die Oberfläche Domains überhaupt anbieten soll: es gibt mindestens eine angelegte außer der Standarddomain. */
export function hasNamedDomains(known: DomainInfo[]): boolean {
  return known.some((d) => !d.default && d.name !== DEFAULT_DOMAIN);
}
