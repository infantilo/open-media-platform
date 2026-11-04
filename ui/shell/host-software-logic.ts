// Software-Stand der Hosts (Kap. 85): reine Logik für die Anzeige „welcher Host läuft mit welcher Version“.

export interface Build {
  version: string;
  commit?: string;
  builtAt?: string;
  release?: string;
}

export interface SwNode {
  type: string;
  runner: string;
  binary?: string;
  version?: string;
  commit?: string;
  builtAt?: string;
  modified?: string;
  size?: number;
  source?: string;
  error?: string;
  running: number;
  outdated?: number;
}

export interface SwHost {
  hostId: string;
  label: string;
  local?: boolean;
  online: boolean;
  agent?: Build;
  nodes: SwNode[];
  error?: string;
}

export interface SwReport {
  orchestrator: Build;
  hosts: SwHost[];
}

/** Kurzbeschreibung eines Builds: „v0.7.0+31 · 6f3c1a2“ bzw. „2026.11.1 · 6f3c1a2“. */
export function buildLabel(b: Build | undefined): string {
  if (!b) return "–";
  const main = b.version && b.version !== "dev" ? b.version : b.release || b.version || "dev";
  return [main, b.commit].filter(Boolean).join(" · ");
}

/** Weicht der Agent vom Orchestrator ab? Verglichen wird der Commit (sonst die Version); ohne Angabe: nein. */
export function deviates(agent: Build | undefined, orch: Build): boolean {
  if (!agent) return false;
  if (agent.commit && orch.commit) return agent.commit !== orch.commit;
  if (agent.version && orch.version && agent.version !== "dev" && orch.version !== "dev") return agent.version !== orch.version;
  return false;
}

/** Ein Node-Typ ohne lesbare Version (kein Stempel, kein Image-Stand). */
export function unstamped(n: SwNode): boolean {
  return !n.version;
}

/** Anzeige der Version eines Node-Typs. */
export function nodeVersion(n: SwNode): string {
  if (n.version) return n.version;
  return "–";
}

/** Zusammenfassung je Host: Anzahl Typen, laufende Instanzen, veraltete Instanzen. */
export function hostSummary(h: SwHost): { types: number; running: number; outdated: number } {
  return { types: h.nodes.length, running: h.nodes.reduce((a, n) => a + n.running, 0), outdated: h.nodes.reduce((a, n) => a + (n.outdated ?? 0), 0) };
}

/** Typen, die auf mehreren Hosts mit unterschiedlicher Version/Commit liegen — Abweichungen auf einen Blick. */
export function mixedVersions(hosts: SwHost[]): Map<string, string[]> {
  const seen = new Map<string, Set<string>>();
  for (const h of hosts) {
    for (const n of h.nodes) {
      if (n.runner === "podman" && !n.version) continue;
      const v = `${n.version ?? ""}|${n.commit ?? ""}`;
      if (!seen.has(n.type)) seen.set(n.type, new Set());
      seen.get(n.type)!.add(v);
    }
  }
  const out = new Map<string, string[]>();
  for (const [type, set] of seen) if (set.size > 1) out.set(type, [...set]);
  return out;
}

/** Zeitstempel kurz („2026-11-04 14:05“), leer wenn unlesbar. */
export function shortTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---- Älter/neuer (Markierung „Host mit älterem Stand“) ----------------------------------------------------------

/** Numerischer Versionsvergleich je Punkt-Segment („2026.10.0“ < „2026.11.1“); Zusätze nach - oder + zählen nicht. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parts = (v: string) => v.split(/[-+]/)[0].split(".").map((x) => parseInt(x, 10) || 0);
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

const isReal = (v: string | undefined): v is string => !!v && v !== "dev";
const TOLERANCE_MS = 5 * 60_000;

function byTime(a: string | undefined, b: string | undefined, tolerance: number): -1 | 0 | 1 | null {
  if (!a || !b) return null;
  const ta = Date.parse(a), tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  if (Math.abs(ta - tb) <= tolerance) return 0;
  return ta < tb ? -1 : 1;
}

/**
 * Ordnet zwei Stände (-1 = a älter, 1 = a neuer, 0 = gleich), null wenn sich die Reihenfolge nicht sicher bestimmen lässt.
 * Reihenfolge: echte Versionsnummern; sonst gleicher Commit = gleich; sonst Bauzeit; zuletzt (nur Dev-Builds ohne
 * Bauzeit) gleiche Dateigröße = gleich, sonst Dateizeit — die nur als Anhaltspunkt (Installationszeit).
 */
export function compareBuilds(
  a: { version?: string; commit?: string; builtAt?: string; modified?: string; size?: number; release?: string },
  b: { version?: string; commit?: string; builtAt?: string; modified?: string; size?: number; release?: string },
): -1 | 0 | 1 | null {
  if (isReal(a.version) && isReal(b.version)) return compareVersions(a.version, b.version);
  if (a.commit && b.commit) {
    if (a.commit === b.commit) return 0;
    return byTime(a.builtAt, b.builtAt, 0);
  }
  const t = byTime(a.builtAt, b.builtAt, TOLERANCE_MS);
  if (t !== null) return t;
  if (a.size !== undefined && b.size !== undefined && a.size === b.size) return 0;
  return byTime(a.modified, b.modified, TOLERANCE_MS);
}

export interface OlderNode {
  type: string;
  /** Host mit dem neueren Stand. */
  newerOn: string;
  newer: string;
}

export interface HostStale {
  hostId: string;
  label: string;
  /** Host-Agent (bzw. Orchestrator) ist älter als der Orchestrator. */
  agentOlder: boolean;
  nodes: OlderNode[];
}

/** Hosts mit älterem Stand: Agent älter als der Orchestrator, Node-Typen älter als der neueste Stand desselben Typs irgendwo. */
export function staleHosts(rep: SwReport): Map<string, HostStale> {
  const newest = new Map<string, { node: SwNode; host: SwHost }>();
  for (const h of rep.hosts) {
    for (const n of h.nodes) {
      if (!n.version || n.runner === "podman") continue;
      const cur = newest.get(n.type);
      if (!cur || compareBuilds(n, cur.node) === 1) newest.set(n.type, { node: n, host: h });
    }
  }
  const out = new Map<string, HostStale>();
  for (const h of rep.hosts) {
    const key = h.hostId || "local";
    const st: HostStale = { hostId: key, label: h.label, agentOlder: !h.local && compareBuilds(h.agent ?? { version: "" }, rep.orchestrator) === -1, nodes: [] };
    for (const n of h.nodes) {
      const ref = newest.get(n.type);
      if (!ref || ref.host === h || !n.version || n.runner === "podman") continue;
      if (compareBuilds(n, ref.node) === -1) st.nodes.push({ type: n.type, newerOn: ref.host.label, newer: nodeVersion(ref.node) + (ref.node.commit ? ` · ${ref.node.commit}` : "") });
    }
    if (st.agentOlder || st.nodes.length > 0) out.set(key, st);
  }
  return out;
}
