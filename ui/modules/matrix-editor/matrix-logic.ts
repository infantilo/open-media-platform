// Reine Logik des Matrix-Editors von `omp-audio-matrix` (Kapitel 107.3): Modell, Prüfung (spiegelt `omp_mediaio::matrix`),
// Kreuzpunkte setzen und Schnellaktionen. Ohne DOM, damit testbar. Alle Funktionen liefern eine neue Konfiguration.

export const MAX_INPUTS = 16;
export const MAX_OUTPUTS = 32;
export const MAX_CHANNELS = 64;
export const MAX_SOURCES = 16;
export const GAIN_MIN = -120;
export const GAIN_MAX = 24;

/** Symbole nach VSF TR-03 Anhang A (IS-04 v1.3 `source_audio.channels[].symbol`). */
export const SYMBOLS = ["L", "R", "C", "LFE", "Ls", "Rs", "Lss", "Rss", "Lrs", "Rrs", "Lc", "Rc", "Cs", "HI", "VIN", "M1", "M2", "Lt", "Rt", "Lst", "Rst", "S"];

export interface Channel {
  label: string;
  symbol?: string;
}
export interface Port {
  id: string;
  name: string;
  channels: Channel[];
}
export interface Route {
  out: string;
  ch: number;
  in: string;
  inCh: number;
  gainDb?: number;
}
export interface MatrixConfig {
  inputs: Port[];
  outputs: Port[];
  routes: Route[];
}

export function validSymbol(s: string): boolean {
  if (SYMBOLS.includes(s)) return true;
  const n = (rest: string, digits: number, lo: number, hi: number) => rest.length === digits && /^\d+$/.test(rest) && Number(rest) >= lo && Number(rest) <= hi;
  if (s.startsWith("NSC")) return n(s.slice(3), 3, 0, 128);
  if (s.startsWith("U")) return n(s.slice(1), 2, 1, 64);
  return false;
}

const chan = (c: unknown): Channel => {
  if (typeof c === "string") return { label: c };
  const o = (c ?? {}) as { label?: unknown; symbol?: unknown };
  const r: Channel = { label: String(o.label ?? "") };
  if (typeof o.symbol === "string" && o.symbol) r.symbol = o.symbol;
  return r;
};

const port = (p: unknown): Port => {
  const o = (p ?? {}) as { id?: unknown; name?: unknown; channels?: unknown };
  return { id: String(o.id ?? ""), name: String(o.name ?? ""), channels: Array.isArray(o.channels) ? o.channels.map(chan) : [] };
};

/** Liest die Konfiguration aus dem JSON-Text oder Objekt des Nodes (tolerant; fehlende Teile werden leer). */
export function normalize(raw: unknown): MatrixConfig {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      v = {};
    }
  }
  const o = (v ?? {}) as { inputs?: unknown; outputs?: unknown; routes?: unknown };
  const routes: Route[] = Array.isArray(o.routes)
    ? o.routes.map((r) => {
      const x = r as { out?: unknown; ch?: unknown; in?: unknown; inCh?: unknown; gainDb?: unknown };
      const route: Route = { out: String(x.out ?? ""), ch: Number(x.ch), in: String(x.in ?? ""), inCh: Number(x.inCh) };
      if (typeof x.gainDb === "number" && x.gainDb !== 0) route.gainDb = x.gainDb;
      return route;
    })
    : [];
  return { inputs: Array.isArray(o.inputs) ? o.inputs.map(port) : [], outputs: Array.isArray(o.outputs) ? o.outputs.map(port) : [], routes };
}

export const clone = (c: MatrixConfig): MatrixConfig => JSON.parse(JSON.stringify(c));
export const sameConfig = (a: MatrixConfig, b: MatrixConfig): boolean => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

/** Erste Verletzung der Regeln des Nodes als Text (de), sonst null. */
export function validate(c: MatrixConfig): string | null {
  const ports = (list: Port[], kind: string, max: number): string | null => {
    if (list.length > max) return `höchstens ${max} ${kind}`;
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const p of list) {
      const id = p.id.trim();
      const name = p.name.trim();
      if (!id) return `${kind}: ID leer`;
      if (!name || name.length > 40) return `${kind} „${id}“: Name leer oder länger als 40 Zeichen`;
      if (ids.has(id)) return `${kind}: ID „${id}“ doppelt`;
      if (names.has(name)) return `${kind}: Name „${name}“ doppelt`;
      ids.add(id);
      names.add(name);
      if (p.channels.length < 1 || p.channels.length > MAX_CHANNELS) return `${kind} „${name}“: 1…${MAX_CHANNELS} Kanäle`;
      for (const [i, ch] of p.channels.entries()) {
        if (ch.label.length > 40) return `${kind} „${name}“: Kanal ${i + 1} Label zu lang`;
        if (ch.symbol && !validSymbol(ch.symbol)) return `${kind} „${name}“: Kanal ${i + 1} Symbol „${ch.symbol}“ unbekannt (VSF TR-03 Anhang A)`;
      }
    }
    return null;
  };
  const e = ports(c.inputs, "Eingang", MAX_INPUTS) ?? ports(c.outputs, "Ausgang", MAX_OUTPUTS);
  if (e) return e;
  const seen = new Set<string>();
  const perTarget = new Map<string, number>();
  for (const r of c.routes) {
    const o = c.outputs.find((p) => p.id === r.out);
    const i = c.inputs.find((p) => p.id === r.in);
    if (!o) return `Kreuzpunkt: Ausgang „${r.out}“ gibt es nicht`;
    if (!i) return `Kreuzpunkt: Eingang „${r.in}“ gibt es nicht`;
    if (!Number.isInteger(r.ch) || r.ch < 1 || r.ch > o.channels.length) return `Kreuzpunkt: Ausgang „${o.name}“ hat keinen Kanal ${r.ch}`;
    if (!Number.isInteger(r.inCh) || r.inCh < 1 || r.inCh > i.channels.length) return `Kreuzpunkt: Eingang „${i.name}“ hat keinen Kanal ${r.inCh}`;
    if (r.gainDb !== undefined && !(Number.isFinite(r.gainDb) && r.gainDb >= GAIN_MIN && r.gainDb <= GAIN_MAX)) return `Gain ${r.gainDb} dB außerhalb ${GAIN_MIN}…${GAIN_MAX}`;
    const key = `${r.out}|${r.ch}|${r.in}|${r.inCh}`;
    if (seen.has(key)) return "Kreuzpunkt doppelt";
    seen.add(key);
    const t = `${r.out}|${r.ch}`;
    const n = (perTarget.get(t) ?? 0) + 1;
    perTarget.set(t, n);
    if (n > MAX_SOURCES) return `Ausgang „${o.name}“ Kanal ${r.ch}: höchstens ${MAX_SOURCES} Quellen`;
  }
  return null;
}

// ── Kreuzpunkte ────────────────────────────────────────────────────────────────────────────────────────────────

export const routesOf = (c: MatrixConfig, out: string, ch: number): Route[] => c.routes.filter((r) => r.out === out && r.ch === ch);
export const findRoute = (c: MatrixConfig, out: string, ch: number, inId: string, inCh: number): Route | undefined =>
  c.routes.find((r) => r.out === out && r.ch === ch && r.in === inId && r.inCh === inCh);

/** Art eines Ausgangskanals: keine Quelle, bitgleiche Kopie (eine Quelle ohne Gain) oder Mischen (Gain/mehrere Quellen). */
export function kindOf(c: MatrixConfig, out: string, ch: number): "none" | "copy" | "mix" {
  const r = routesOf(c, out, ch);
  if (r.length === 0) return "none";
  return r.length === 1 && !r[0].gainDb ? "copy" : "mix";
}

/**
 * Klick auf einen Kreuzpunkt. Ohne `add`: Kreuzpunkt aus → an und alle anderen Quellen des Ausgangskanals fallen weg (Umschalten wie
 * bei einer Kreuzschiene); ist er schon der einzige, wird er entfernt. Mit `add`: Quelle zusätzlich (Summe) oder einzeln entfernen.
 */
export function clickCell(c: MatrixConfig, out: string, ch: number, inId: string, inCh: number, add = false): MatrixConfig {
  const n = clone(c);
  const here = findRoute(n, out, ch, inId, inCh);
  const others = routesOf(n, out, ch).filter((r) => r !== here);
  const keep = (r: Route) => !(r.out === out && r.ch === ch);
  if (add) {
    if (here) n.routes = n.routes.filter((r) => !(r.out === out && r.ch === ch && r.in === inId && r.inCh === inCh));
    else n.routes.push({ out, ch, in: inId, inCh });
    return n;
  }
  if (here && others.length === 0) {
    n.routes = n.routes.filter(keep);
    return n;
  }
  n.routes = n.routes.filter(keep);
  n.routes.push({ out, ch, in: inId, inCh });
  return n;
}

/** Gain eines Kreuzpunkts (dB); 0 oder undefined = ohne Gain. */
export function setGain(c: MatrixConfig, out: string, ch: number, inId: string, inCh: number, gainDb: number | undefined): MatrixConfig {
  const n = clone(c);
  const r = findRoute(n, out, ch, inId, inCh);
  if (!r) return n;
  if (gainDb === undefined || gainDb === 0 || Number.isNaN(gainDb)) delete r.gainDb;
  else r.gainDb = Math.min(GAIN_MAX, Math.max(GAIN_MIN, gainDb));
  return n;
}

// ── Ports ──────────────────────────────────────────────────────────────────────────────────────────────────────

const nextFree = (taken: Set<string>, base: string, sep: string): string => {
  for (let i = 1; i < 1000; i++) {
    const t = `${base}${sep}${i}`;
    if (!taken.has(t)) return t;
  }
  return `${base}${sep}x`;
};

const labels = (n: number): Channel[] => Array.from({ length: n }, (_, i) => ({ label: String(i + 1) }));

export function addPort(c: MatrixConfig, kind: "in" | "out", channelCount = 2, name?: string): MatrixConfig {
  const n = clone(c);
  const list = kind === "in" ? n.inputs : n.outputs;
  if (list.length >= (kind === "in" ? MAX_INPUTS : MAX_OUTPUTS)) return n;
  const id = nextFree(new Set(list.map((p) => p.id)), kind === "in" ? "in" : "out", "");
  const wanted = (name ?? "").trim();
  const nm = wanted && !list.some((p) => p.name === wanted) ? wanted : nextFree(new Set(list.map((p) => p.name)), kind === "in" ? "Input" : "Output", " ");
  list.push({ id, name: nm, channels: labels(Math.min(MAX_CHANNELS, Math.max(1, channelCount))) });
  return n;
}

export function removePort(c: MatrixConfig, kind: "in" | "out", id: string): MatrixConfig {
  const n = clone(c);
  if (kind === "in") {
    n.inputs = n.inputs.filter((p) => p.id !== id);
    n.routes = n.routes.filter((r) => r.in !== id);
  } else {
    n.outputs = n.outputs.filter((p) => p.id !== id);
    n.routes = n.routes.filter((r) => r.out !== id);
  }
  return n;
}

export function renamePort(c: MatrixConfig, kind: "in" | "out", id: string, name: string): MatrixConfig {
  const n = clone(c);
  const p = (kind === "in" ? n.inputs : n.outputs).find((x) => x.id === id);
  if (p) p.name = name;
  return n;
}

/** Ändert die Kanalzahl eines Ports; Kreuzpunkte auf wegfallende Kanäle werden entfernt, neue Kanäle heißen „n“. */
export function setChannelCount(c: MatrixConfig, kind: "in" | "out", id: string, count: number): MatrixConfig {
  const n = clone(c);
  const p = (kind === "in" ? n.inputs : n.outputs).find((x) => x.id === id);
  if (!p) return n;
  const k = Math.min(MAX_CHANNELS, Math.max(1, Math.round(count)));
  while (p.channels.length < k) p.channels.push({ label: String(p.channels.length + 1) });
  p.channels.length = k;
  n.routes = n.routes.filter((r) => (kind === "in" ? r.in !== id || r.inCh <= k : r.out !== id || r.ch <= k));
  return n;
}

export function setChannel(c: MatrixConfig, kind: "in" | "out", id: string, ch: number, patch: Partial<Channel>): MatrixConfig {
  const n = clone(c);
  const p = (kind === "in" ? n.inputs : n.outputs).find((x) => x.id === id);
  const t = p?.channels[ch - 1];
  if (!t) return n;
  if (patch.label !== undefined) t.label = patch.label;
  if ("symbol" in patch) {
    if (patch.symbol) t.symbol = patch.symbol;
    else delete t.symbol;
  }
  return n;
}

// ── Schnellaktionen ────────────────────────────────────────────────────────────────────────────────────────────

/** Eingang Kanal für Kanal auf einen Ausgang legen (1:1, bis zur kleineren Kanalzahl; vorhandene Quellen dieser Kanäle fallen weg). */
export function routeStraight(c: MatrixConfig, inId: string, outId: string): MatrixConfig {
  const n = clone(c);
  const i = n.inputs.find((p) => p.id === inId);
  const o = n.outputs.find((p) => p.id === outId);
  if (!i || !o) return n;
  const k = Math.min(i.channels.length, o.channels.length);
  n.routes = n.routes.filter((r) => !(r.out === outId && r.ch <= k));
  for (let ch = 1; ch <= k; ch++) n.routes.push({ out: outId, ch, in: inId, inCh: ch });
  return n;
}

/** Ein Eingangskanal auf alle Kanäle eines Ausgangs (Mono → Stereo/…). */
export function monoToAll(c: MatrixConfig, inId: string, inCh: number, outId: string): MatrixConfig {
  const n = clone(c);
  const o = n.outputs.find((p) => p.id === outId);
  if (!o) return n;
  n.routes = n.routes.filter((r) => r.out !== outId);
  for (let ch = 1; ch <= o.channels.length; ch++) n.routes.push({ out: outId, ch, in: inId, inCh });
  return n;
}

export function clearOutput(c: MatrixConfig, outId: string): MatrixConfig {
  const n = clone(c);
  n.routes = n.routes.filter((r) => r.out !== outId);
  return n;
}

/** Legt je `size` Kanäle eines Eingangs einen neuen Ausgang an (size 1 = Einzelkanäle/Mono, 2 = Paare); Namen aus den Kanal-Labels. */
export function splitInput(c: MatrixConfig, inId: string, size: 1 | 2): MatrixConfig {
  let n = clone(c);
  const i = n.inputs.find((p) => p.id === inId);
  if (!i) return n;
  for (let a = 0; a < i.channels.length; a += size) {
    if (n.outputs.length >= MAX_OUTPUTS) break;
    const part = i.channels.slice(a, a + size);
    const base = part.map((x) => x.label || String(a + 1)).join("/");
    const taken = new Set(n.outputs.map((p) => p.name));
    const name = !taken.has(base) ? base : nextFree(taken, base, " ");
    n = addPort(n, "out", part.length, name);
    const o = n.outputs[n.outputs.length - 1];
    o.channels = part.map((x) => ({ ...x }));
    for (let k = 0; k < part.length; k++) n.routes.push({ out: o.id, ch: k + 1, in: inId, inCh: a + k + 1 });
  }
  return n;
}

/** Alle Eingänge hintereinander in einen neuen Ausgang (Kombinierer); bricht bei mehr als 64 Kanälen ab (gibt dann die Eingabe zurück). */
export function combineAll(c: MatrixConfig, name = "Combined"): MatrixConfig {
  const total = c.inputs.reduce((s, p) => s + p.channels.length, 0);
  if (total < 1 || total > MAX_CHANNELS || c.outputs.length >= MAX_OUTPUTS) return c;
  let n = addPort(c, "out", total, name);
  const o = n.outputs[n.outputs.length - 1];
  let ch = 0;
  o.channels = [];
  for (const p of c.inputs) {
    for (const [k, x] of p.channels.entries()) {
      ch++;
      o.channels.push({ ...x, label: x.label || String(ch) });
      n.routes.push({ out: o.id, ch, in: p.id, inCh: k + 1 });
    }
  }
  n = clone(n);
  return n;
}

/** Textanzeige des Gains in der Zelle: „−6“, „+3“ oder leer. */
export const gainText = (g: number | undefined): string => (!g ? "" : (g > 0 ? "+" : "−") + String(Math.abs(Math.round(g * 10) / 10)));
