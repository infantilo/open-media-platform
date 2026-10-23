// Reine Logik der Job-Ansicht (ohne DOM): Zielauswahl, Pfadzuordnung als Zeilen, Prozent ↔ Anteil, Zustandstexte.

export interface HostInfo {
  ID: string;
  Label: string;
  Local?: boolean;
  Online: boolean;
  Maintenance?: boolean;
  Capable: boolean;
  CPUPercent: number;
  MemUsedPct: number;
  Gpu?: { UtilPercent: number; MemUsedPct: number } | null;
  MaxJobs: number;
  Running: number;
  Reserved: number;
  LiveInstances: number;
  Pools?: string[] | null;
  BatchOnly?: boolean;
  NoBatch?: boolean;
  Disabled?: boolean;
}

export interface TargetOption {
  value: string;
  label: string;
}

/** Ziele für Auswahlfelder: auto, lokal, jeder Host, jeder Pool. `current` bleibt auswählbar, auch wenn es das Ziel nicht (mehr) gibt. */
export function targetOptions(hosts: HostInfo[], pools: string[], current: string, labels: { auto: string; local: string; host: string; pool: string }): TargetOption[] {
  const out: TargetOption[] = [{ value: "auto", label: labels.auto }, { value: "local", label: labels.local }];
  for (const h of hosts) {
    if (h.Local) continue;
    out.push({ value: `host:${h.ID}`, label: `${labels.host} ${h.Label || h.ID}` });
  }
  for (const p of pools) out.push({ value: `pool:${p}`, label: `${labels.pool} ${p}` });
  if (current && !out.some((o) => o.value === current)) out.push({ value: current, label: current });
  return out;
}

export interface PathRow {
  prefix: string;
  host: string;
  hostPrefix: string;
}

/** pathMap {orchestratorPräfix: {hostId: hostPräfix}} ⇄ Tabellenzeilen. */
export function pathRows(m: Record<string, Record<string, string>> | undefined | null): PathRow[] {
  const rows: PathRow[] = [];
  for (const prefix of Object.keys(m ?? {}).sort()) {
    for (const host of Object.keys(m![prefix]).sort()) rows.push({ prefix, host, hostPrefix: m![prefix][host] });
  }
  return rows;
}

export function pathMapFromRows(rows: PathRow[]): { map: Record<string, Record<string, string>>; error?: string } {
  const map: Record<string, Record<string, string>> = {};
  for (const r of rows) {
    const prefix = r.prefix.trim();
    const host = r.host.trim();
    const hp = r.hostPrefix.trim();
    if (prefix === "" && host === "" && hp === "") continue; // leere Zeile
    if (!prefix.startsWith("/") || !hp.startsWith("/") || host === "") return { map, error: `${prefix || "?"} → ${host || "?"} → ${hp || "?"}` };
    (map[prefix] ??= {})[host] = hp;
  }
  return { map };
}

/** Anteil (0–1) ⇄ ganze Prozent für Eingabefelder. */
export const toPercent = (f: number): number => Math.round(f * 1000) / 10;
export const fromPercent = (p: number): number => Math.round(p * 10) / 1000;

/** Auslastung gegen eine Grenze: "ok" | "warn" (≥ 90 % der Grenze) | "full". */
export function loadLevel(value: number, limit: number): "ok" | "warn" | "full" {
  if (limit <= 0) return "ok";
  const r = value / limit;
  return r >= 1 ? "full" : r >= 0.9 ? "warn" : "ok";
}

/** "1:05" / "2 h 03" aus Sekunden. */
export function fmtDuration(totalS: number): string {
  const s = Math.max(0, Math.round(totalS));
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
