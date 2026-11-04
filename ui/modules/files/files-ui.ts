// Gemeinsame Bausteine der Dateien-Oberflächen (Kapitel 86): Stile, Hilfsfunktionen, Dialog.
import { apiFetch, getLang, t } from "../host.ts";

export interface Root {
  id: string; name: string; hostId: string; path: string; role: string; readOnly: boolean; shared?: boolean; hosts?: string[];
  trashDays?: number; emergencyFreeGb?: number; emergencyFreePct?: number; lockBeforeH?: number; lockAfterH?: number;
  free?: number; total?: number; reachable?: boolean; error?: string; trashItems?: number;
  mount?: { state: string; since?: string; message?: string; activeHost?: string };
}
export interface Cfg {
  trashDays: number; emergencyFreeGb: number; emergencyFreePct: number; graceMinutes: number; lockBeforeH: number; lockAfterH: number;
  plannedIsHard: boolean; checkEveryMin: number; checkBatch: number; sweepEveryMin: number;
}

export const DIM = "color:var(--omp-text-dim);font-size:var(--omp-font-size-sm);";
export const CARD = "background:var(--omp-surface-raised);border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:12px;margin-bottom:12px;";
export const INPUT = "background:var(--omp-bg);color:var(--omp-text);border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:4px 6px;font:inherit;";
export const TH = "text-align:left;padding:4px 8px;font-weight:600;border-bottom:1px solid var(--omp-border);white-space:nowrap;";
export const TD = "padding:4px 8px;border-bottom:1px solid var(--omp-border);vertical-align:top;";
export const STATE_COLOR: Record<string, string> = { present: "var(--omp-ok, #3a3)", missing: "var(--omp-danger, #d44)", unreachable: "var(--omp-warn, #db3)", unknown: "var(--omp-text-dim)", unchecked: "var(--omp-text-dim)" };
export const ROLES = ["media", "import", "proxy", "subtitle", "recording", "output", "other"];

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, style = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (style) e.style.cssText = style;
  if (text) e.textContent = text;
  return e;
}
export function btn(label: string, on: () => void, opts: { disabled?: boolean; danger?: boolean; role?: string } = {}): HTMLButtonElement {
  const b = el("button", "cursor:pointer;" + (opts.danger ? "color:var(--omp-danger,#d44);" : ""), label);
  b.disabled = !!opts.disabled;
  if (opts.role) b.setAttribute("data-role", opts.role);
  b.addEventListener("click", on);
  return b;
}
export function pill(text: string, color: string): HTMLElement {
  return el("span", `display:inline-block;padding:0 6px;border-radius:8px;border:1px solid ${color};color:${color};font-size:var(--omp-font-size-xs);white-space:nowrap;`, text);
}
export const roleLabel = (r?: string): string => (r ? t(`filesv.role.${r}`) === `filesv.role.${r}` ? r : t(`filesv.role.${r}`) : "");
export const stateLabel = (s?: string): string => (s ? (t(`filesv.state.${s}`) === `filesv.state.${s}` ? s : t(`filesv.state.${s}`)) : "");
export const hostLabel = (h: string): string => (h ? t("filesv.root.host", { p0: h }) : t("filesv.root.host.local"));
export const fmtMs = (ms?: number): string => (ms ? new Date(ms).toLocaleString(getLang() === "de" ? "de-DE" : "en-GB") : "–");

export async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* kein JSON */ }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}
export const post = (url: string, body: unknown) => apiFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** Einfacher Dialog (Überlagerung); build füllt das Feld, close schließt. */
export function openModal(title: string, build: (box: HTMLElement, close: () => void) => void): void {
  const overlay = el("div", "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:1000;display:flex;align-items:center;justify-content:center;");
  const box = el("div", "background:var(--omp-surface-raised);color:var(--omp-text);border:1px solid var(--omp-border);border-radius:var(--omp-radius);padding:16px;width:min(860px,94vw);max-height:88vh;overflow:auto;");
  box.append(el("h3", "margin:0 0 10px;font-size:var(--omp-font-size-md);", title));
  const close = () => overlay.remove();
  build(box, close);
  overlay.append(box);
  document.body.append(overlay);
}
