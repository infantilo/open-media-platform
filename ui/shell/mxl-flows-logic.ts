// Reine Logik der MXL-Flow-Ansicht (ohne DOM, testbar).

export interface FlowRow {
  id: string;
  label?: string;
  format?: string;
  active: boolean;
  stale: boolean;
  sizeBytes: number;
  writers: { pid: number; cmd?: string; container?: string }[];
  instance?: string;
  instanceLabel?: string;
  instanceType?: string;
}

export interface DomainRow {
  name: string;
  path: string;
  description?: string;
  default?: boolean;
  /** Abgeschottet (D7): Nodes laufen in einer Mount-Sandbox, die nur diese Domain sieht. */
  isolated?: boolean;
  flows: number;
  stale: number;
  instances: number;
}

/** Text einer Domain in der Auswahl: Name, Flows, Instanzen (Wörter für die Sprache übergeben). */
export function domainOptionLabel(d: DomainRow, flowsWord = "flows", instWord = "inst."): string {
  return `${d.isolated ? "🔒 " : ""}${d.default ? "default" : d.name} — ${d.flows} ${flowsWord}, ${d.instances} ${instWord}`;
}

export function formatName(f: string | undefined): string {
  return (f ?? "").replace("urn:x-nmos:format:", "") || "–";
}

export function humanSize(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} kB`;
}

export function matchesFlow(r: FlowRow, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [
    r.id,
    r.label,
    r.format,
    r.instanceLabel,
    r.instanceType,
    ...r.writers.flatMap((w) => [String(w.pid), w.cmd, w.container]),
  ].join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}
