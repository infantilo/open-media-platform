// Auslöser-Dialog des Prozess-Editors: durchsuchbare Ereignisliste (gruppiert, mit „zuletzt gesehen“), Introspektion der Nutzlast
// (Felder als anklickbare Chips, letzte Nutzlast), Filter mit Autovervollständigung und Live-Test gegen die letzte Nutzlast.
// Der Katalog wird solange der Dialog offen ist regelmäßig neu geladen (neue Alarmarten/Ereignisse erscheinen von selbst).
import { getLang, t as tt } from "../shell/i18n.ts";
import { apiFetch } from "../shell/connection.ts";
import type { TriggerKind } from "./process-step-config-logic.ts";
import { applySuggestion, previewValue, relTime, searchKinds, suggest, type SuggestResult, valueAt } from "./trigger-dialog-logic.ts";

export interface TriggerDef {
  subject?: string;
  filter?: string;
}

export interface TriggerDialogOptions {
  triggers: TriggerDef[];
  getKinds: () => TriggerKind[];
  /** Lädt den Katalog neu (aktualisiert die Daten hinter getKinds). */
  refresh: () => Promise<void>;
  groupLabel: (g: string) => string;
  onApply: (t: TriggerDef[]) => void;
  onError: (msg: string) => void;
  host: HTMLElement;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
};
/** Popup außerhalb des Dialogflusses (fixed unter dem Anker): verlängert den Dialog nie und erzeugt keinen Scrollbalken. */
function placePopup(pop: HTMLElement, anchor: HTMLElement, listEl: HTMLElement | null, maxList = 300) {
  const r = anchor.getBoundingClientRect();
  pop.style.position = "fixed";
  pop.style.left = `${r.left}px`;
  pop.style.width = `${r.width}px`;
  pop.style.right = "auto";
  const below = window.innerHeight - r.bottom - 16;
  const above = r.top - 16;
  const flip = below < 160 && above > below;
  const room = Math.max(120, flip ? above : below);
  if (flip) {
    pop.style.top = "auto";
    pop.style.bottom = `${window.innerHeight - r.top + 2}px`;
  } else {
    pop.style.bottom = "auto";
    pop.style.top = `${r.bottom + 2}px`;
  }
  pop.style.margin = "0";
  if (listEl) listEl.style.maxHeight = `${Math.min(maxList, room - 50)}px`;
  else pop.style.maxHeight = `${Math.min(220, room)}px`;
}
const DIM = "color:var(--omp-text-dim);font-size:var(--omp-font-size-xs);";

export function openTriggerDialog(o: TriggerDialogOptions) {
  const triggers = o.triggers.map((t) => ({ ...t }));
  const overlay = el("div");
  overlay.className = "omp-modal-overlay";
  overlay.style.zIndex = "2100";
  const modal = el("div", "max-width:720px;width:92vw;max-height:88vh;overflow-y:auto;");
  modal.className = "omp-modal";
  modal.setAttribute("data-role", "triggers-modal");
  modal.append(el("div", "", tt("pe.c8a8be")));
  modal.firstElementChild!.className = "omp-h1";
  modal.append(el("div", DIM + "margin:4px 0 8px;", tt("pe.d4054d")));
  const list = el("div");
  modal.append(list);
  const updaters: (() => void)[] = [];

  const kindFor = (subject: string | undefined): TriggerKind | undefined => o.getKinds().find((k) => k.subject === subject);

  const renderCards = () => {
    updaters.length = 0;
    list.replaceChildren();
    if (!triggers.length) list.append(el("div", DIM + "padding:8px 0;", tt("pe.ff11ee")));
    triggers.forEach((t, idx) => list.append(card(t, idx)));
  };

  function card(t: TriggerDef, idx: number): HTMLElement {
    const box = el("div", "border:1px solid var(--omp-border);border-radius:6px;padding:8px;margin-top:8px;");
    box.dataset.role = "trigger-card";
    const head = el("div", "display:flex;gap:6px;align-items:flex-start;");
    const picker = eventPicker(t, () => {
      details();
      runTest();
    });
    const rm = el("button", "", "✕");
    rm.title = tt("pe.trigRemove");
    rm.addEventListener("click", () => {
      triggers.splice(idx, 1);
      renderCards();
    });
    head.append(picker.root, rm);
    const info = el("div", "margin-top:6px;");
    const filterWrap = el("div", "position:relative;margin-top:6px;");
    const filt = el("input", "width:100%;box-sizing:border-box;font-family:ui-monospace,monospace;font-size:var(--omp-font-size-xs);");
    filt.name = "trigger-filter";
    filt.placeholder = tt("pe.trigFilter");
    filt.value = t.filter ?? "";
    filt.autocomplete = "off";
    filt.spellcheck = false;
    const pop = el("div", "display:none;position:absolute;left:0;right:0;top:100%;z-index:5;background:var(--omp-surface-raised,#1b2233);border:1px solid var(--omp-border);border-radius:4px;max-height:220px;overflow-y:auto;box-shadow:0 6px 20px rgba(0,0,0,.5);");
    pop.dataset.role = "filter-suggest";
    const verdict = el("div", DIM + "margin-top:3px;min-height:16px;");
    verdict.dataset.role = "filter-verdict";
    filterWrap.append(filt, pop);

    let sug: SuggestResult = { from: 0, to: 0, items: [] };
    let active = 0;
    const fieldPaths = () => (kindFor(t.subject)?.inputFields ?? []).map((f) => f.path);
    const closePop = () => (pop.style.display = "none");
    const showSuggest = () => {
      sug = suggest(filt.value, filt.selectionStart ?? filt.value.length, fieldPaths(), kindFor(t.subject)?.sample);
      active = 0;
      pop.replaceChildren();
      if (!sug.items.length) return closePop();
      sug.items.forEach((it, i) => {
        const row = el("div", "display:flex;gap:8px;justify-content:space-between;padding:3px 8px;cursor:pointer;font-family:ui-monospace,monospace;font-size:var(--omp-font-size-xs);");
        row.dataset.i = String(i);
        row.append(el("span", it.kind === "field" ? "" : "color:var(--omp-cue);", it.label));
        if (it.hint) row.append(el("span", "color:var(--omp-text-dim);", it.hint));
        row.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          accept(i);
        });
        pop.append(row);
      });
      pop.style.display = "block";
      placePopup(pop, filt, null);
      paintActive();
    };
    const paintActive = () => {
      [...pop.children].forEach((c, i) => ((c as HTMLElement).style.background = i === active ? "var(--omp-accent,#2f8cff)" : ""));
      (pop.children[active] as HTMLElement | undefined)?.scrollIntoView?.({ block: "nearest" });
    };
    const accept = (i: number) => {
      const it = sug.items[i];
      if (!it) return;
      const r = applySuggestion(filt.value, sug, it);
      filt.value = r.text;
      filt.setSelectionRange(r.caret, r.caret);
      t.filter = filt.value.trim() || undefined;
      filt.focus();
      showSuggest();
      runTest();
    };
    filt.addEventListener("input", () => {
      t.filter = filt.value.trim() || undefined;
      showSuggest();
      runTestSoon();
    });
    filt.addEventListener("focus", showSuggest);
    filt.addEventListener("blur", () => setTimeout(closePop, 120));
    filt.addEventListener("keydown", (e) => {
      const open = pop.style.display !== "none";
      if (e.key === "ArrowDown" && open) active = Math.min(sug.items.length - 1, active + 1);
      else if (e.key === "ArrowUp" && open) active = Math.max(0, active - 1);
      else if ((e.key === "Tab" || e.key === "Enter") && open) {
        e.preventDefault();
        accept(active);
        return;
      } else if (e.key === "Escape" && open) {
        e.stopPropagation();
        closePop();
        return;
      } else if (e.key === " " && e.ctrlKey) {
        e.preventDefault();
        showSuggest();
        return;
      } else return;
      e.preventDefault();
      paintActive();
    });

    // Introspektion: Status, Felder (Chips), letzte Nutzlast
    function details() {
      info.replaceChildren();
      const k = kindFor(t.subject);
      if (!t.subject) return;
      const status = el("div", DIM);
      status.dataset.role = "event-status";
      status.textContent = k?.lastSeen
        ? tt("pe.trigSeen", { p0: relTime(k.lastSeen, Date.now(), getLang()), p1: k.count ?? 1 })
        : tt("pe.trigNever");
      info.append(el("div", DIM + "font-family:ui-monospace,monospace;", t.subject), status);
      const fields = k?.inputFields ?? [];
      if (fields.length) {
        info.append(el("div", DIM + "margin-top:6px;", tt("pe.trigFields")));
        const chips = el("div", "display:flex;flex-wrap:wrap;gap:4px;margin-top:2px;");
        for (const f of fields) {
          const v = previewValue(valueAt(k?.sample, f.path));
          const c = el("button", "font-family:ui-monospace,monospace;font-size:var(--omp-font-size-xs);padding:1px 6px;");
          c.dataset.field = f.path;
          c.textContent = f.path;
          c.title = (f.label && f.label !== f.path ? f.label + " · " : "") + (v ? tt("pe.trigExample", { p0: v }) : tt("pe.trigInsert"));
          c.addEventListener("click", () => {
            const pos = filt.selectionStart ?? filt.value.length;
            const ins = `input.${f.path}`;
            filt.value = filt.value.slice(0, pos) + ins + filt.value.slice(filt.selectionEnd ?? pos);
            filt.focus();
            filt.setSelectionRange(pos + ins.length, pos + ins.length);
            t.filter = filt.value.trim() || undefined;
            showSuggest();
            runTest();
          });
          chips.append(c);
        }
        info.append(chips);
      }
      if (k?.sample !== undefined) {
        const d = el("details", "margin-top:6px;");
        d.append(el("summary", DIM + "cursor:pointer;", tt("pe.trigSample")));
        d.append(el("pre", "margin:4px 0 0;max-height:140px;overflow:auto;font-size:var(--omp-font-size-xs);background:var(--omp-surface,#0b1020);padding:6px;border-radius:4px;", JSON.stringify(k.sample, null, 2)));
        info.append(d);
      }
    }

    // Live-Test: Filter gegen die letzte Nutzlast (Auswertung im Orchestrator, gleiche Sprache wie beim Auslösen)
    let testTimer = 0;
    let testSeq = 0;
    const runTestSoon = () => {
      clearTimeout(testTimer);
      testTimer = setTimeout(runTest, 400) as unknown as number;
    };
    async function runTest() {
      const k = kindFor(t.subject);
      const f = (t.filter ?? "").trim();
      verdict.style.color = "";
      if (!f) {
        verdict.textContent = "";
        return;
      }
      if (k?.sample === undefined) {
        verdict.textContent = tt("pe.trigNoSample");
        return;
      }
      const seq = ++testSeq;
      try {
        const res = await apiFetch("/api/v1/event-catalog/test-filter", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filter: f, subject: t.subject, payload: k.sample }),
        });
        const d = (await res.json()) as { ok?: boolean; result?: boolean; error?: string };
        if (seq !== testSeq) return;
        if (!d.ok) {
          verdict.style.color = "var(--omp-error,#ef5350)";
          verdict.textContent = "✖ " + (d.error ?? "").replace(/^process: /, "");
        } else {
          verdict.style.color = d.result ? "var(--omp-preset,#4caf50)" : "var(--omp-cue,#fb8c00)";
          verdict.textContent = d.result ? tt("pe.trigMatch") : tt("pe.trigNoMatch");
        }
      } catch {
        verdict.textContent = "";
      }
    }

    details();
    runTest();
    updaters.push(() => {
      details();
      picker.refresh();
      void runTest();
    });
    box.append(head, info, filterWrap, verdict);
    return box;
  }

  // Ereignis-Auswahl: Knopf mit Name + Subject, Popup mit Suche, gruppierter Liste, eigenem Subject
  function eventPicker(t: TriggerDef, onChange: () => void): { root: HTMLElement; refresh: () => void } {
    const root = el("div", "position:relative;flex:1;min-width:0;");
    const btn = el("button", "width:100%;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;");
    btn.dataset.role = "event-picker";
    const pop = el("div", "display:none;position:absolute;left:0;right:0;top:100%;margin-top:2px;z-index:6;background:var(--omp-surface-raised,#1b2233);border:1px solid var(--omp-border);border-radius:6px;padding:6px;box-shadow:0 8px 28px rgba(0,0,0,.55);");
    const q = el("input", "width:100%;box-sizing:border-box;margin-bottom:4px;");
    q.type = "search";
    q.name = "trigger-search";
    q.placeholder = tt("pe.trigSearch");
    q.autocomplete = "off";
    const listEl = el("div", "max-height:300px;overflow-y:auto;");
    pop.append(q, listEl);
    root.append(btn, pop);
    let shown: { subject: string }[] = [];
    let active = 0;
    const paintBtn = () => {
      const k = kindFor(t.subject);
      btn.replaceChildren();
      if (!t.subject) {
        btn.textContent = tt("pe.trigChoose") + " ▾";
        return;
      }
      btn.append(document.createTextNode((k ? k.label : t.subject) + " ▾"));
      btn.title = t.subject;
    };
    const choose = (subject: string) => {
      t.subject = subject;
      pop.style.display = "none";
      paintBtn();
      onChange();
    };
    const renderList = () => {
      const kinds = searchKinds(o.getKinds(), q.value, o.groupLabel);
      const typed = q.value.trim();
      const custom = typed.startsWith("omp.") && !kinds.some((k) => k.subject === typed) ? typed : "";
      shown = [...(custom ? [{ subject: custom }] : []), ...kinds];
      active = Math.min(active, Math.max(0, shown.length - 1));
      listEl.replaceChildren();
      if (!shown.length) listEl.append(el("div", DIM + "padding:6px;", tt("aps.wfNone")));
      let lastGroup: string | undefined;
      shown.forEach((s, i) => {
        const k = kinds.find((x) => x.subject === s.subject);
        const g = custom && i === 0 ? "__custom" : k?.group ?? "";
        if (g !== lastGroup) {
          lastGroup = g;
          listEl.append(el("div", DIM + "padding:6px 6px 2px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;", g === "__custom" ? tt("pe.083fea") : o.groupLabel(g)));
        }
        const row = el("div", "display:flex;justify-content:space-between;gap:10px;align-items:baseline;padding:3px 8px;cursor:pointer;border-radius:3px;" + (i === active ? "background:var(--omp-accent,#2f8cff);color:#fff;" : s.subject === t.subject ? "font-weight:600;" : ""));
        row.dataset.subject = s.subject;
        const left = el("span", "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;");
        left.append(document.createTextNode(k ? k.label : tt("pe.trigUse", { p0: s.subject })));
        if (k && !k.observed) left.append(el("span", "opacity:.6;font-family:ui-monospace,monospace;font-size:var(--omp-font-size-xs);margin-left:8px;", k.subject));
        const right = el("span", "flex:none;font-size:var(--omp-font-size-xs);opacity:.75;");
        right.textContent = k?.lastSeen ? relTime(k.lastSeen, Date.now(), getLang()) : "";
        row.append(left, right);
        row.addEventListener("pointerenter", () => {
          active = i;
          [...listEl.querySelectorAll("[data-subject]")].forEach((r, n) => ((r as HTMLElement).style.background = n === i ? "var(--omp-accent,#2f8cff)" : ""));
        });
        row.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          choose(s.subject);
        });
        listEl.append(row);
      });
    };
    btn.addEventListener("click", () => {
      if (pop.style.display === "none") {
        pop.style.display = "block";
        placePopup(pop, btn, listEl);
        q.value = "";
        active = 0;
        renderList();
        q.focus();
      } else pop.style.display = "none";
    });
    q.addEventListener("input", () => {
      active = 0;
      renderList();
    });
    q.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") active = Math.min(shown.length - 1, active + 1);
      else if (e.key === "ArrowUp") active = Math.max(0, active - 1);
      else if (e.key === "Enter") {
        if (shown[active]) choose(shown[active].subject);
        return;
      } else if (e.key === "Escape") {
        e.stopPropagation();
        pop.style.display = "none";
        return;
      } else return;
      e.preventDefault();
      renderList();
    });
    q.addEventListener("blur", () => setTimeout(() => (pop.style.display = "none"), 150));
    paintBtn();
    return {
      root,
      refresh: () => {
        paintBtn();
        if (pop.style.display !== "none") renderList();
      },
    };
  }

  renderCards();
  const add = el("button", "margin-top:8px;", tt("pe.c481e8"));
  add.setAttribute("data-role", "trigger-add");
  add.addEventListener("click", () => {
    triggers.push({ subject: "" });
    renderCards();
    (list.lastElementChild?.querySelector("[data-role=event-picker]") as HTMLElement | null)?.click();
  });
  modal.append(add);

  const actions = el("div", "display:flex;justify-content:flex-end;gap:8px;margin-top:12px;");
  const cancel = el("button", "", tt("pe.4b9727"));
  const stop = () => {
    clearInterval(poll);
    overlay.remove();
  };
  cancel.addEventListener("click", stop);
  const ok = el("button", "", tt("pe.bf8310"));
  ok.className = "omp-btn-primary";
  ok.setAttribute("data-role", "triggers-apply");
  ok.addEventListener("click", () => {
    if (triggers.some((t) => !t.subject)) return o.onError(tt("pe.9b9089"));
    o.onApply(triggers.map((t) => ({ subject: t.subject, ...(t.filter ? { filter: t.filter } : {}) })));
    stop();
  });
  actions.append(cancel, ok);
  modal.append(actions);
  overlay.append(modal);
  overlay.addEventListener("mousedown", (ev) => {
    if (ev.target === overlay) stop();
  });
  o.host.append(overlay);

  // dynamisch: Katalog regelmäßig neu laden, Eingaben/Popups bleiben unberührt
  const poll = setInterval(async () => {
    if (!overlay.isConnected) return clearInterval(poll);
    try {
      await o.refresh();
      updaters.forEach((u) => u());
    } catch { /* nächster Versuch */ }
  }, 4000) as unknown as number;
  void o.refresh().then(() => updaters.forEach((u) => u())).catch(() => {});
}
