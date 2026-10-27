// Support (Admin → Support): "Ist mein System gesund?" als Ampel und das Support-Paket als ein Knopf.
//   • Ampel      — Befunde in Klartext mit nächstem Schritt, aktualisiert sich alle 30 s, solange der Tab offen ist
//   • Paket      — eine ZIP-Datei mit dem Zustand des Systems (ohne Medien, Passwörter und Tokens) für den Support
import { t } from "./i18n.ts";
import { apiFetch } from "./connection.ts";
import { codeBadge, type ErrorCode, helpDetails, loadErrorCodes, lookup } from "./errorcodes.ts";
import {
  BUNDLE_WINDOWS,
  bundleFileName,
  bundleUrl,
  levelColor,
  type SelftestReport,
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

    this.el.append(title, hint, head, this.#list, this.#bundleCard());
    void loadErrorCodes().then((c) => {
      this.#codes = c;
      if (this.#last) this.#render(this.#last);
    });
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
      if (code) card.append(helpDetails(code));
      this.#list.append(card);
    }
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
}
