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
