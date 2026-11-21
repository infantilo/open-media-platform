// Matrix-Ansicht (106.15e): Quellen (laufende Nodes mit Bild-/Ton-Flows) in Zeilen, Leitungen des Events in Spalten.
// Ein Klick auf den Kreuzpunkt nimmt die Quelle in die Leitung auf bzw. wieder heraus. Änderungen gelten erst mit „Übernehmen“.
import { t } from "../host.ts";
import { loadSourceNodes } from "./line-form.ts";
import { h, modal, note } from "./mcr-dom.ts";
import { filterRows, isOn, isOtherSource, type MxLine, type MxNode, type MxRow, sourceSummary, toggle } from "./matrix-logic.ts";

export function openMatrix<L extends MxLine>(initial: L[]): Promise<L[] | null> {
  let lines: L[] = initial.map((l) => structuredClone(l));
  let nodes: MxNode[] = [];
  let query = "";
  const collapsed = new Set<string>();
  const search = h("input", { type: "search", class: "mcr-mx-search", placeholder: t("mcr.mx.search"), "aria-label": t("mcr.mx.search") }) as HTMLInputElement;
  const scroll = h("div", { class: "mcr-mx-scroll" });
  const status = h("div", { class: "mcr-hint", "aria-live": "polite" }, t("mcr.src.loading"));

  const cell = (li: number, row: MxRow): HTMLElement => {
    const l = lines[li];
    const on = isOn(l, row);
    const other = isOtherSource(l, row);
    const b = h("button", {
      type: "button", class: `mcr-mx-x${on ? " on" : ""}${other ? " other" : ""}${row.type !== "video" ? ` ${row.type === "audio" ? "aud" : "dat"}` : ""}`, "aria-pressed": String(on),
      title: `${l.name || t("mcr.mx.unnamed")} ← ${row.node.label} · ${row.label}${other ? ` (${t("mcr.mx.replaces")})` : ""}`,
      "aria-label": `${l.name} ${row.node.label} ${row.label}`,
    }, on ? "●" : "");
    b.addEventListener("click", () => {
      lines[li] = toggle(l, row) as L;
      draw();
    });
    return h("td", {}, b);
  };

  const draw = () => {
    const top = scroll.scrollTop;
    const left = scroll.scrollLeft;
    const head = h("tr", {}, h("th", { class: "mcr-mx-corner" }, t("mcr.mx.sources")));
    lines.forEach((l) => {
      const s = sourceSummary(l);
      const mk = (k: string, v: string, extra = "") => h("span", {}, `${t(`mcr.mx.${k}`)}: ${v || "–"}${extra}`);
      const subs = s ? [mk("video", s.video), mk("audio", s.audio, s.tracks ? ` (${s.tracks})` : ""), mk("data", s.data)] : [h("span", {}, t("mcr.mx.own"))];
      head.append(h("th", { class: "mcr-mx-col", title: `${l.name}${s ? ` — ${[s.video, s.audio, s.data].join(" / ")}` : ""}` }, h("b", {}, l.name || t("mcr.mx.unnamed")), ...subs));
    });
    const body = h("tbody");
    let shown = 0;
    for (const n of nodes) {
      const rows = filterRows(n, query);
      if (!rows.length) continue;
      shown++;
      const open = !collapsed.has(n.id) || query.trim() !== "";
      const used = lines.filter((l) => rows.some((r) => isOn(l, r))).length;
      const g = h("button", { type: "button", class: "mcr-mx-group", "aria-expanded": String(open) }, h("i", {}, open ? "▾" : "▸"), n.label, h("em", {}, used ? t("mcr.mx.used", { n: used }) : ""));
      g.addEventListener("click", () => {
        if (collapsed.has(n.id)) collapsed.delete(n.id);
        else collapsed.add(n.id);
        draw();
      });
      body.append(h("tr", { class: "mcr-mx-grow" }, h("th", { colspan: String(lines.length + 1) }, g)));
      if (!open) continue;
      for (const r of rows) {
        const tr = h("tr", {}, h("th", { class: `mcr-mx-row ${r.type}` }, h("span", { class: "mcr-mx-kind" }, t(`mcr.mx.${r.type}`)), r.label));
        lines.forEach((_, li) => tr.append(cell(li, r)));
        body.append(tr);
      }
    }
    scroll.replaceChildren(h("table", { class: "mcr-mx-table" }, h("thead", {}, head), body));
    scroll.scrollTop = top;
    scroll.scrollLeft = left;
    status.textContent = !nodes.length ? t("mcr.src.none") : !shown ? t("mcr.mx.nomatch") : "";
  };
  search.addEventListener("input", () => {
    query = search.value;
    draw();
  });
  void loadSourceNodes().then((list) => {
    nodes = list as MxNode[];
    draw();
  });
  draw();
  const body = h("div", { class: "mcr-mx" }, h("div", { class: "mcr-mx-bar" }, search, h("span", { class: "mcr-hint" }, t("mcr.mx.hint"))), scroll, status,
    lines.length ? null : note(t("mcr.mx.noLines")));
  return modal<L[]>(t("mcr.mx.title"), body, { save: t("mcr.apply"), wide: true, onSave: () => lines });
}
