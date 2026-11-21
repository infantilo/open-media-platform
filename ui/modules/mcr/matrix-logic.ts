// Reine Logik der Matrix-Ansicht (106.15e): Quellen in Zeilen, Leitungen in Spalten, Kreuzpunkt = Quelle gehört zur Leitung.
// Datenform wie im Leitungsformular: `transport.existing = {nodeId, nodeLabel, videoSenderId?, audioSenderId?, audioTracks?}`.
// Eine Leitung hat genau einen Quell-Node (der Normalizer hat je Leitung einen Bild- und einen Ton-Empfänger).

export const FMT_VIDEO = "urn:x-nmos:format:video";
export const FMT_AUDIO = "urn:x-nmos:format:audio";
export const FMT_DATA = "urn:x-nmos:format:data";

export interface MxSender { id: string; label: string; format: string; channel_count?: number }
export interface MxNode { id: string; label: string; online: boolean; senders: MxSender[] }
export interface MxTrack { label?: string; channels: number[] }
/** Bild, Ton und Daten haben je einen eigenen Node (`videoNodeId` …); `nodeId` ist nur die ältere gemeinsame Quelle. */
export interface MxExisting {
  nodeId?: string; nodeLabel?: string; videoSenderId?: string; audioSenderId?: string; audioTracks?: MxTrack[];
  videoNodeId?: string; videoNodeLabel?: string; audioNodeId?: string; audioNodeLabel?: string; dataNodeId?: string; dataNodeLabel?: string; dataSenderId?: string;
}
export interface MxLine { id?: string; name: string; kind?: string; transport: Record<string, unknown> & { existing?: MxExisting } }

/** Eine wählbare Quellzeile der Matrix. */
export type MxRow =
  | { type: "video"; node: MxNode; sender: MxSender; key: string; label: string }
  | { type: "data"; node: MxNode; sender: MxSender; key: string; label: string }
  | { type: "audio"; node: MxNode; sender: MxSender; channels: number[]; key: string; label: string };

export function videoSenders(n: MxNode): MxSender[] { return n.senders.filter((s) => s.format === FMT_VIDEO); }
export function audioSenders(n: MxNode): MxSender[] { return n.senders.filter((s) => s.format === FMT_AUDIO); }
export function dataSenders(n: MxNode): MxSender[] { return n.senders.filter((s) => s.format === FMT_DATA); }

/** Kanalgruppen einer Tonquelle: Stereo-Paare, ein ungerader Rest als Einzelkanal. Unbekannte Kanalzahl → 2 (ein Paar). */
export function channelGroups(count: number | undefined): number[][] {
  const n = count && count > 0 ? count : 2;
  const out: number[][] = [];
  for (let c = 1; c + 1 <= n; c += 2) out.push([c, c + 1]);
  if (n % 2 === 1) out.push([n]);
  return out;
}

/** Zeilen eines Nodes: je Bild-Flow eine Zeile, je Ton-Flow eine Zeile je Kanalgruppe, je Daten-Flow eine Zeile. */
export function rowsOf(n: MxNode): MxRow[] {
  const rows: MxRow[] = [];
  for (const s of videoSenders(n)) rows.push({ type: "video", node: n, sender: s, key: `${n.id}|v|${s.id}`, label: s.label });
  const aud = audioSenders(n);
  for (const s of aud) {
    for (const g of channelGroups(s.channel_count)) {
      const range = g.length === 2 ? `${g[0]}/${g[1]}` : `${g[0]}`;
      rows.push({ type: "audio", node: n, sender: s, channels: g, key: `${n.id}|a|${s.id}|${g.join(",")}`, label: aud.length > 1 ? `${s.label} · ${range}` : range });
    }
  }
  for (const s of dataSenders(n)) rows.push({ type: "data", node: n, sender: s, key: `${n.id}|d|${s.id}`, label: s.label });
  return rows;
}

const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Ältere Leitungen (eine gemeinsame Quelle `nodeId`) werden zu je einem Node für Bild und Ton aufgelöst. */
export function normalize(ex: MxExisting | undefined): MxExisting {
  const o: MxExisting = { ...(ex ?? {}) };
  if (o.nodeId || o.nodeLabel) {
    if (!o.videoNodeId && !o.videoNodeLabel) { o.videoNodeId = o.nodeId; o.videoNodeLabel = o.nodeLabel; }
    if (!o.audioNodeId && !o.audioNodeLabel) { o.audioNodeId = o.nodeId; o.audioNodeLabel = o.nodeLabel; }
    delete o.nodeId;
    delete o.nodeLabel;
  }
  return o;
}

/** Ist die Zeile Teil der Leitung? „Automatisch“ (leere Sender-ID) zählt als erster passender Flow des Nodes. */
export function isOn(line: MxLine, row: MxRow): boolean {
  const ex = normalize(line.transport?.existing);
  if (row.type === "video") return ex.videoNodeId === row.node.id && (ex.videoSenderId || videoSenders(row.node)[0]?.id) === row.sender.id;
  if (row.type === "data") return ex.dataNodeId === row.node.id && (ex.dataSenderId || dataSenders(row.node)[0]?.id) === row.sender.id;
  if (ex.audioNodeId !== row.node.id || (ex.audioSenderId || audioSenders(row.node)[0]?.id) !== row.sender.id) return false;
  return (ex.audioTracks ?? []).some((tr) => same(tr.channels, row.channels));
}

/** Die Leitung nutzt für diese Art schon einen anderen Node → die Zelle würde ihn ersetzen. */
export function isOtherSource(line: MxLine, row: MxRow): boolean {
  const ex = normalize(line.transport?.existing);
  const cur = row.type === "video" ? ex.videoNodeId : row.type === "data" ? ex.dataNodeId : ex.audioNodeId;
  return !!cur && cur !== row.node.id;
}

/** Liefert die Leitung nach einem Klick auf den Kreuzpunkt (neues Objekt). Bild, Ton und Daten sind voneinander unabhängig. */
export function toggle(line: MxLine, row: MxRow): MxLine {
  const ex = normalize(line.transport?.existing);
  if (row.type === "video") {
    if (isOn(line, row)) { delete ex.videoNodeId; delete ex.videoNodeLabel; delete ex.videoSenderId; }
    else { ex.videoNodeId = row.node.id; ex.videoNodeLabel = row.node.label; ex.videoSenderId = row.sender.id; }
  } else if (row.type === "data") {
    if (isOn(line, row)) { delete ex.dataNodeId; delete ex.dataNodeLabel; delete ex.dataSenderId; }
    else { ex.dataNodeId = row.node.id; ex.dataNodeLabel = row.node.label; ex.dataSenderId = row.sender.id; }
  } else {
    let tracks = [...(ex.audioTracks ?? [])];
    const wasOn = isOn(line, row);
    if (ex.audioNodeId !== row.node.id || (ex.audioSenderId && ex.audioSenderId !== row.sender.id)) tracks = []; // andere Tonquelle: bisherige Spuren gelten nicht mehr
    if (wasOn) tracks = tracks.filter((tr) => !same(tr.channels, row.channels));
    else tracks.push({ channels: row.channels });
    tracks.sort((a, b) => a.channels[0] - b.channels[0]);
    if (tracks.length) {
      ex.audioNodeId = row.node.id; ex.audioNodeLabel = row.node.label; ex.audioSenderId = row.sender.id; ex.audioTracks = tracks;
    } else { delete ex.audioNodeId; delete ex.audioNodeLabel; delete ex.audioSenderId; delete ex.audioTracks; }
  }
  const transport: MxLine["transport"] = { ...line.transport };
  if (Object.keys(ex).length) transport.existing = ex;
  else delete transport.existing;
  return { ...line, transport };
}

/** Kurztext zur Quelle einer Leitung (Spaltenkopf): die beteiligten Nodes je Art. */
export function sourceSummary(line: MxLine): { video: string; audio: string; data: string; tracks: number } | null {
  const ex = normalize(line.transport?.existing);
  const v = ex.videoNodeLabel || ex.videoNodeId || "", a = ex.audioNodeLabel || ex.audioNodeId || "", d = ex.dataNodeLabel || ex.dataNodeId || "";
  if (!v && !a && !d) return null;
  return { video: v, audio: a, data: d, tracks: ex.audioTracks?.length ?? 0 };
}

/** Filter für die Suche: Node- oder Flow-Name enthält den Text. Gibt die Zeilen eines Nodes zurück, leer = Node ausblenden. */
export function filterRows(n: MxNode, q: string): MxRow[] {
  const rows = rowsOf(n);
  const s = q.trim().toLowerCase();
  if (!s || n.label.toLowerCase().includes(s)) return rows;
  return rows.filter((r) => r.label.toLowerCase().includes(s) || r.sender.label.toLowerCase().includes(s));
}
