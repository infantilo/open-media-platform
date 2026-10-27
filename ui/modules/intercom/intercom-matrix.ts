// Zuteilung Teilnehmer × Kanäle für große Einrichtungen (Kapitel 63): Filter, Auswahl, Sammelaktionen und eine Matrix, die nur die
// sichtbaren Zeilen zeichnet — mit tausend Teilnehmern bleibt sie flüssig. Arbeitet auf dem Entwurf des Admin-Elements.

import { confirmDialog, showToast, t as tt } from "../host.ts";
import { type Channel, type Config, getRoute, type Party, type PartyKind, setRoute } from "./intercom-logic.ts";
import { copyRoutes, filterChannels, filterParties, matrixStats, removeParties, setAllChannels, setForParties, visibleWindow } from "./intercom-scale.ts";

const ROW_H = 34;
const COL_W = 96;
const NAME_W = 210;
const TOOLS_W = 92;
const CHECK_W = 32;
/** Ab so vielen Änderungen auf einmal fragt eine Sammelaktion nach. */
const CONFIRM_ABOVE = 20;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

const DIM = "color:var(--omp-text-dim);";

/** Zustand, der Neuzeichnen (Reiterwechsel) überlebt. */
export interface MatrixState {
  text: string;
  kind: PartyKind | "all";
  assigned: "all" | "yes" | "no";
  channelText: string;
  selected: Set<number>;
  scrollTop: number;
  scrollLeft: number;
}

export function newMatrixState(): MatrixState {
  return { text: "", kind: "all", assigned: "all", channelText: "", selected: new Set(), scrollTop: 0, scrollLeft: 0 };
}

export interface MatrixHost {
  draft(): Config;
  state: MatrixState;
  /** Änderung am Entwurf (Speichern-Knöpfe nachziehen). */
  changed(): void;
  /** Struktur geändert (Teilnehmer gelöscht): Reiter ganz neu aufbauen. */
  rebuild(): void;
  openParty(id: number): void;
  /** Statuspunkte (online/spricht) für die gerade gezeichneten Zeilen setzen. */
  paintDots(): void;
}

export function matrixView(host: MatrixHost): HTMLElement {
  const st = host.state;
  const root = el("div");
  root.dataset.role = "matrix";

  let parties: Party[] = [];
  let channels: Channel[] = [];
  const colTemplate = () => `${CHECK_W}px ${NAME_W}px ${TOOLS_W}px repeat(${channels.length},${COL_W}px)`;
  const totalWidth = () => CHECK_W + NAME_W + TOOLS_W + channels.length * COL_W;

  const toolbar = el("div", "display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:8px;");
  const bulk = el("div", "display:none;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;padding:6px 8px;border:1px solid var(--omp-accent-cyan,#19d3f3);border-radius:6px;");
  bulk.dataset.role = "bulk";
  const info = el("div", `font-size:12px;margin-bottom:6px;${DIM}`);
  info.dataset.role = "matrix-info";
  const scroller = el("div", "background:var(--omp-surface,#111);overflow:auto;max-height:min(68vh,720px);border:1px solid var(--omp-border);border-radius:6px;position:relative;");
  scroller.dataset.role = "matrix-scroll";
  const sizer = el("div", "position:relative;");
  const headRow = el("div", "position:sticky;top:0;z-index:4;background:var(--omp-surface,#111);border-bottom:1px solid var(--omp-border);display:grid;align-items:stretch;");
  const body = el("div", "position:relative;");
  sizer.append(headRow, body);
  scroller.append(sizer);

  const input = (value: string, placeholder: string, width: string, on: (v: string) => void): HTMLInputElement => {
    const i = el("input", `padding:3px 6px;width:${width};`);
    i.value = value;
    i.placeholder = placeholder;
    i.addEventListener("input", () => on(i.value));
    return i;
  };
  const labelled = (label: string, c: HTMLElement): HTMLElement => {
    const w = el("label", "display:flex;flex-direction:column;gap:2px;");
    w.append(el("span", "font-size:10px;letter-spacing:.06em;text-transform:uppercase;" + DIM, label), c);
    return w;
  };
  const select = (opts: [string, string][], value: string, on: (v: string) => void): HTMLSelectElement => {
    const s = el("select", "padding:3px 6px;");
    for (const [v, text] of opts) {
      const o = el("option", "", text);
      o.value = v;
      s.append(o);
    }
    s.value = value;
    s.addEventListener("change", () => on(s.value));
    return s;
  };
  const btn = (text: string, on: () => void, title = ""): HTMLButtonElement => {
    const b = el("button", "padding:3px 10px;", text);
    if (title) b.title = title;
    b.addEventListener("click", on);
    return b;
  };

  // ---- Neuberechnung und Zeichnen ----

  function recompute() {
    const d = host.draft();
    parties = filterParties(d.parties, { text: st.text, kind: st.kind, assigned: st.assigned === "all" ? undefined : st.assigned === "yes" });
    channels = filterChannels(d.channels, st.channelText);
  }

  function paintCell(b: HTMLElement, p: Party, ch: number, f: "talk" | "listen") {
    const on = !!getRoute(p, ch)?.[f];
    b.style.opacity = on ? "1" : "0.25";
    b.style.background = on ? "color-mix(in srgb,var(--omp-accent-cyan,#19d3f3) 28%,transparent)" : "";
    b.setAttribute("aria-pressed", String(on));
  }

  function rowEl(p: Party, index: number): HTMLElement {
    const row = el("div", `position:absolute;left:0;top:${index * ROW_H}px;height:${ROW_H}px;width:${totalWidth()}px;display:grid;grid-template-columns:${colTemplate()};align-items:center;border-bottom:1px solid color-mix(in srgb,var(--omp-border) 50%,transparent);`);
    row.dataset.row = String(p.id);
    const sticky = "position:sticky;left:0;z-index:2;background:var(--omp-surface,#111);height:100%;display:flex;align-items:center;";
    const check = el("span", sticky + "justify-content:center;");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = st.selected.has(p.id);
    cb.dataset.act = "select";
    cb.setAttribute("aria-label", p.name || `#${p.id}`);
    check.append(cb);
    const name = el("span", `position:sticky;left:${CHECK_W}px;z-index:2;background:var(--omp-surface,#111);height:100%;display:flex;align-items:center;gap:6px;overflow:hidden;`);
    const dot = el("span", "width:9px;height:9px;border-radius:50%;background:var(--omp-border);flex:none;");
    dot.dataset.partyDot = String(p.id);
    const nb = el("button", "border:0;background:none;padding:0;cursor:pointer;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", p.name || `#${p.id}`);
    nb.dataset.act = "open";
    nb.title = tt("icom.assign.openParty");
    name.append(dot, nb);
    const tools = el("span", `position:sticky;left:${CHECK_W + NAME_W}px;z-index:2;background:var(--omp-surface,#111);height:100%;display:flex;align-items:center;gap:2px;border-right:1px solid var(--omp-border);`);
    for (const [act, text, title] of [["row-talk", "🎤+", "icom.m.rowTalk"], ["row-listen", "🎧+", "icom.m.rowListen"], ["row-clear", "∅", "icom.m.rowClear"]] as const) {
      const b = el("button", "padding:0 4px;font-size:11px;", text);
      b.dataset.act = act;
      b.title = tt(title);
      tools.append(b);
    }
    row.append(check, name, tools);
    for (const c of channels) {
      const cell = el("span", "display:flex;gap:3px;justify-content:center;");
      for (const f of ["talk", "listen"] as const) {
        const b = el("button", "padding:2px 6px;min-width:34px;", f === "talk" ? "🎤" : "🎧");
        b.dataset.act = "cell";
        b.dataset.ch = String(c.id);
        b.dataset.f = f;
        b.title = `${p.name || `#${p.id}`} · ${c.name || `#${c.id}`} · ${tt(f === "talk" ? "icom.talk" : "icom.listen")}`;
        paintCell(b, p, c.id, f);
        cell.append(b);
      }
      row.append(cell);
    }
    return row;
  }

  function renderHead() {
    headRow.style.gridTemplateColumns = colTemplate();
    headRow.style.width = `${totalWidth()}px`;
    headRow.replaceChildren();
    const all = el("span", "position:sticky;left:0;z-index:5;background:var(--omp-surface,#111);display:flex;align-items:center;justify-content:center;");
    const cb = el("input");
    cb.type = "checkbox";
    cb.title = tt("icom.m.selectAll");
    cb.dataset.act = "select-all";
    cb.checked = parties.length > 0 && parties.every((p) => st.selected.has(p.id));
    all.append(cb);
    const nameH = el("span", `position:sticky;left:${CHECK_W}px;z-index:5;background:var(--omp-surface,#111);padding:6px;font-size:11px;${DIM}`, tt("icom.m.party"));
    const toolsH = el("span", `position:sticky;left:${CHECK_W + NAME_W}px;z-index:5;background:var(--omp-surface,#111);border-right:1px solid var(--omp-border);`);
    headRow.append(all, nameH, toolsH);
    for (const c of channels) {
      const h = el("span", `display:flex;flex-direction:column;align-items:center;gap:2px;padding:4px 2px;border-bottom:3px solid ${c.color || "#4c8dff"};min-width:0;`);
      h.append(el("span", "font-size:12px;font-weight:600;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", c.name || `#${c.id}`));
      const tools = el("span", "display:flex;gap:2px;");
      for (const [act, text, title] of [["col-talk", "🎤+", "icom.m.colTalk"], ["col-listen", "🎧+", "icom.m.colListen"], ["col-clear", "∅", "icom.m.colClear"]] as const) {
        const b = el("button", "padding:0 4px;font-size:11px;", text);
        b.dataset.act = act;
        b.dataset.ch = String(c.id);
        b.title = tt(title, { p0: parties.length });
        tools.append(b);
      }
      h.append(tools);
      headRow.append(h);
    }
  }

  function renderRows() {
    st.scrollTop = scroller.scrollTop;
    st.scrollLeft = scroller.scrollLeft;
    body.style.height = `${parties.length * ROW_H}px`;
    body.style.width = `${totalWidth()}px`;
    const headH = headRow.offsetHeight || 50;
    const w = visibleWindow(Math.max(0, scroller.scrollTop), scroller.clientHeight || 600, ROW_H, parties.length, 6);
    void headH;
    const frag = document.createDocumentFragment();
    for (let i = w.start; i < w.end; i++) frag.append(rowEl(parties[i], i));
    body.replaceChildren(frag);
    host.paintDots();
  }

  function renderInfo() {
    const s = matrixStats(host.draft());
    info.textContent = tt("icom.m.info", { p0: parties.length, p1: s.parties, p2: channels.length, p3: s.channels, p4: s.unassigned });
  }

  function renderBulk() {
    const n = st.selected.size;
    bulk.style.display = n ? "flex" : "none";
    bulk.replaceChildren();
    if (!n) return;
    const d = host.draft();
    bulk.append(el("strong", "", tt("icom.m.selected", { p0: n })));
    const sel = (): Party[] => d.parties.filter((p) => st.selected.has(p.id));

    // Zuordnung einer Vorlage-Sprechstelle übernehmen
    const src = el("select", "padding:3px 6px;max-width:200px;");
    for (const p of d.parties) {
      const o = el("option", "", p.name || `#${p.id}`);
      o.value = String(p.id);
      src.append(o);
    }
    bulk.append(src, btn(tt("icom.m.copyFrom"), async () => {
      const from = d.parties.find((p) => p.id === Number(src.value));
      const targets = sel().filter((p) => p.id !== from?.id);
      if (!from || !targets.length) return;
      if (!(await confirmDialog(tt("icom.m.copyConfirm", { p0: targets.length, p1: from.name || `#${from.id}` })))) return;
      copyRoutes(from, targets);
      host.changed();
      refresh(false);
    }, tt("icom.m.copyFromHint")));

    // Ein Kanal für die ganze Auswahl
    const chSel = el("select", "padding:3px 6px;max-width:160px;");
    for (const c of d.channels) {
      const o = el("option", "", c.name || `#${c.id}`);
      o.value = String(c.id);
      chSel.append(o);
    }
    const apply = (f: "talk" | "listen", on: boolean) => async () => {
      const ch = Number(chSel.value);
      if (!ch) return;
      const targets = sel();
      if (targets.length > CONFIRM_ABOVE && !(await confirmDialog(tt("icom.m.bulkConfirm", { p0: targets.length })))) return;
      setForParties(targets, ch, f, on);
      host.changed();
      refresh(false);
    };
    bulk.append(chSel, btn("🎤+", apply("talk", true), tt("icom.m.selTalkOn")), btn("🎤−", apply("talk", false), tt("icom.m.selTalkOff")), btn("🎧+", apply("listen", true), tt("icom.m.selListenOn")), btn("🎧−", apply("listen", false), tt("icom.m.selListenOff")));

    bulk.append(btn(tt("icom.m.delete"), async () => {
      const ids = new Set(st.selected);
      if (!(await confirmDialog(tt("icom.m.deleteConfirm", { p0: ids.size })))) return;
      removeParties(d, ids);
      st.selected.clear();
      host.changed();
      host.rebuild();
    }), btn(tt("icom.m.clearSel"), () => {
      st.selected.clear();
      refresh(false);
    }));
  }

  /** `full`: Kopfzeile und Zeilen neu (Filter geändert); sonst nur die Zeilen und die Auswahlleiste. */
  function refresh(full: boolean) {
    if (full) {
      recompute();
      renderHead();
    }
    renderRows();
    renderInfo();
    renderBulk();
  }

  // ---- Ereignisse (eine Delegation statt tausender Handler) ----

  async function confirmMany(n: number): Promise<boolean> {
    return n <= CONFIRM_ABOVE || await confirmDialog(tt("icom.m.bulkConfirm", { p0: n }));
  }

  scroller.addEventListener("scroll", () => {
    if (scroller.scrollTop !== st.scrollTop) requestAnimationFrame(renderRows);
    st.scrollTop = scroller.scrollTop;
    st.scrollLeft = scroller.scrollLeft;
  });

  sizer.addEventListener("click", (ev) => {
    const t = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!t) return;
    const d = host.draft();
    const rowId = Number(t.closest<HTMLElement>("[data-row]")?.dataset.row);
    const p = d.parties.find((x) => x.id === rowId);
    const ch = Number(t.dataset.ch);
    switch (t.dataset.act) {
      case "cell": {
        if (!p) return;
        const f = t.dataset.f as "talk" | "listen";
        setRoute(p, ch, f, !getRoute(p, ch)?.[f]);
        paintCell(t, p, ch, f);
        host.changed();
        renderInfo();
        break;
      }
      case "open":
        if (p) host.openParty(p.id);
        break;
      case "select": {
        if (!p) return;
        if ((t as HTMLInputElement).checked) st.selected.add(p.id);
        else st.selected.delete(p.id);
        renderBulk();
        renderHead();
        break;
      }
      case "select-all": {
        if ((t as HTMLInputElement).checked) for (const x of parties) st.selected.add(x.id);
        else for (const x of parties) st.selected.delete(x.id);
        refresh(true);
        break;
      }
      case "row-talk":
      case "row-listen":
      case "row-clear": {
        if (!p) return;
        const ids = channels.map((c) => c.id);
        if (t.dataset.act === "row-clear") {
          setAllChannels(p, ids, "talk", false);
          setAllChannels(p, ids, "listen", false);
        } else setAllChannels(p, ids, t.dataset.act === "row-talk" ? "talk" : "listen", true);
        host.changed();
        refresh(false);
        break;
      }
      case "col-talk":
      case "col-listen":
      case "col-clear": {
        const on = t.dataset.act !== "col-clear";
        void (async () => {
          if (!(await confirmMany(parties.length))) return;
          let n = 0;
          if (!on) {
            n += setForParties(parties, ch, "talk", false) + setForParties(parties, ch, "listen", false);
          } else n += setForParties(parties, ch, t.dataset.act === "col-talk" ? "talk" : "listen", true);
          if (n) host.changed();
          showToast(tt("icom.m.changed", { p0: n }));
          refresh(false);
        })();
        break;
      }
    }
  });

  // ---- Werkzeugleiste ----

  const reflow = () => {
    scroller.scrollTop = 0;
    refresh(true);
  };
  toolbar.append(
    labelled(tt("icom.m.filterParty"), input(st.text, tt("icom.m.filterPartyPh"), "200px", (v) => { st.text = v; reflow(); })),
    labelled(tt("icom.party.kind"), select([["all", tt("icom.m.allKinds")], ...(["human", "seat", "program", "port"] as const).map((k) => [k, tt(`icom.party.kind.${k}` as never)] as [string, string])], st.kind, (v) => { st.kind = v as PartyKind | "all"; reflow(); })),
    labelled(tt("icom.m.assigned"), select([["all", tt("icom.m.assignedAll")], ["yes", tt("icom.m.assignedYes")], ["no", tt("icom.m.assignedNo")]], st.assigned, (v) => { st.assigned = v as MatrixState["assigned"]; reflow(); })),
    labelled(tt("icom.m.filterChannel"), input(st.channelText, tt("icom.m.filterChannelPh"), "160px", (v) => { st.channelText = v; refresh(true); })),
  );
  const reset = btn(tt("icom.m.resetFilter"), () => {
    st.text = "";
    st.kind = "all";
    st.assigned = "all";
    st.channelText = "";
    host.rebuild();
  });
  toolbar.append(reset);

  root.append(toolbar, bulk, info, scroller);
  recompute();
  renderHead();
  // Das Fenster braucht die Höhe des Scrollers, die erst nach dem Einhängen feststeht.
  queueMicrotask(() => {
    scroller.scrollTop = st.scrollTop;
    scroller.scrollLeft = st.scrollLeft;
    refresh(false);
  });
  refresh(false);
  return root;
}
