// Port-Tag-Editor: der 🏷-Knopf im Kachelkopf der Flow-Editor-Kachel öffnet
// ein Popover, in dem die EXPLICIT-Tags eines Senders (Ausgang) bzw. Receivers
// (Eingang) bearbeitet werden — der Port ist per Auswahlliste wählbar — Grundlage tag-basierter Schaltungen
// (X/Y-Panel, Playout-Quellenwahl). Gespeichert wird erst mit „Speichern“
// (PUT /api/v1/sources|sinks/{id}/tags ersetzt die Liste). Abgeleitete und vom
// Node gemeldete Tags sind nur zur Ansicht da.
import { t } from "../shell/i18n.ts";
import { apiFetch } from "../shell/connection.ts";
import {
  addTag,
  explicitTags,
  inheritedTags,
  type PortTag,
  removeTag,
  sameTags,
} from "./port-tag-editor-logic.ts";

export interface PortTagTarget {
  side: "input" | "output";
  portId: string;
  label: string;
}

let openClose: (() => void) | null = null;

export async function openPortTagEditor(anchor: { x: number; y: number }, targets: PortTagTarget[], onError: (msg: string) => void) {
  openClose?.();
  if (targets.length === 0) return;
  let target = targets[0]!;
  let saved: string[] = [];
  let edited: string[] = [];
  let inherited: PortTag[] = [];

  async function load(): Promise<boolean> {
    const kind = target.side === "output" ? "sources" : "sinks";
    const idKey = target.side === "output" ? "senderId" : "receiverId";
    try {
      const res = await apiFetch(`/api/v1/${kind}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = (await res.json()) as Array<Record<string, unknown> & { tags?: PortTag[] }>;
      const entry = list.find((e) => e[idKey] === target.portId);
      if (!entry) {
        onError(t("portTags.unknown"));
        return false;
      }
      const tags = entry.tags ?? [];
      saved = explicitTags(tags);
      edited = [...saved];
      inherited = inheritedTags(tags);
      return true;
    } catch (err) {
      onError(t("portTags.loadFailed", { err: String(err) }));
      return false;
    }
  }
  if (!(await load())) return;

  const box = document.createElement("div");
  box.className = "omp-popover";
  box.setAttribute("data-role", "port-tag-editor");
  box.style.cssText =
    "position:fixed;z-index:30;width:300px;padding:var(--omp-space-3,10px);display:flex;" +
    "flex-direction:column;gap:8px;font-size:12px;";
  box.style.left = `${Math.max(0, Math.min(anchor.x, globalThis.innerWidth - 320))}px`;
  box.style.top = `${Math.max(0, Math.min(anchor.y, globalThis.innerHeight - 300))}px`;

  const title = document.createElement("div");
  title.style.fontWeight = "bold";

  const select = document.createElement("select");
  select.setAttribute("data-role", "tag-port-select");
  targets.forEach((tg, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = `${tg.side === "output" ? "→" : "←"} ${tg.label}`;
    select.append(o);
  });
  select.style.display = targets.length > 1 ? "" : "none";
  select.addEventListener("change", async () => {
    target = targets[Number(select.value)]!;
    if (await load()) refresh();
  });

  const chips = document.createElement("div");
  chips.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;";
  const inheritedCap = document.createElement("div");
  inheritedCap.style.opacity = ".7";
  inheritedCap.textContent = t("portTags.inherited");
  inheritedCap.title = t("portTags.inheritedHint");
  const inheritedBox = document.createElement("div");
  inheritedBox.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;opacity:.7;";

  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:4px;";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = t("portTags.placeholder");
  input.style.cssText = "flex:1;min-width:0;";
  input.setAttribute("data-role", "tag-input");
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.textContent = "+";
  addBtn.title = t("portTags.add");
  row.append(input, addBtn);

  const msg = document.createElement("div");
  msg.style.cssText = "color:var(--omp-error,#e55);min-height:14px;";

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;justify-content:flex-end;gap:6px;";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = t("portTags.cancel");
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = t("portTags.save");
  save.setAttribute("data-role", "tag-save");
  actions.append(cancel, save);
  box.append(title, select, chips, inheritedCap, inheritedBox, row, msg, actions);

  function chip(text: string, prefix: string, onRemove: (() => void) | null): HTMLElement {
    const c = document.createElement("span");
    c.style.cssText =
      "display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border:1px solid var(--omp-border);" +
      "border-radius:10px;background:var(--omp-bg);";
    c.textContent = `${prefix} ${text}`.trim();
    if (onRemove) {
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = "×";
      x.title = t("portTags.remove");
      x.style.cssText = "border:none;background:none;color:inherit;cursor:pointer;padding:0 2px;";
      x.addEventListener("click", onRemove);
      c.append(x);
    }
    return c;
  }

  function refresh() {
    title.textContent = t(target.side === "output" ? "portTags.titleOut" : "portTags.titleIn", { label: target.label });
    chips.replaceChildren(
      ...(edited.length
        ? edited.map((tg) => chip(tg, "", () => { edited = removeTag(edited, tg); refresh(); }))
        : [Object.assign(document.createElement("span"), { textContent: t("portTags.none"), style: "opacity:.6;" })]),
    );
    inheritedBox.replaceChildren(...inherited.map((tg) => chip(tg.tag, tg.origin === "DERIVED" ? "ⓘ" : "◌", null)));
    inheritedCap.style.display = inheritedBox.style.display = inherited.length ? "" : "none";
    const dirty = !sameTags(edited, saved);
    save.disabled = !dirty;
    select.disabled = dirty; // ungespeicherte Änderungen nicht beim Portwechsel verlieren
    select.title = dirty ? t("portTags.saveFirst") : "";
    msg.textContent = "";
  }

  function doAdd() {
    const r = addTag(edited, input.value);
    if (!r.ok) {
      msg.textContent = t(`portTags.err.${r.reason}`);
      return;
    }
    edited = r.tags;
    input.value = "";
    refresh();
  }
  addBtn.addEventListener("click", doAdd);
  input.addEventListener("keydown", (k) => {
    if (k.key === "Enter") { k.preventDefault(); doAdd(); }
    if (k.key === "Escape") close();
  });

  function close() {
    box.remove();
    document.removeEventListener("pointerdown", outside, { capture: true });
    if (openClose === close) openClose = null;
  }
  const outside = (e: PointerEvent) => {
    if (!box.contains(e.target as Node)) close();
  };
  cancel.addEventListener("click", close);
  save.addEventListener("click", async () => {
    // Offene Eingabe nicht verlieren: noch nicht hinzugefügten Text mitnehmen.
    if (input.value.trim()) {
      doAdd();
      if (msg.textContent) return;
    }
    const kind = target.side === "output" ? "sources" : "sinks";
    save.disabled = true;
    try {
      const res = await apiFetch(`/api/v1/${kind}/${encodeURIComponent(target.portId)}/tags`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: edited }),
      });
      if (!res.ok) {
        msg.textContent = (await res.text()).trim() || `HTTP ${res.status}`;
        save.disabled = false;
        return;
      }
      close();
    } catch (err) {
      msg.textContent = String(err);
      save.disabled = false;
    }
  });

  openClose = close;
  refresh();
  document.body.append(box);
  // Der auslösende Klick darf das Popover nicht sofort wieder schließen.
  setTimeout(() => document.addEventListener("pointerdown", outside, { capture: true }), 0);
  input.focus();
}
