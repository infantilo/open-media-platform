// Fehlercodes in der Oberfläche: Katalog laden (einmal je Sprache) und als kleines Hilfe-Element darstellen —
// Code-Plakette, Ursache und nummerierte Lösungsschritte. UMSETZUNG.md Kap. 72.8.
import { apiFetch } from "./connection.ts";
import { setToastEnhancer } from "../kit/omp-toast.ts";
import { getLang, t } from "./i18n.ts";
import { classify, docPath, type ErrorCode, lookup } from "./errorcodes-logic.ts";

export { classify, lookup };
export type { ErrorCode };

let cached: { lang: string; list: Promise<ErrorCode[]> } | null = null;

/** Der Katalog in der aktuellen Sprache; bei einem Fehler leer (die Anzeige funktioniert dann ohne Codes). */
export function loadErrorCodes(): Promise<ErrorCode[]> {
  const lang = getLang();
  if (cached && cached.lang === lang) return cached.list;
  const list = (async () => {
    try {
      const res = await apiFetch("/api/v1/errorcodes");
      return res.ok ? ((await res.json()) as ErrorCode[]) : [];
    } catch {
      return [];
    }
  })();
  cached = { lang, list };
  // Ein leerer Katalog (Orchestrator kurz nicht erreichbar) wird beim nächsten Mal neu versucht.
  void list.then((l) => {
    if (l.length === 0 && cached?.list === list) cached = null;
  });
  return list;
}

const SEV_COLOR = { error: "var(--omp-error,#e05252)", warn: "#e0a020", info: "var(--omp-accent,#19d3f3)" };

/** Kleine Plakette „OMP-2004“. */
export function codeBadge(e: ErrorCode): HTMLElement {
  const b = document.createElement("span");
  b.textContent = e.code;
  b.title = `${e.title} — ${t("ec.badge")}`;
  b.setAttribute("data-role", "error-code");
  b.style.cssText = `font-size:10.5px;font-weight:600;letter-spacing:.03em;padding:1px 6px;border-radius:9px;border:1px solid ${SEV_COLOR[e.severity]};color:${SEV_COLOR[e.severity]};white-space:nowrap;`;
  return b;
}

/** Ursache und Lösungsschritte eines Codes als Block (z. B. unter einer Meldung). */
export function helpBlock(e: ErrorCode): HTMLElement {
  const box = document.createElement("div");
  box.setAttribute("data-role", "error-help");
  box.style.cssText = "margin-top:6px;font-size:var(--omp-font-size-xs,12px);color:var(--omp-text,#e8eaed);";
  const cause = document.createElement("div");
  const lead = document.createElement("strong");
  lead.textContent = t("ec.cause") + " ";
  cause.append(lead, document.createTextNode(e.cause));
  box.append(cause);
  const head = document.createElement("div");
  head.style.cssText = "margin-top:4px;font-weight:600;";
  head.textContent = t("ec.steps");
  const ol = document.createElement("ol");
  ol.style.cssText = "margin:2px 0 0 18px;padding:0;";
  for (const s of e.steps) {
    const li = document.createElement("li");
    li.textContent = s;
    ol.append(li);
  }
  const doc = document.createElement("div");
  doc.style.cssText = "margin-top:4px;color:var(--omp-text-dim,#9aa0a6);";
  doc.textContent = t("ec.doc", { code: e.code, path: docPath(e) });
  box.append(head, ol, doc);
  return box;
}

/** Aufklappbare Hilfe zu einem Code: Plakette + „Ursache und Schritte“. */
export function helpDetails(e: ErrorCode): HTMLElement {
  const d = document.createElement("details");
  d.setAttribute("data-keep", `ec-${e.code}`);
  d.style.cssText = "margin-top:4px;";
  const s = document.createElement("summary");
  s.style.cssText = "cursor:pointer;display:flex;gap:8px;align-items:center;";
  s.append(codeBadge(e), Object.assign(document.createElement("span"), { textContent: t("ec.more") }));
  d.append(s, helpBlock(e));
  return d;
}

/** Fehler-Toasts bekommen den Code angehängt, sobald der Katalog geladen ist (einmal beim Start der Shell aufrufen). */
export function installToastCodes(): void {
  void loadErrorCodes().then((list) => {
    if (list.length > 0) setToastEnhancer((msg) => classify(list, msg)?.code);
  });
}
