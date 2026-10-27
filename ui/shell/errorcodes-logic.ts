// Fehlercodes (UMSETZUNG.md Kap. 72.8): der Katalog aus GET /api/v1/errorcodes und die Zuordnung von Meldungen zu Codes.
// Dieselbe Zuordnung wie im Server (Code in der Meldung zuerst, dann das erste passende Muster), damit auch Texte, die nicht
// über den Server laufen (Fehler im Startdialog, Absturzmeldungen), einen Code bekommen.

export interface ErrorCode {
  code: string;
  severity: "error" | "warn" | "info";
  title: string;
  cause: string;
  steps: string[];
  match?: string;
  doc: string;
}

const TAG = /\bOMP-(\d{4})\b/;
const compiled = new Map<string, RegExp | null>();

function regexFor(e: ErrorCode): RegExp | null {
  if (!e.match) return null;
  let re = compiled.get(e.code + e.match);
  if (re === undefined) {
    try {
      re = new RegExp(e.match, "i");
    } catch {
      re = null; // ein nicht portables Muster darf die Anzeige nie stören
    }
    compiled.set(e.code + e.match, re);
  }
  return re;
}

export function lookup(list: ErrorCode[], code: string | undefined): ErrorCode | undefined {
  if (!code) return undefined;
  const c = code.toUpperCase();
  return list.find((e) => e.code === c);
}

/** Ordnet eine Meldung einem Code zu: erst ein „OMP-nnnn“ in der Meldung, sonst das erste passende Muster. */
export function classify(list: ErrorCode[], message: string): ErrorCode | undefined {
  const tag = TAG.exec(message);
  if (tag) {
    const e = lookup(list, tag[0]);
    if (e) return e;
  }
  for (const e of list) {
    const re = regexFor(e);
    if (re?.test(message)) return e;
  }
  return undefined;
}

/** Link zur Beschreibung im Handbuch (docs/FEHLERCODES.md). */
export function docPath(e: ErrorCode): string {
  return `docs/${e.doc}`;
}
