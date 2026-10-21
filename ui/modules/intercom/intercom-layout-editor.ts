// Editor für Panel-Layouts (Kapitel 47): Seiten mit Tasten, je Taste Art, Ziel, Beschriftung und Stil.
// Arbeitet auf dem Entwurf (kein eigenes Speichern); `changed` zieht nur die Speichern-Knöpfe nach, `rebuild` baut den Editor neu auf.

import { t as tt } from "../host.ts";
import { addKey, addPage, type Config, KEY_TYPES, type Key, keyCaption, type KeyType, type Layout, MAX_KEYS, MAX_PAGES, moveKey, movePage, removeKey, removePage } from "./intercom-logic.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

const DIM = "color:var(--omp-text-dim);";
export const typeLabel = (t: KeyType): string => tt(`icom.key.${t}` as never);

function small(text: string, onClick: () => void, title = "", disabled = false): HTMLButtonElement {
  const b = el("button", "padding:1px 7px;", text);
  b.title = title;
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

export function layoutEditor(layout: Layout, cfg: Config, changed: () => void, rebuild: () => void): HTMLElement {
  const root = el("div", "border:1px dashed var(--omp-border);border-radius:6px;padding:8px;margin-top:6px;");
  root.dataset.role = "layout-editor";
  layout.pages.forEach((pg, pi) => {
    const page = el("div", "border:1px solid var(--omp-border);border-radius:6px;padding:8px;margin-bottom:8px;");
    page.dataset.page = String(pi);
    const head = el("div", "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px;");
    const name = el("input", "padding:3px 6px;width:150px;");
    name.placeholder = tt("icom.layout.pageName", { p0: pi + 1 });
    name.value = pg.name;
    name.addEventListener("input", () => {
      pg.name = name.value;
      changed();
    });
    head.append(
      el("strong", "", tt("icom.layout.page", { p0: pi + 1 })),
      name,
      small("◀", () => { movePage(layout, pi, -1); rebuild(); }, tt("icom.layout.pageLeft"), pi === 0),
      small("▶", () => { movePage(layout, pi, 1); rebuild(); }, tt("icom.layout.pageRight"), pi === layout.pages.length - 1),
      small("✕", () => { removePage(layout, pi); rebuild(); }, tt("icom.layout.pageRemove"), layout.pages.length < 2),
    );
    page.append(head);

    // Vorschau: so ordnet das Panel die Tasten (Karten ganz, Tasten und Rufen im Raster)
    const preview = el("div", "display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;");
    preview.dataset.role = "preview";
    for (const k of pg.keys) {
      const strip = k.type === "channel" && k.style !== "key";
      const chip = el("span", `border:1px solid var(--omp-border);border-radius:4px;padding:1px 6px;font-size:11px;${strip ? "width:100%;background:var(--omp-surface);" : ""}`, keyCaption(k, cfg, typeLabel));
      preview.append(chip);
    }
    if (pg.keys.length === 0) preview.append(el("span", "font-size:12px;" + DIM, tt("icom.layout.emptyPage")));
    page.append(preview);

    pg.keys.forEach((k, ki) => page.append(keyRow(layout, pi, ki, k, cfg, changed, rebuild)));

    const add = el("div", "display:flex;gap:8px;align-items:center;margin-top:6px;");
    const type = el("select", "padding:3px 6px;");
    for (const ty of KEY_TYPES) {
      const o = el("option", "", typeLabel(ty));
      o.value = ty;
      type.append(o);
    }
    const addBtn = el("button", "padding:3px 10px;", tt("icom.layout.addKey"));
    addBtn.disabled = pg.keys.length >= MAX_KEYS;
    addBtn.addEventListener("click", () => {
      const ty = type.value as KeyType;
      const target = ty === "channel" ? cfg.channels[0]?.id : ty === "call" ? cfg.parties[0]?.id : undefined;
      addKey(layout, pi, ty, target);
      rebuild();
    });
    add.append(type, addBtn);
    page.append(add);
    root.append(page);
  });
  const addPageBtn = el("button", "padding:3px 10px;", tt("icom.layout.addPage"));
  addPageBtn.disabled = layout.pages.length >= MAX_PAGES;
  addPageBtn.addEventListener("click", () => {
    addPage(layout);
    rebuild();
  });
  root.append(addPageBtn);
  return root;
}

function keyRow(layout: Layout, pi: number, ki: number, k: Key, cfg: Config, changed: () => void, rebuild: () => void): HTMLElement {
  const row = el("div", "display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:4px;");
  row.dataset.key = String(ki);
  const type = el("select", "padding:3px 6px;");
  for (const ty of KEY_TYPES) {
    const o = el("option", "", typeLabel(ty));
    o.value = ty;
    type.append(o);
  }
  type.value = k.type;
  type.addEventListener("change", () => {
    const ty = type.value as KeyType;
    k.type = ty;
    delete k.ch;
    delete k.party;
    delete k.style;
    if (ty === "channel") {
      k.ch = cfg.channels[0]?.id;
      k.style = "strip";
    }
    if (ty === "call") k.party = cfg.parties[0]?.id;
    rebuild();
  });
  row.append(type);
  if (k.type === "channel" || k.type === "call") {
    const target = el("select", "padding:3px 6px;min-width:120px;");
    const list = k.type === "channel" ? cfg.channels.map((c) => ({ id: c.id, name: c.name })) : cfg.parties.map((p) => ({ id: p.id, name: p.name }));
    for (const x of list) {
      const o = el("option", "", x.name || `#${x.id}`);
      o.value = String(x.id);
      target.append(o);
    }
    target.value = String(k.type === "channel" ? k.ch : k.party);
    target.addEventListener("change", () => {
      if (k.type === "channel") k.ch = Number(target.value);
      else k.party = Number(target.value);
      rebuild();
    });
    row.append(target);
  }
  if (k.type === "channel") {
    const style = el("select", "padding:3px 6px;");
    for (const [v, key] of [["strip", "icom.layout.styleStrip"], ["key", "icom.layout.styleKey"]] as const) {
      const o = el("option", "", tt(key as never));
      o.value = v;
      style.append(o);
    }
    style.value = k.style === "key" ? "key" : "strip";
    style.addEventListener("change", () => {
      k.style = style.value as "strip" | "key";
      rebuild();
    });
    row.append(style);
  }
  const label = el("input", "padding:3px 6px;width:170px;");
  label.placeholder = tt("icom.layout.label");
  label.maxLength = 40;
  label.value = k.label ?? "";
  label.addEventListener("input", () => {
    k.label = label.value;
    changed();
  });
  row.append(
    label,
    small("▲", () => { moveKey(layout, pi, ki, -1); rebuild(); }, tt("icom.layout.up"), ki === 0),
    small("▼", () => { moveKey(layout, pi, ki, 1); rebuild(); }, tt("icom.layout.down"), ki === layout.pages[pi].keys.length - 1),
    small("✕", () => { removeKey(layout, pi, ki); rebuild(); }, tt("icom.layout.remove")),
  );
  return row;
}
