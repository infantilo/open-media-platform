// Reine Logik des Auslöser-Dialogs (DOM-frei, per `deno test` geprüft): Ereignissuche, Autovervollständigung im Filter-Ausdruck,
// Beispielwerte aus der letzten Nutzlast, Zeitangabe „vor …“.
import type { TriggerKind } from "./process-step-config-logic.ts";

/** Sucht in Name, Subject und Gruppe; mehrere Wörter müssen alle vorkommen. Treffer im Namen zuerst. */
export function searchKinds(kinds: TriggerKind[], query: string, groupLabel: (g: string) => string = (g) => g): TriggerKind[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return kinds;
  const scored: { k: TriggerKind; score: number }[] = [];
  for (const k of kinds) {
    const label = k.label.toLowerCase();
    const hay = `${label} ${k.subject.toLowerCase()} ${groupLabel(k.group ?? "").toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) continue;
    scored.push({ k, score: words.every((w) => label.includes(w)) ? 0 : 1 });
  }
  return scored.sort((a, b) => a.score - b.score).map((x) => x.k);
}

export interface Suggestion {
  label: string; // Anzeige
  insert: string; // einzusetzender Text
  kind: "field" | "operator" | "keyword";
  hint?: string; // z. B. Beispielwert
}

export interface SuggestResult {
  from: number; // zu ersetzender Bereich [from,to)
  to: number;
  items: Suggestion[];
}

const OPERATORS: Suggestion[] = [
  { label: "==", insert: "== ", kind: "operator" },
  { label: "!=", insert: "!= ", kind: "operator" },
  { label: ">", insert: "> ", kind: "operator" },
  { label: "<", insert: "< ", kind: "operator" },
  { label: "contains", insert: "contains ", kind: "operator" },
  { label: "startsWith", insert: "startsWith ", kind: "operator" },
  { label: "endsWith", insert: "endsWith ", kind: "operator" },
  { label: "matches", insert: "matches ", kind: "operator" },
  { label: "in", insert: "in [", kind: "operator" },
  { label: "&&", insert: "&& ", kind: "keyword" },
  { label: "||", insert: "|| ", kind: "keyword" },
];

/** Wert unter einem Punktpfad der Beispiel-Nutzlast (undefined, wenn es ihn nicht gibt). */
export function valueAt(sample: unknown, path: string): unknown {
  let cur: unknown = sample;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function previewValue(v: unknown): string {
  if (v === undefined) return "";
  const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  return s.length > 40 ? s.slice(0, 37) + "…" : s;
}

/**
 * Vorschläge an der Cursorposition: nach einem Teilwort die passenden Felder (input.<Pfad>, subject), nach einem vollständigen
 * Operanden die Operatoren, am Anfang/nach && und || alle Felder.
 */
export function suggest(text: string, caret: number, fieldPaths: string[], sample?: unknown): SuggestResult {
  const before = text.slice(0, caret);
  const m = /[A-Za-z_][\w.]*$/.exec(before);
  const word = m ? m[0] : "";
  const from = caret - word.length;
  const fieldItem = (p: string): Suggestion => ({ label: `input.${p}`, insert: `input.${p}`, kind: "field", hint: previewValue(valueAt(sample, p)) });
  const allFields = (): Suggestion[] => [...fieldPaths.map(fieldItem), { label: "subject", insert: "subject", kind: "field" }];
  if (word) {
    const lw = word.toLowerCase();
    const items = allFields().filter((s) => s.label.toLowerCase().includes(lw) && s.label !== word);
    const ops = word.length >= 1 && !word.startsWith("input") && !word.startsWith("subject") ? OPERATORS.filter((o) => /^[a-z]/i.test(o.label) && o.label.toLowerCase().startsWith(lw)) : [];
    items.sort((a, b) => Number(b.label.toLowerCase().startsWith(lw)) - Number(a.label.toLowerCase().startsWith(lw)));
    return { from, to: caret, items: [...items, ...ops].slice(0, 12) };
  }
  const prev = before.trimEnd();
  if (!prev || /(&&|\|\||\(|!)$/.test(prev)) return { from: caret, to: caret, items: allFields().slice(0, 12) };
  if (/[\w\])"']$/.test(prev) && /\s$/.test(before)) {
    // nach einem Operanden: Operatoren; nach einem Vergleich (==, … Wert) logische Verknüpfungen
    const cmp = /(==|!=|>=|<=|>|<|contains|startsWith|endsWith|matches|in)\s+("[^"]*"|'[^']*'|[\w.\-]+|\[[^\]]*\])\s*$/.test(prev);
    return { from: caret, to: caret, items: cmp ? OPERATORS.filter((o) => o.kind === "keyword") : OPERATORS.filter((o) => o.kind === "operator") };
  }
  return { from: caret, to: caret, items: [] };
}

export function applySuggestion(text: string, r: SuggestResult, item: Suggestion): { text: string; caret: number } {
  const out = text.slice(0, r.from) + item.insert + text.slice(r.to);
  return { text: out, caret: r.from + item.insert.length };
}

/** „vor 3 min“ / „3 min ago“ */
export function relTime(iso: string | undefined, now: number, lang: string): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  const [n, u] = s < 90 ? [s, "s"] : s < 5400 ? [Math.round(s / 60), "min"] : s < 129600 ? [Math.round(s / 3600), "h"] : [Math.round(s / 86400), lang === "de" ? "d" : "d"];
  return lang === "de" ? `vor ${n} ${u}` : `${n} ${u} ago`;
}
