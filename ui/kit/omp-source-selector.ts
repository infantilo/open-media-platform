// <omp-source-selector> — wiederverwendbarer, hierarchischer Source-Picker
// (Ersatz für flache <select>-Dropdowns mit Sender-IDs).
//
// Reiner Darsteller: bekommt fertig aufbereitete `entries` (mit Workflow/
// Node/grouphint/Access, s. source-catalog.ts) und liefert die gewählte
// Sender-ID. Kein Netz, keine Berechtigungsberechnung, keine Node-Logik.
//
// API (bewusst wie ein <select>, damit Nodes fast nichts umbauen müssen):
//   el.entries            SourceEntry[]   (Setzen ist billig: unveränderte Listen lösen kein Rendern aus)
//   el.currentWorkflowId  string | null
//   el.accepts            MediaType[]     Medientyp-Filter
//   el.excludeRoles       string[]        z. B. ["low"]
//   el.emptyLabel         string          Text/Eintrag für Wert "" (fehlt → kein "leer"-Eintrag)
//   el.value              string          Sender-ID; "change"-Event bei Nutzerwahl
// Unbekannte gespeicherte IDs werden angezeigt ("<id> (nicht verfügbar)"),
// nie verworfen — alte Workflows bleiben gültig.
import {
  buildSourceTree,
  filterTree,
  findLeaf,
  type MediaType,
  pathToSource,
  type SourceEntry,
  type SourceGroupNode,
  type SourceTreeNode,
  visibleRows,
} from "./source-selector-logic.ts";
import { loadSourceCatalog } from "./source-catalog.ts";

const ICON: Record<string, string> = { video: "🎥", audio: "🔊", data: "▤" };

const TEMPLATE = document.createElement("template");
TEMPLATE.innerHTML = `
  <style>
    :host { display: inline-block; position: relative; font-family: var(--omp-font, system-ui, sans-serif);
      font-size: var(--omp-font-size-sm, 12px); color: var(--omp-text, #e8eaed); min-width: 0; }
    .trigger { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 6px; width: 100%;
      cursor: pointer; padding: 3px 8px; background: var(--omp-surface-raised, #24272b);
      border: 1px solid var(--omp-border, #3a3f45); border-radius: var(--omp-radius, 6px); }
    .trigger:focus-visible { outline: 2px solid var(--omp-accent, #4a9eff); }
    .trigger .label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .trigger .label.missing { color: var(--omp-warn, #e0a030); }
    .panel { position: fixed; z-index: 2500; display: none; flex-direction: column; box-sizing: border-box;
      min-width: 260px; max-height: 60vh; background: var(--omp-surface, #1a1d21);
      border: 1px solid var(--omp-border, #3a3f45); border-radius: var(--omp-radius, 6px);
      box-shadow: 0 4px 16px rgba(0,0,0,.45); }
    :host([open]) .panel { display: flex; }
    .search { all: unset; box-sizing: border-box; margin: 6px; padding: 4px 8px; background: var(--omp-surface-raised, #24272b);
      border: 1px solid var(--omp-border, #3a3f45); border-radius: var(--omp-radius, 6px); }
    .search:focus { border-color: var(--omp-accent, #4a9eff); }
    .list { overflow-y: auto; padding: 0 0 6px; }
    .row { display: flex; align-items: center; gap: 6px; padding: 3px 8px; cursor: pointer; white-space: nowrap; }
    .row:hover, .row.active { background: var(--omp-surface-raised, #2a2e33); }
    .row.active { outline: 1px solid var(--omp-accent, #4a9eff); outline-offset: -1px; }
    .row.selected { background: var(--omp-accent-dim, rgba(74,158,255,.22)); font-weight: 600; }
    .row.group { color: var(--omp-text-dim, #9aa0a6); }
    .row.section { font-weight: 700; text-transform: uppercase; font-size: var(--omp-font-size-xs, 11px); letter-spacing: .06em; }
    .row.disabled { color: var(--omp-text-disabled, #6b7076); cursor: not-allowed; }
    .row .role { margin-left: auto; color: var(--omp-text-dim, #9aa0a6); font-size: var(--omp-font-size-xs, 11px); }
    .row .caret { width: 10px; display: inline-block; }
    .empty { padding: 8px; color: var(--omp-text-dim, #9aa0a6); }
  </style>
  <button class="trigger" part="trigger" type="button" aria-haspopup="tree">
    <span class="label"></span><span aria-hidden="true">▾</span>
  </button>
  <div class="panel" part="panel">
    <input class="search" type="text" placeholder="🔍 Quellen suchen …" aria-label="Quellen suchen" />
    <div class="list" role="tree"></div>
  </div>
`;

export class OmpSourceSelector extends HTMLElement {
  /** Adapter-Helfer für Node-Bundles (kein Import dort möglich): `OmpSourceSelector.loadCatalog(nodeId, senders?)`. */
  static loadCatalog = loadSourceCatalog;

  #entries: SourceEntry[] = [];
  #entriesKey = "[]";
  #currentWorkflowId: string | null = null;
  #accepts: MediaType[] = [];
  #excludeRoles: string[] = [];
  #emptyLabel: string | null = null;
  #value = "";
  #tree: SourceGroupNode[] | null = null; // memoisiert, wird bei Eingabeänderung verworfen
  #open = new Map<string, boolean>(); // Nutzer-Zustand je Gruppen-ID
  #query = "";
  #active = 0;
  #triggerEl: HTMLButtonElement;
  #labelEl: HTMLElement;
  #panelEl: HTMLElement;
  #searchEl: HTMLInputElement;
  #listEl: HTMLElement;
  #onDocDown = (ev: Event) => {
    if (!ev.composedPath().includes(this)) this.#close();
  };

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    shadow.append(TEMPLATE.content.cloneNode(true));
    this.#triggerEl = shadow.querySelector(".trigger")!;
    this.#labelEl = shadow.querySelector(".trigger .label")!;
    this.#panelEl = shadow.querySelector(".panel")!;
    this.#searchEl = shadow.querySelector(".search")!;
    this.#listEl = shadow.querySelector(".list")!;
    this.#triggerEl.addEventListener("click", () => (this.hasAttribute("open") ? this.#close() : this.#openPanel()));
    this.#searchEl.addEventListener("input", () => {
      this.#query = this.#searchEl.value;
      // Bei aktiver Suche direkt auf den ersten Treffer (Blatt) springen, nicht auf eine Gruppenzeile.
      this.#active = Math.max(0, this.#rows().findIndex((r) => r.node?.type === "source"));
      this.#renderList();
    });
    this.#panelEl.addEventListener("keydown", (ev) => this.#onKey(ev as KeyboardEvent));
    this.#triggerEl.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown" || ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        this.#openPanel();
      }
    });
    this.#renderTrigger();
  }

  connectedCallback() {
    document.addEventListener("pointerdown", this.#onDocDown, true);
  }
  disconnectedCallback() {
    document.removeEventListener("pointerdown", this.#onDocDown, true);
  }

  get entries(): SourceEntry[] {
    return this.#entries;
  }
  set entries(list: SourceEntry[]) {
    const key = JSON.stringify(list ?? []);
    if (key === this.#entriesKey) return; // Polling-sicher: nichts neu bauen, Panel bleibt stabil
    this.#entriesKey = key;
    this.#entries = list ?? [];
    this.#invalidate();
  }
  get currentWorkflowId() {
    return this.#currentWorkflowId;
  }
  set currentWorkflowId(v: string | null) {
    if ((v ?? null) === this.#currentWorkflowId) return;
    this.#currentWorkflowId = v ?? null;
    this.#invalidate();
  }
  set accepts(v: MediaType[]) {
    this.#accepts = v ?? [];
    this.#invalidate();
  }
  set excludeRoles(v: string[]) {
    this.#excludeRoles = v ?? [];
    this.#invalidate();
  }
  get emptyLabel() {
    return this.#emptyLabel ?? "";
  }
  set emptyLabel(v: string) {
    this.#emptyLabel = v || null;
    this.#renderTrigger();
    if (this.hasAttribute("open")) this.#renderList();
  }
  get value() {
    return this.#value;
  }
  set value(v: string) {
    v = v ?? "";
    if (v === this.#value) return;
    this.#value = v;
    this.#renderTrigger();
    if (this.hasAttribute("open")) this.#renderList();
  }

  #getTree(): SourceGroupNode[] {
    return this.#tree ??= buildSourceTree(this.#entries, {
      currentWorkflowId: this.#currentWorkflowId,
      accepts: this.#accepts,
      excludeRoles: this.#excludeRoles,
    });
  }
  #invalidate() {
    this.#tree = null;
    this.#renderTrigger();
    if (this.hasAttribute("open")) this.#renderList();
  }

  #isOpen = (g: SourceGroupNode): boolean => this.#query ? true : (this.#open.get(g.id) ?? g.defaultOpen);

  #renderTrigger() {
    const leaf = this.#value ? findLeaf(this.#getTree(), this.#value) : null;
    let text: string;
    let missing = false;
    if (!this.#value) text = this.#emptyLabel ?? "— auswählen —";
    else if (leaf) text = leaf.label;
    else {
      // Gespeicherte ID (evtl. vom Filter ausgeblendet oder offline): mit Label aus entries, sonst rohe ID.
      const raw = this.#entries.find((e) => e.id === this.#value);
      text = `${raw?.label ?? this.#value}${raw ? "" : " (nicht verfügbar)"}`;
      missing = !raw;
    }
    this.#labelEl.textContent = text;
    this.#labelEl.title = text;
    this.#labelEl.classList.toggle("missing", missing);
  }

  #rows() {
    const tree = this.#query ? filterTree(this.#getTree(), this.#query) : this.#getTree();
    const rows: { node: SourceTreeNode | null; depth: number }[] = [];
    if (this.#emptyLabel !== null && !this.#query) rows.push({ node: null, depth: 0 });
    for (const r of visibleRows(tree, this.#isOpen)) rows.push(r);
    return rows;
  }

  #renderList() {
    const rows = this.#rows();
    this.#active = Math.min(this.#active, Math.max(0, rows.length - 1));
    this.#listEl.replaceChildren();
    if (rows.length === 0) {
      const d = document.createElement("div");
      d.className = "empty";
      d.textContent = this.#query ? "Keine Treffer" : "Keine Quellen verfügbar";
      this.#listEl.append(d);
      return;
    }
    rows.forEach((r, i) => {
      const el = document.createElement("div");
      el.className = "row";
      el.style.paddingLeft = `${8 + r.depth * 14}px`;
      el.dataset.idx = String(i);
      el.setAttribute("role", "treeitem");
      const n = r.node;
      if (n === null) {
        el.textContent = this.#emptyLabel!;
        if (!this.#value) el.classList.add("selected");
      } else if (n.type === "group") {
        const open = this.#isOpen(n);
        el.classList.add("group", ...(n.level === "section" ? ["section"] : []));
        el.setAttribute("aria-expanded", String(open));
        el.innerHTML = `<span class="caret">${open ? "▼" : "▶"}</span>`;
        el.append(document.createTextNode(n.label));
      } else {
        const icon = n.entry.mediaType ? ICON[n.entry.mediaType] + " " : "";
        el.append(document.createTextNode(`${icon}${n.label}`));
        if (n.role) {
          const role = document.createElement("span");
          role.className = "role";
          role.textContent = n.role;
          el.append(role);
        }
        if (!n.selectable) {
          el.classList.add("disabled");
          el.setAttribute("aria-disabled", "true");
          el.append(document.createTextNode(" 🔒"));
        }
        if (n.id === this.#value) el.classList.add("selected");
      }
      if (i === this.#active) el.classList.add("active");
      el.addEventListener("click", () => this.#activate(r.node));
      this.#listEl.append(el);
    });
    this.#listEl.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }

  #activate(n: SourceTreeNode | null) {
    if (n === null) return this.#choose("");
    if (n.type === "group") {
      this.#open.set(n.id, !this.#isOpen(n));
      this.#renderList();
    } else if (n.selectable) this.#choose(n.id);
  }

  #choose(id: string) {
    const changed = id !== this.#value;
    this.#value = id;
    this.#renderTrigger();
    this.#close();
    if (changed) this.dispatchEvent(new Event("change", { bubbles: true }));
  }

  #onKey(ev: KeyboardEvent) {
    const rows = this.#rows();
    const cur = rows[this.#active]?.node;
    switch (ev.key) {
      case "ArrowDown":
      case "ArrowUp": {
        // Bei aktiver Suche nur zwischen Treffern (Blättern) springen; Gruppen sind dort ohnehin offen.
        const step = ev.key === "ArrowDown" ? 1 : -1;
        let i = this.#active + step;
        while (this.#query && i >= 0 && i < rows.length && rows[i].node?.type !== "source") i += step;
        if (i >= 0 && i < rows.length) this.#active = i;
        break;
      }
      case "ArrowRight":
        if (!this.#query && cur?.type === "group" && !this.#isOpen(cur)) this.#open.set(cur.id, true);
        else if (this.#query || !cur || cur.type !== "group") return;
        break;
      case "ArrowLeft":
        if (!this.#query && cur?.type === "group" && this.#isOpen(cur)) this.#open.set(cur.id, false);
        else return;
        break;
      case "Enter":
        ev.preventDefault();
        this.#activate(cur ?? null);
        return;
      case "Escape":
        ev.preventDefault();
        this.#close();
        this.#triggerEl.focus();
        return;
      default:
        return;
    }
    ev.preventDefault();
    this.#renderList();
  }

  #openPanel() {
    if (this.hasAttribute("open")) return;
    this.#query = "";
    this.#searchEl.value = "";
    // Pfad zur aktuellen Auswahl aufklappen, damit sie sichtbar ist.
    const path = this.#value ? pathToSource(this.#getTree(), this.#value) : null;
    for (const id of path ?? []) this.#open.set(id, true);
    this.setAttribute("open", "");
    const r = this.getBoundingClientRect();
    this.#panelEl.style.minWidth = `${Math.max(260, r.width)}px`;
    this.#panelEl.style.left = `${Math.max(4, Math.min(r.left, innerWidth - 270))}px`;
    const below = innerHeight - r.bottom;
    if (below < 240 && r.top > below) {
      this.#panelEl.style.top = "auto";
      this.#panelEl.style.bottom = `${innerHeight - r.top + 2}px`;
    } else {
      this.#panelEl.style.bottom = "auto";
      this.#panelEl.style.top = `${r.bottom + 2}px`;
    }
    const rows = this.#rows();
    const sel = rows.findIndex((x) => x.node?.type === "source" && x.node.id === this.#value);
    this.#active = sel >= 0 ? sel : 0;
    this.#renderList();
    this.#searchEl.focus();
  }

  #close() {
    this.removeAttribute("open");
  }
}

if (!customElements.get("omp-source-selector")) {
  customElements.define("omp-source-selector", OmpSourceSelector);
}
