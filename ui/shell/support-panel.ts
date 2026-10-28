// Support (Admin → Support): "Ist mein System gesund?" als Ampel und das Support-Paket als ein Knopf.
//   • Ampel      — Befunde in Klartext mit nächstem Schritt, aktualisiert sich alle 30 s, solange der Tab offen ist
//   • Paket      — eine ZIP-Datei mit dem Zustand des Systems (ohne Medien, Passwörter und Tokens) für den Support
import { t } from "./i18n.ts";
import { apiFetch } from "./connection.ts";
import { confirmDialog } from "../kit/omp-confirm.ts";
import { freezeNow } from "./freeze.ts";
import { type AnReport, renderAnalysis } from "./analysis-view.ts";
import { getLang } from "./i18n.ts";
import { showToast } from "../kit/omp-toast.ts";
import { coverageKey, findFinding, sparkline, type TrendFinding, type TrendReport } from "./trends-logic.ts";
import { codeBadge, type ErrorCode, helpDetails, loadErrorCodes, lookup } from "./errorcodes.ts";
import {
  ACCESS_DURATIONS,
  type FreezeMeta,
  formatSize,
  freezeUrl,
  accessLink,
  BUNDLE_WINDOWS,
  bundleFileName,
  bundleUrl,
  levelColor,
  type SelftestReport,
  type SupportGrant,
  sortGrants,
  splitChecks,
} from "./support-logic.ts";

const REFRESH_MS = 30_000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

const CARD = "background:var(--omp-surface-raised);border:1px solid var(--omp-border);border-radius:8px;padding:12px 14px;margin-bottom:10px;";
const DIM = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);";

export class SupportPanel {
  readonly el: HTMLElement;
  #lamp = el("div", "width:44px;height:44px;border-radius:50%;flex:none;background:var(--omp-text-dim);");
  #summary = el("div", "font-size:var(--omp-font-size-lg,18px);font-weight:600;");
  #stamp = el("div", DIM);
  #list = el("div");
  #bundleState = el("div", DIM + "margin-top:8px;");
  #minutes = 120;
  #timer: number | undefined;
  #seq = 0;
  #busy = false;
  #grants = el("div");
  #freezes = el("div");
  #trends: TrendReport | null = null;
  #trendInfo = el("div", CARD);
  #newLink = el("div");
  #codes: ErrorCode[] = [];
  #last: SelftestReport | null = null;

  constructor() {
    this.el = el("div", "margin-bottom:var(--omp-space-4);max-width:900px;");
    const title = el("span", "", t("sup.title"));
    title.className = "omp-h1";
    const hint = el("div", DIM + "margin:4px 0 12px;", t("sup.hint"));

    const head = el("div", CARD + "display:flex;gap:14px;align-items:center;");
    const text = el("div", "flex:1;");
    text.append(this.#summary, this.#stamp);
    const again = el("button", "", t("sup.recheck"));
    again.className = "omp-btn";
    again.addEventListener("click", () => void this.refresh());
    head.append(this.#lamp, text, again);

    const pages: { id: string; label: string; nodes: HTMLElement[] }[] = [
      { id: "check", label: t("sup.tab.check"), nodes: [head, this.#list] },
      { id: "baseline", label: t("sup.tab.baseline"), nodes: [this.#trendInfo] },
      { id: "bundle", label: t("sup.tab.bundle"), nodes: [this.#bundleCard()] },
      { id: "freeze", label: t("sup.tab.freeze"), nodes: [this.#freezeCard()] },
      { id: "analysis", label: t("sup.tab.analysis"), nodes: [this.#analysisCard()] },
      { id: "access", label: t("sup.tab.access"), nodes: [this.#accessCard()] },
    ];
    this.el.append(title, hint, this.#subTabs(pages));
    void this.#loadGrants();
    void this.#loadFreezes();
    void loadErrorCodes().then((c) => {
      this.#codes = c;
      if (this.#last) this.#render(this.#last);
    });
  }

  // Untertabs: je Seite ein Container, nur der aktive ist sichtbar; die Wahl bleibt über das Neuladen erhalten.
  #subTabs(pages: { id: string; label: string; nodes: HTMLElement[] }[]): HTMLElement {
    const KEY = "omp.support.tab";
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(KEY);
    } catch {
      /* ohne Speicher: erster Tab */
    }
    let active = pages.some((p) => p.id === stored) ? (stored as string) : pages[0].id;
    const wrap = el("div");
    const bar = el("div", "display:flex;flex-wrap:wrap;gap:var(--omp-space-1);margin-bottom:12px;border-bottom:1px solid var(--omp-border);");
    bar.setAttribute("data-role", "support-sub-tabs");
    const bodies = new Map<string, HTMLElement>();
    const buttons = new Map<string, HTMLButtonElement>();
    const apply = () => {
      for (const p of pages) {
        const on = p.id === active;
        bodies.get(p.id)!.style.display = on ? "" : "none";
        const b = buttons.get(p.id)!;
        b.style.cssText =
          "background:none;border:none;cursor:pointer;padding:6px 12px;font:inherit;color:var(--omp-text);" +
          (on ? "border-bottom:2px solid var(--omp-accent-cyan);font-weight:600;" : "border-bottom:2px solid transparent;opacity:0.75;");
        b.setAttribute("aria-selected", String(on));
      }
    };
    for (const p of pages) {
      const b = el("button", "", p.label);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("data-tab-id", p.id);
      b.addEventListener("click", () => {
        active = p.id;
        try {
          localStorage.setItem(KEY, p.id);
        } catch {
          /* egal */
        }
        apply();
      });
      buttons.set(p.id, b);
      bar.append(b);
      const body = el("div");
      body.setAttribute("data-role", `support-page-${p.id}`);
      body.append(...p.nodes);
      bodies.set(p.id, body);
    }
    wrap.append(bar, ...bodies.values());
    apply();
    return wrap;
  }

  // Beim Anzeigen des Tabs aufrufen: lädt sofort und danach alle 30 s, bis das Panel nicht mehr im Dokument hängt.
  start() {
    void this.refresh();
    if (this.#timer !== undefined) return;
    this.#timer = window.setInterval(() => {
      if (!this.el.isConnected) {
        window.clearInterval(this.#timer);
        this.#timer = undefined;
        return;
      }
      void this.refresh();
    }, REFRESH_MS);
  }

  async refresh() {
    const seq = ++this.#seq;
    try {
      const res = await apiFetch("/api/v1/admin/selftest");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const report = (await res.json()) as SelftestReport;
      // Trends für die Mini-Diagramme an den Trend-Befunden (fehlt der Endpunkt oder die Auswertung, bleibt es ohne Diagramm)
      try {
        const tr = await apiFetch("/api/v1/admin/trends");
        this.#trends = tr.ok ? ((await tr.json()) as TrendReport) : null;
      } catch {
        this.#trends = null;
      }
      if (seq === this.#seq) this.#render(report);
    } catch (e) {
      if (seq !== this.#seq) return;
      this.#lamp.style.background = "var(--omp-text-dim)";
      this.#summary.textContent = t("sup.loadFailed");
      this.#stamp.textContent = String((e as Error).message ?? e);
    }
  }

  #render(r: SelftestReport) {
    this.#last = r;
    this.#lamp.style.background = levelColor(r.level);
    this.#summary.textContent = r.summary;
    this.#stamp.textContent = t("sup.checkedAt", { time: new Date(r.generatedAt).toLocaleTimeString() });
    const { problems, fine } = splitChecks(r);
    this.#list.replaceChildren();
    for (const c of problems) {
      const card = el("div", CARD + `border-left:4px solid ${levelColor(c.level)};`);
      const code = lookup(this.#codes, c.code);
      const titleRow = el("div", "display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;");
      if (code) titleRow.append(codeBadge(code));
      titleRow.append(el("span", "font-weight:600;", c.title));
      card.append(titleRow);
      if (c.detail) card.append(el("div", DIM + "margin-top:2px;", c.detail));
      if (c.fix) {
        const fix = el("div", "margin-top:6px;font-size:var(--omp-font-size-sm);");
        const lead = el("strong", "", t("sup.whatToDo") + " ");
        fix.append(lead, document.createTextNode(c.fix));
        card.append(fix);
      }
      const finding = findFinding(this.#trends, c.id);
      if (finding) card.append(this.#chart(finding));
      if (code) card.append(helpDetails(code));
      this.#list.append(card);
    }
    this.#renderTrendInfo();
    if (fine.length > 0) {
      const d = el("details", CARD);
      d.append(el("summary", "cursor:pointer;", t("sup.fine", { n: fine.length })));
      for (const c of fine) {
        const row = el("div", "display:flex;gap:8px;align-items:baseline;margin-top:6px;");
        row.append(el("span", `color:${levelColor("ok")};`, "✔"), el("span", "", c.title));
        if (c.detail) row.append(el("span", DIM, "— " + c.detail));
        d.append(row);
      }
      this.#list.append(d);
    }
  }

  #bundleCard(): HTMLElement {
    const card = el("div", CARD);
    card.append(el("div", "font-weight:600;", t("sup.bundle.title")), el("div", DIM + "margin:4px 0 8px;", t("sup.bundle.text")));
    const row = el("div", "display:flex;gap:8px;align-items:center;flex-wrap:wrap;");
    const sel = el("select");
    for (const m of BUNDLE_WINDOWS) {
      const o = el("option", "", t(`sup.window.${m}` as never));
      o.value = String(m);
      if (m === this.#minutes) o.selected = true;
      sel.append(o);
    }
    sel.addEventListener("change", () => (this.#minutes = Number(sel.value)));
    const btn = el("button", "", t("sup.bundle.create"));
    btn.className = "omp-btn omp-btn-primary";
    btn.addEventListener("click", async () => {
      if (this.#busy) return;
      this.#busy = true;
      btn.disabled = true;
      this.#bundleState.textContent = t("sup.bundle.working");
      try {
        const res = await apiFetch(bundleUrl(this.#minutes));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const name = bundleFileName(res.headers.get("Content-Disposition"), new Date());
        const url = URL.createObjectURL(blob);
        const a = el("a");
        a.href = url;
        a.download = name;
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        this.#bundleState.textContent = t("sup.bundle.done", { name, size: (blob.size / 1024).toFixed(0) });
      } catch (e) {
        this.#bundleState.textContent = t("sup.bundle.failed", { error: String((e as Error).message ?? e) });
      } finally {
        this.#busy = false;
        btn.disabled = false;
      }
    });
    row.append(el("label", DIM, t("sup.bundle.window")), sel, btn);
    card.append(row, this.#bundleState);
    return card;
  }

  // ---- Befristeter Support-Zugang (Kap. 72.9) -------------------------------------------------------------------------

  #accessCard(): HTMLElement {
    const card = el("div", CARD);
    card.append(el("div", "font-weight:600;", t("sup.access.title")), el("div", DIM + "margin:4px 0 8px;", t("sup.access.text")));
    const row = el("div", "display:flex;gap:8px;align-items:center;flex-wrap:wrap;");
    const dur = el("select");
    for (const m of ACCESS_DURATIONS) {
      const o = el("option", "", t(`sup.access.d.${m}` as never));
      o.value = String(m);
      o.selected = m === 240;
      dur.append(o);
    }
    const note = el("input", "min-width:220px;");
    note.type = "text";
    note.maxLength = 200;
    note.placeholder = t("sup.access.note");
    const btn = el("button", "", t("sup.access.create"));
    btn.className = "omp-btn omp-btn-primary";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const res = await apiFetch("/api/v1/admin/support-access", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ minutes: Number(dur.value), note: note.value }),
        });
        if (!res.ok) throw new Error((await res.text()).trim() || `HTTP ${res.status}`);
        const made = (await res.json()) as { token: string; expiresAt: string };
        this.#showNewLink(accessLink(location.origin, made.token), made.expiresAt);
        note.value = "";
        void this.#loadGrants();
      } catch (e) {
        this.#newLink.replaceChildren(el("div", "color:var(--omp-error);margin-top:8px;", t("sup.access.failed", { error: String((e as Error).message ?? e) })));
      } finally {
        btn.disabled = false;
      }
    });
    row.append(el("label", DIM, t("sup.access.duration")), dur, note, btn);
    card.append(row, this.#newLink, el("div", "font-weight:600;margin-top:12px;", t("sup.access.list")), this.#grants);
    return card;
  }

  // Der Link steht nur hier und nur jetzt: das Token wird nirgends gespeichert.
  #showNewLink(link: string, expiresAt: string) {
    const box = el("div", "margin-top:10px;padding:10px;border:1px solid var(--omp-accent,#19d3f3);border-radius:8px;");
    box.setAttribute("data-role", "support-access-link");
    box.append(el("div", "font-weight:600;", t("sup.access.created")));
    const input = el("input", "width:100%;box-sizing:border-box;margin:6px 0;font-family:monospace;");
    input.type = "text";
    input.readOnly = true;
    input.value = link;
    input.addEventListener("focus", () => input.select());
    const copy = el("button", "", t("sup.access.copy"));
    copy.className = "omp-btn";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(link);
      } catch {
        input.select();
        document.execCommand("copy");
      }
      copy.textContent = t("sup.access.copied");
    });
    box.append(input, copy, el("span", DIM + "margin-left:10px;", t("sup.access.expires", { time: new Date(expiresAt).toLocaleString() })));
    this.#newLink.replaceChildren(box);
  }

  async #loadGrants() {
    try {
      const res = await apiFetch("/api/v1/admin/support-access");
      if (!res.ok) return;
      this.#renderGrants(sortGrants((await res.json()) as SupportGrant[]));
    } catch { /* Anzeige bleibt leer */ }
  }

  #renderGrants(list: SupportGrant[]) {
    this.#grants.replaceChildren();
    if (list.length === 0) {
      this.#grants.append(el("div", DIM, t("sup.access.none")));
      return;
    }
    for (const g of list) {
      const row = el("div", "display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;padding:4px 0;border-top:1px solid var(--omp-border);");
      row.setAttribute("data-testid", "support-grant");
      const color = g.status === "active" ? "var(--omp-ok,#3fb950)" : "var(--omp-text-dim)";
      row.append(el("span", `font-weight:600;color:${color};min-width:80px;`, t(`sup.access.status.${g.status}` as never)));
      row.append(el("span", "", t("sup.access.expires", { time: new Date(g.expiresAt).toLocaleString() })));
      row.append(el("span", DIM, t("sup.access.by", { user: g.createdBy }) + (g.note ? ` — ${g.note}` : "")));
      row.append(el("span", DIM, g.useCount > 0 ? t("sup.access.used", { n: g.useCount, time: g.lastUsedAt ? new Date(g.lastUsedAt).toLocaleString() : "?" }) : t("sup.access.unused")));
      if (g.status === "active") {
        const revoke = el("button", "margin-left:auto;", t("sup.access.revoke"));
        revoke.className = "omp-btn";
        revoke.addEventListener("click", async () => {
          if (!(await confirmDialog(t("sup.access.revokeConfirm"), { confirmLabel: t("sup.access.revokeLabel") }))) return;
          await apiFetch(`/api/v1/admin/support-access/${encodeURIComponent(g.id)}`, { method: "DELETE" });
          void this.#loadGrants();
        });
        row.append(revoke);
      }
      this.#grants.append(row);
    }
  }

  // ---- Eingefrorene Momentaufnahmen (Kap. 72.10) -----------------------------------------------------------------------

  #freezeCard(): HTMLElement {
    const card = el("div", CARD);
    card.append(el("div", "font-weight:600;", t("fr.card.title")), el("div", DIM + "margin:4px 0 8px;", t("fr.card.text")));
    const row = el("div", "display:flex;gap:8px;align-items:center;flex-wrap:wrap;");
    const note = el("input", "min-width:220px;");
    note.type = "text";
    note.maxLength = 200;
    note.placeholder = t("fr.note");
    const btn = el("button", "", t("fr.now"));
    btn.className = "omp-btn omp-btn-primary";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      if (await freezeNow(10, note.value)) note.value = "";
      btn.disabled = false;
      void this.#loadFreezes();
    });
    row.append(note, btn);
    card.append(row, this.#freezes);
    return card;
  }

  // ---- Auswertung (Kap. 73) -----------------------------------------------------------------------------------------------

  #analysisOut = el("div");

  async #analyse(path: string, init?: RequestInit) {
    const lang = getLang();
    this.#analysisOut.replaceChildren(el("div", DIM, "…"));
    try {
      const res = await apiFetch(`${path}${path.includes("?") ? "&" : "?"}lang=${lang}`, init);
      if (!res.ok) throw new Error((await res.text()).trim() || `HTTP ${res.status}`);
      const rep = (await res.json()) as AnReport;
      const bar = el("div", "display:flex;gap:8px;margin-top:8px;");
      const copy = el("button", "", t("an.copy"));
      copy.className = "omp-btn";
      copy.addEventListener("click", async () => {
        const md = await apiFetch(`${path}${path.includes("?") ? "&" : "?"}lang=${lang}&format=md`, init);
        if (md.ok) {
          await navigator.clipboard.writeText(await md.text());
          showToast(t("an.copied"), { variant: "info" });
        }
      });
      bar.append(copy);
      this.#analysisOut.replaceChildren(bar, renderAnalysis(rep));
    } catch (e) {
      this.#analysisOut.replaceChildren(el("div", "color:#e5534b;", t("an.failed", { error: String((e as Error).message ?? e) })));
    }
  }

  #analysisCard(): HTMLElement {
    const card = el("div", CARD);
    card.append(el("div", "font-weight:600;", t("an.title")), el("div", DIM + "margin:4px 0 8px;", t("an.text")));
    const input = el("input");
    input.type = "file";
    input.accept = ".zip,application/zip";
    input.setAttribute("data-testid", "analysis-file");
    input.addEventListener("change", () => {
      const f = input.files?.[0];
      if (f) void this.#analyse("/api/v1/admin/support/analyze", { method: "POST", body: f });
    });
    card.append(input, this.#analysisOut);
    return card;
  }

  async #loadFreezes() {
    try {
      const res = await apiFetch("/api/v1/freezes");
      if (!res.ok) return;
      this.#renderFreezes((await res.json()) as FreezeMeta[]);
    } catch { /* Anzeige bleibt leer */ }
  }

  #renderFreezes(list: FreezeMeta[]) {
    this.#freezes.replaceChildren();
    this.#freezes.style.cssText = "margin-top:10px;";
    if (list.length === 0) {
      this.#freezes.append(el("div", DIM, t("fr.none")));
      return;
    }
    for (const m of list) {
      const row = el("div", "display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;padding:4px 0;border-top:1px solid var(--omp-border);");
      row.setAttribute("data-testid", "freeze-row");
      row.append(el("span", "min-width:150px;", new Date(m.createdAt).toLocaleString()));
      row.append(el("span", `font-weight:600;color:${m.trigger === "auto" ? "#e0a020" : "var(--omp-text)"};min-width:86px;`, t(`fr.trigger.${m.trigger}` as never)));
      const what = [m.trigger === "auto" ? m.reason : m.createdBy, m.note].filter(Boolean).join(" — ");
      row.append(el("span", "flex:1;" + DIM, `${t("fr.window", { min: m.windowMinutes })}${what ? " · " + what : ""} · ${formatSize(m.sizeBytes)}`));
      const dl = el("a", "", t("fr.download"));
      dl.className = "omp-btn";
      // Ein Link mit Knopf-Aussehen: ohne eigene Farben wäre er dunkelblau auf dunklem Grund.
      dl.style.cssText = "text-decoration:none;color:var(--omp-text);padding:4px 10px;border:1px solid var(--omp-border);border-radius:var(--omp-radius);background:var(--omp-surface-raised);cursor:pointer;";
      dl.href = freezeUrl(m.id);
      dl.setAttribute("download", "");
      row.append(dl);
      const an = el("button", "", t("an.run"));
      an.className = "omp-btn";
      an.addEventListener("click", () => void this.#analyse(`/api/v1/freezes/${encodeURIComponent(m.id)}/analysis`));
      row.append(an);
      const del = el("button", "", t("fr.delete"));
      del.className = "omp-btn";
      del.addEventListener("click", async () => {
        if (!(await confirmDialog(t("fr.deleteConfirm"), { confirmLabel: t("fr.deleteLabel") }))) return;
        await apiFetch(`/api/v1/freezes/${encodeURIComponent(m.id)}`, { method: "DELETE" });
        void this.#loadFreezes();
      });
      row.append(del);
      this.#freezes.append(row);
    }
  }

  // ---- Baseline und Trends (Kap. 72.11) ---------------------------------------------------------------------------------

  /** Mini-Diagramm einer Auffälligkeit: der Verlauf als Linie, gestrichelt das Übliche bzw. der Anfangswert, der letzte Wert als Punkt. */
  #chart(f: TrendFinding): HTMLElement {
    const box = el("div", "margin-top:8px;");
    const W = 360, H = 56;
    const sp = sparkline(f.points, f.baseline, W, H);
    if (!sp) return box;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", String(W));
    svg.setAttribute("height", String(H));
    svg.setAttribute("role", "img");
    svg.setAttribute("data-testid", "trend-chart");
    svg.style.cssText = "display:block;max-width:100%;background:rgba(255,255,255,.03);border-radius:4px;";
    if (sp.baselineY !== null) {
      const base = document.createElementNS(ns, "line");
      for (const [k, v] of Object.entries({ x1: "3", x2: String(W - 3), y1: String(sp.baselineY), y2: String(sp.baselineY), stroke: "#9aa0a6", "stroke-dasharray": "4 3", "stroke-width": "1" })) base.setAttribute(k, v);
      svg.append(base);
    }
    const line = document.createElementNS(ns, "path");
    for (const [k, v] of Object.entries({ d: sp.line, fill: "none", stroke: "#e0a020", "stroke-width": "2" })) line.setAttribute(k, v);
    const dot = document.createElementNS(ns, "circle");
    for (const [k, v] of Object.entries({ cx: String(sp.lastX), cy: String(sp.lastY), r: "3.5", fill: "#e05252" })) dot.setAttribute(k, v);
    svg.append(line, dot);
    box.append(svg, el("div", DIM + "margin-top:2px;", t(f.kind === "drift" ? "tr.chart.drift" : "tr.chart.deviation")));
    return box;
  }

  #renderTrendInfo() {
    const card = this.#trendInfo;
    card.replaceChildren(el("div", "font-weight:600;", t("tr.title")));
    const r = this.#trends;
    const state = coverageKey(r);
    const days = r ? (r.coverageHours / 24).toFixed(1) : "0";
    let text: string;
    if (state === "none") text = t("tr.none");
    else if (state === "building") text = t("tr.building", { days, n: r!.seriesChecked });
    else text = t("tr.ready", { days, n: r!.seriesChecked }) + (r!.findings.length === 0 ? " " + t("tr.clean") : "");
    card.append(el("div", DIM + "margin-top:4px;", text));
  }
}
