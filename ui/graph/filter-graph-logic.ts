// Reine Logik des visuellen Filter-Graph-Builders (UMSETZUNG.md Kapitel
// 22, W3) — DOM-frei, per `deno test` geprüft. Baut aus einem Graphen
// von Eingang-/Filter-/Ausgang-Knoten die tatsächliche
// `-filter_complex`-Zeichenkette + die zugehörigen `-map`-Kennungen, die
// als Argumente in den `script`-Schritt (W2, `buildConvertArgs`)
// eingesetzt werden.
//
// Baukasten-Prinzip (ARCHITECTURE.md §26.4): jeder Filter kommt aus der
// echten `/api/v1/tools/ffmpeg/filters`-Liste (W1) — keine
// eingebaute Positivliste, kein Sonderfall für einzelne Filter.

// ---- Filter-IO-Notation ("V->V", "AA->A", "N->N", "|->A") ----------------------------------------

export interface FilterPadSpec {
  count: number;
  dynamic: boolean; // "N" — Padzahl vom Nutzer einstellbar (s. GraphNode.inputCount/outputCount)
}

export interface FilterPadShape {
  inputs: FilterPadSpec;
  outputs: FilterPadSpec;
}

// `|` = Quelle/Senke ohne diese Seite (z.B. "|->A" für einen
// Audio-Generator-Filter ohne Eingang) — s. `ffmpeg -filters`-Legende.
function parseFilterIOSide(side: string): FilterPadSpec {
  if (side === "" || side === "|") return { count: 0, dynamic: false };
  if (side.includes("N")) return { count: 1, dynamic: true };
  return { count: side.length, dynamic: false };
}

export function parseFilterIO(io: string): FilterPadShape {
  const [left, right] = io.split("->");
  return { inputs: parseFilterIOSide(left ?? ""), outputs: parseFilterIOSide(right ?? "") };
}

// ---- Filter-Options-Spezifikation ("w=640:h=480") ------------------------------------------------

// ffmpegs Mini-Sprache für Filter-Argumente: Werte mit Sonderzeichen
// (Trenner der Sprache selbst, oder Leerraum) müssen in einfache
// Anführungszeichen — sonst würde z.B. ein Doppelpunkt im Wert als
// nächster Optionstrenner gelesen.
const FILTER_VALUE_NEEDS_QUOTE = /[:,;'[\]=\\ ]/;

export function escapeFilterOptionValue(value: string): string {
  if (!FILTER_VALUE_NEEDS_QUOTE.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function filterOptionsToSpec(options: Record<string, string>): string {
  return Object.entries(options)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}=${escapeFilterOptionValue(v)}`)
    .join(":");
}

// ---- Graph-Datenmodell ---------------------------------------------------------------------------

export type GraphNodeKind = "input" | "filter" | "output";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  // "input": label ist der rohe Stream-Spezifizierer, z.B. "0:v" — wird
  // in der erzeugten Zeichenkette als [0:v] referenziert.
  label?: string;
  // "filter": Name + IO-Form aus der W1-Filterliste, Options aus dessen
  // AVOptions (W1-Detail); inputCount/outputCount nur bei dynamischer
  // ("N") Padzahl relevant (sonst aus filterIO abgeleitet).
  filterName?: string;
  filterIO?: string;
  inputCount?: number;
  outputCount?: number;
  options?: Record<string, string>;
}

export interface GraphEdge {
  id: string;
  fromNode: string;
  fromPort: number; // Index unter den Ausgangs-Pads von fromNode
  toNode: string;
  toPort: number; // Index unter den Eingangs-Pads von toNode
}

export interface FilterGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// Tatsächliche Pad-Anzahl eines Knotens (löst "N"/dynamische Filter über
// das vom Nutzer gesetzte inputCount/outputCount auf).
export function nodePadCounts(node: GraphNode): { inputs: number; outputs: number } {
  if (node.kind === "input") return { inputs: 0, outputs: 1 };
  if (node.kind === "output") return { inputs: 1, outputs: 0 };
  const shape = parseFilterIO(node.filterIO ?? "");
  return {
    inputs: shape.inputs.dynamic ? Math.max(1, node.inputCount ?? shape.inputs.count) : shape.inputs.count,
    outputs: shape.outputs.dynamic ? Math.max(1, node.outputCount ?? shape.outputs.count) : shape.outputs.count,
  };
}

// ---- Topologische Reihenfolge (Kahn) --------------------------------------------------------------

// null = Zyklus (mindestens ein Knoten nie ohne offene eingehende Kante
// erreichbar) — ein Filter-Graph mit einer Rückkopplung ist kein Fehler
// des Compilers, sondern eine ungültige Nutzereingabe.
function dependencyOrder(nodes: GraphNode[], edges: GraphEdge[]): string[] | null {
  const ids = nodes.map((n) => n.id);
  const incoming = new Map<string, number>(ids.map((id) => [id, 0]));
  const outgoing = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    if (!incoming.has(e.toNode) || !outgoing.has(e.fromNode)) continue;
    outgoing.get(e.fromNode)!.push(e.toNode);
    incoming.set(e.toNode, (incoming.get(e.toNode) ?? 0) + 1);
  }
  const remaining = new Map(incoming);
  const queue = ids.filter((id) => remaining.get(id) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const left = (remaining.get(next) ?? 0) - 1;
      remaining.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  return order.length === ids.length ? order : null;
}

// ---- Kompilieren zu ffmpeg-Argumenten --------------------------------------------------------------

export interface CompiledFilterGraph {
  filterComplex: string;
  outputLabels: string[]; // je Ausgang-Knoten (in Knoten-Reihenfolge) das zu `-map`-ende Label
}

export type CompileResult = { ok: true; result: CompiledFilterGraph } | { ok: false; error: string };

export function compileFilterGraph(graph: FilterGraph): CompileResult {
  if (graph.nodes.filter((n) => n.kind === "output").length === 0) {
    return { ok: false, error: "Mindestens ein Ausgang ist nötig." };
  }

  const order = dependencyOrder(graph.nodes, graph.edges);
  if (!order) return { ok: false, error: "Der Filter-Graph enthält einen Kreis (eine Verbindung führt zyklisch zurück)." };

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const incomingByPort = (nodeId: string, port: number): GraphEdge | undefined =>
    graph.edges.find((e) => e.toNode === nodeId && e.toPort === port);

  // Label, das ein bestimmter Ausgangs-Pad liefert — Eingang-Knoten
  // liefern ihre rohe Kennung direkt, Filter-Knoten ein frisch
  // vergebenes Zwischen-Label (erst befüllt, sobald der Knoten in
  // Abhängigkeitsreihenfolge verarbeitet wird).
  const outputLabelOf = new Map<string, string>();
  for (const n of graph.nodes) {
    if (n.kind !== "input") continue;
    const label = n.label?.trim();
    if (!label) return { ok: false, error: `Eingang „${n.id}" hat keine Kennung (z. B. 0:v).` };
    outputLabelOf.set(`${n.id}:0`, label);
  }

  const segments: string[] = [];
  let labelCounter = 0;

  for (const id of order) {
    const node = nodeById.get(id)!;
    if (node.kind === "input") continue;

    const { inputs: inCount, outputs: outCount } = nodePadCounts(node);
    const inLabels: string[] = [];
    for (let i = 0; i < inCount; i++) {
      const edge = incomingByPort(id, i);
      if (!edge) {
        const what = node.kind === "output" ? `Ausgang „${node.label || id}"` : `Eingang ${i + 1} von „${node.filterName}"`;
        return { ok: false, error: `${what} ist nicht verbunden.` };
      }
      const label = outputLabelOf.get(`${edge.fromNode}:${edge.fromPort}`);
      if (!label) return { ok: false, error: `Interne Reihenfolge-Verletzung an Knoten „${id}" — bitte die Verbindung neu ziehen.` };
      inLabels.push(label);
    }

    if (node.kind === "output") continue; // erzeugt selbst kein Segment, nur eine -map-Kennung

    const outLabels: string[] = [];
    for (let o = 0; o < outCount; o++) {
      const label = `s${labelCounter++}`;
      outputLabelOf.set(`${id}:${o}`, label);
      outLabels.push(label);
    }
    const spec = filterOptionsToSpec(node.options ?? {});
    segments.push(`${inLabels.map((l) => `[${l}]`).join("")}${node.filterName}${spec ? "=" + spec : ""}${outLabels.map((l) => `[${l}]`).join("")}`);
  }

  const outputLabels = graph.nodes
    .filter((n) => n.kind === "output")
    .map((n) => outputLabelOf.get(`${incomingByPort(n.id, 0)!.fromNode}:${incomingByPort(n.id, 0)!.fromPort}`)!);

  return { ok: true, result: { filterComplex: segments.join(";"), outputLabels } };
}
