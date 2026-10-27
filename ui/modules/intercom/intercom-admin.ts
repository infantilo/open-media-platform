// Administration → Produktion → Intercom (Kapitel 47): Kanäle, Teilnehmer (mit Kanal-Matrix), Gäste und Betriebsstatus.
// Explizites Speichern (Entwurf lokal, ein PUT); Gäste und Zugangslinks laufen über eigene Endpunkte und wirken sofort.

import { apiFetch, confirmDialog, dateLocale, directory, showToast, t as tt } from "../host.ts";
import { layoutEditor } from "./intercom-layout-editor.ts";
import { matrixView, type MatrixState, newMatrixState } from "./intercom-matrix.ts";
import { addParties, duplicateParty, filterParties, MAX_BULK_ADD } from "./intercom-scale.ts";
import {
  addTemplate, layoutFromAssignment, layoutMode, removeTemplate,
  addChannel, addParty, cleanConfig, clone, type Config, type Guest, getRoute, guestRoutes, localProblems, type Party, type PartyKind, removeChannel,
  removeParty, sameConfig, setRoute, splitList,
} from "./intercom-logic.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

const DIM = "color:var(--omp-text-dim);";
const BOX = "border:1px solid var(--omp-border);border-radius:8px;padding:12px 14px;margin-bottom:16px;";
const H = "font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--omp-text-dim);margin:0 0 8px;";

function field(label: string, input: HTMLElement, width = ""): HTMLElement {
  const w = el("label", `display:flex;flex-direction:column;gap:2px;${width ? `width:${width};` : ""}`);
  w.append(el("span", "font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--omp-text-dim);", label), input);
  return w;
}

function textInput(value: string, onInput: (v: string) => void, width = "", placeholder = ""): HTMLInputElement {
  const i = el("input", `padding:3px 6px;${width ? `width:${width};` : ""}`);
  i.value = value;
  if (placeholder) i.placeholder = placeholder;
  i.addEventListener("input", () => onInput(i.value));
  return i;
}

function check(label: string, on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const l = el("label", "display:flex;gap:6px;align-items:center;font-size:13px;");
  const c = el("input");
  c.type = "checkbox";
  c.checked = on;
  c.addEventListener("change", () => onChange(c.checked));
  l.append(c, el("span", "", label));
  return l;
}

function btn(text: string, onClick: () => void, title = ""): HTMLButtonElement {
  const b = el("button", "padding:3px 10px;", text);
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

type Tab = "assign" | "parties" | "channels" | "layouts" | "guests";
const TABS: Tab[] = ["assign", "parties", "channels", "layouts", "guests"];
function loadTab(): Tab {
  try {
    const v = localStorage.getItem("omp-intercom-admin-tab") as Tab | null;
    if (v && TABS.includes(v)) return v;
  } catch { /* Speicher gesperrt: Standardreiter */ }
  return "assign";
}

interface Status {
  parties: { id: number; online: boolean; speaking: boolean }[];
  late_ticks: number;
  max_tick_us: number;
}

class IntercomAdmin extends HTMLElement {
  #saved: Config = { channels: [], parties: [] };
  #draft: Config = { channels: [], parties: [] };
  #guests: Guest[] = [];
  #status: Status | null = null;
  #statusError = "";
  #error = "";
  #groups: { id: string; name: string }[] = [];
  #guestSel = new Set<number>();
  #guestTalk = true;
  #guestName = "";
  #guestTtl = 120;
  #timer = 0;
  #loaded = false;
  #tab: Tab = loadTab();
  #selParty = 0;
  #matrix: MatrixState = newMatrixState();
  // Teilnehmerliste: Filter und Sammelanlage
  #pText = "";
  #pKind: PartyKind | "all" = "all";
  #bulkPrefix = "";
  #bulkCount = 10;
  #bulkKind: PartyKind = "human";
  #bulkLike = 0;

  connectedCallback() {
    this.style.cssText = "display:block;";
    if (!this.#loaded) {
      this.#loaded = true;
      void this.#load();
    }
    this.#timer = setInterval(() => void this.#poll(), 2000) as unknown as number;
    void this.#poll();
    this.#render();
  }

  disconnectedCallback() {
    clearInterval(this.#timer);
  }

  async #load() {
    try {
      const [cfg, guests, dir] = await Promise.all([apiFetch("/api/v1/ext/intercom/config"), apiFetch("/api/v1/ext/intercom/guests"), directory()]);
      if (!cfg.ok) throw new Error(((await cfg.json().catch(() => ({}))) as { error?: string }).error ?? String(cfg.status));
      this.#saved = (await cfg.json()) as Config;
      this.#draft = clone(this.#saved);
      this.#guests = guests.ok ? ((await guests.json()) as Guest[]) : [];
      this.#groups = dir?.groups ?? [];
      this.#error = "";
    } catch (e) {
      this.#error = tt("icom.loadFailed", { p0: (e as Error).message });
    }
    this.#render();
  }

  async #poll() {
    try {
      const r = await apiFetch("/api/v1/ext/intercom/status");
      if (!r.ok) throw new Error(String(r.status));
      this.#status = (await r.json()) as Status;
      this.#statusError = "";
    } catch {
      this.#status = null;
      this.#statusError = tt("icom.noNode");
    }
    this.#renderStatus();
  }

  #dirty(): boolean {
    return !sameConfig(this.#draft, this.#saved);
  }

  async #save() {
    const problems = localProblems(this.#draft);
    if (problems.length) {
      this.#error = tt("icom.saveFailed", { p0: problems.join(", ") });
      this.#render();
      return;
    }
    const res = await apiFetch("/api/v1/ext/intercom/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(cleanConfig(this.#draft)) });
    const body = (await res.json().catch(() => ({}))) as Config & { error?: string; problems?: string[] };
    if (!res.ok) {
      this.#error = tt("icom.saveFailed", { p0: body.problems?.join("; ") ?? body.error ?? String(res.status) });
      this.#render();
      return;
    }
    this.#saved = body;
    this.#draft = clone(body);
    this.#error = "";
    showToast(tt("icom.saved"));
    this.#render();
  }

  #render() {
    this.replaceChildren();
    if (this.#error) this.append(el("div", "color:var(--omp-error);margin-bottom:10px;", this.#error));

    const bar = el("div", "display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap;");
    bar.dataset.role = "bar";
    const dirty = this.#dirty();
    const save = btn(tt("icom.save"), () => void this.#save());
    save.disabled = !dirty;
    const discard = btn(tt("icom.discard"), () => {
      this.#draft = clone(this.#saved);
      this.#error = "";
      this.#render();
    });
    discard.disabled = !dirty;
    bar.append(save, discard);
    if (dirty) bar.append(el("span", "color:var(--omp-warning,#b58900);font-size:12px;", tt("icom.dirty")));
    const st = el("span", `margin-left:auto;font-size:12px;${DIM}`);
    st.dataset.role = "status";
    bar.append(st);
    this.append(bar);

    const tabs = el("div", "display:flex;gap:2px;border-bottom:1px solid var(--omp-border);margin-bottom:14px;flex-wrap:wrap;");
    tabs.dataset.role = "tabs";
    for (const k of TABS) {
      const on = k === this.#tab;
      const b = el("button", `padding:7px 16px;border:0;border-bottom:2px solid ${on ? "var(--omp-accent-cyan,#19d3f3)" : "transparent"};border-radius:0;background:none;font-weight:${on ? 700 : 400};${on ? "" : DIM}cursor:pointer;`, tt(`icom.tab.${k}` as never));
      b.dataset.tab = k;
      b.addEventListener("click", () => this.#goto(k));
      tabs.append(b);
    }
    this.append(tabs);

    if (this.#tab === "assign") this.append(this.#assignTab());
    else if (this.#tab === "parties") this.append(this.#partiesBox());
    else if (this.#tab === "channels") this.append(this.#channelsBox());
    else if (this.#tab === "layouts") this.append(this.#templatesBox());
    else this.append(this.#guestsBox());
    this.#renderStatus();
  }

  #goto(k: Tab, party?: number) {
    this.#tab = k;
    if (party !== undefined) this.#selParty = party;
    try {
      localStorage.setItem("omp-intercom-admin-tab", k);
    } catch { /* ohne Speicher: nur für diese Sitzung */ }
    this.#render();
  }

  /** Gesamttabelle Teilnehmer × Kanäle: je Zelle Sprechen (Mikrofon) und Hören (Kopfhörer) per Klick. */
  #assignTab(): HTMLElement {
    const box = el("div", BOX);
    box.dataset.role = "assign";
    box.append(el("div", DIM + "font-size:12px;margin-bottom:10px;", tt("icom.assign.hint")));
    const { channels, parties } = this.#draft;
    if (!channels.length || !parties.length) {
      const empty = el("div", "padding:10px 0;");
      empty.append(el("div", DIM + "margin-bottom:8px;", tt("icom.assign.needBoth")));
      const row = el("div", "display:flex;gap:8px;");
      if (!channels.length) row.append(btn(tt("icom.assign.toChannels"), () => this.#goto("channels")));
      if (!parties.length) row.append(btn(tt("icom.assign.toParties"), () => this.#goto("parties")));
      empty.append(row);
      box.append(empty);
      return box;
    }
    box.append(matrixView({
      draft: () => this.#draft,
      state: this.#matrix,
      changed: () => this.#touch(),
      rebuild: () => this.#render(),
      openParty: (id) => this.#goto("parties", id),
      paintDots: () => this.#paintDots(),
    }));
    return box;
  }

  #renderStatus() {
    const line = this.querySelector<HTMLElement>("[data-role=status]");
    if (!line) return;
    if (!this.#status) {
      line.textContent = this.#statusError || "…";
      line.style.color = "var(--omp-error)";
    } else {
      const online = this.#status.parties.filter((p) => p.online).length;
      line.style.color = "";
      line.textContent = tt("icom.statusLine", { p0: online, p1: this.#status.parties.length, p2: this.#status.late_ticks, p3: (this.#status.max_tick_us / 1000).toFixed(1) });
    }
    this.#paintDots();
  }

  #paintDots() {
    const byId = new Map((this.#status?.parties ?? []).map((x) => [x.id, x]));
    for (const d of this.querySelectorAll<HTMLElement>("[data-party-dot]")) {
      const p = byId.get(Number(d.dataset.partyDot));
      d.style.background = p?.speaking ? "var(--omp-ok,#2da44e)" : p?.online ? "var(--omp-ok,#2da44e)" : "var(--omp-border)";
      d.style.boxShadow = p?.speaking ? "0 0 0 3px color-mix(in srgb,var(--omp-ok,#2da44e) 35%,transparent)" : "none";
    }
  }

  #channelsBox(): HTMLElement {
    const box = el("div", BOX);
    box.dataset.role = "channels";
    box.append(el("h3", H, tt("icom.channels")), el("div", DIM + "font-size:12px;margin-bottom:8px;", tt("icom.channelsHint")));
    if (this.#draft.channels.length === 0) box.append(el("div", DIM + "padding:6px 0;", tt("icom.noChannels")));
    for (const c of this.#draft.channels) {
      const row = el("div", "display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:8px;");
      row.dataset.channel = String(c.id);
      const color = el("input", "width:44px;height:28px;padding:0;");
      color.type = "color";
      color.value = c.color || "#4c8dff";
      color.addEventListener("input", () => {
        c.color = color.value;
        this.#touch();
      });
      const kind = el("select", "padding:3px 6px;");
      for (const k of ["party", "ifb"] as const) {
        const o = el("option", "", tt(`icom.channel.kind.${k}` as never));
        o.value = k;
        kind.append(o);
      }
      kind.value = c.kind ?? "party";
      kind.addEventListener("change", () => {
        c.kind = kind.value as "party" | "ifb";
        if (c.kind === "ifb" && !c.duck_db) c.duck_db = 20;
        this.#render();
      });
      row.append(field(tt("icom.channel.name"), textInput(c.name, (v) => { c.name = v; this.#touch(); }, "180px")), field(tt("icom.channel.color"), color), field(tt("icom.channel.kind"), kind));
      if (c.kind === "ifb") {
        const duck = el("input", "padding:3px 6px;width:70px;");
        duck.type = "number";
        duck.min = "0";
        duck.max = "60";
        duck.value = String(c.duck_db ?? 20);
        duck.addEventListener("input", () => {
          c.duck_db = Number(duck.value);
          this.#touch();
        });
        row.append(field(tt("icom.channel.duck"), duck));
      }
      row.append(btn("✕", async () => {
        if (!(await confirmDialog(tt("icom.channel.removeConfirm", { p0: c.name || `#${c.id}` })))) return;
        removeChannel(this.#draft, c.id);
        this.#render();
      }, tt("icom.channel.remove")));
      box.append(row);
    }
    box.append(btn(tt("icom.channel.add"), () => {
      addChannel(this.#draft, "");
      this.#render();
    }));
    return box;
  }

  /** Nur die Speichern-/Verwerfen-Knöpfe nachziehen, ohne die Felder neu zu bauen (Fokus bleibt). */
  #touch() {
    const [save, discard] = this.querySelectorAll<HTMLButtonElement>("[data-role=bar] > button");
    const d = this.#dirty();
    if (save) save.disabled = !d;
    if (discard) discard.disabled = !d;
  }

  #partiesBox(): HTMLElement {
    const box = el("div", BOX);
    box.dataset.role = "parties";
    box.append(el("div", DIM + "font-size:12px;margin-bottom:10px;", tt("icom.partiesHint")));
    const parties = this.#draft.parties;
    if (!parties.some((p) => p.id === this.#selParty)) this.#selParty = parties[0]?.id ?? 0;

    // Suche und Filter: mit hundert und mehr Teilnehmern findet man sonst nichts mehr.
    const bar = el("div", "display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:8px;");
    const q = textInput(this.#pText, (v) => { this.#pText = v; fillList(); }, "200px", tt("icom.m.filterPartyPh"));
    const kindFilter = el("select", "padding:3px 6px;");
    for (const [v, text] of [["all", tt("icom.m.allKinds")], ...(["human", "seat", "program", "port"] as const).map((k) => [k, tt(`icom.party.kind.${k}` as never)] as [string, string])]) {
      const o = el("option", "", text);
      o.value = v;
      kindFilter.append(o);
    }
    kindFilter.value = this.#pKind;
    kindFilter.addEventListener("change", () => { this.#pKind = kindFilter.value as PartyKind | "all"; fillList(); });
    const count = el("span", "font-size:12px;" + DIM);
    bar.append(field(tt("icom.m.filterParty"), q), field(tt("icom.party.kind"), kindFilter), count);
    box.append(bar);

    const cols = el("div", "display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;");
    const left = el("div", "display:flex;flex-direction:column;gap:6px;min-width:220px;flex:0 0 260px;");
    const list = el("div", "display:flex;flex-direction:column;gap:2px;max-height:min(60vh,640px);overflow:auto;");
    list.dataset.role = "party-list";
    const fillList = () => {
      const shown = filterParties(parties, { text: this.#pText, kind: this.#pKind });
      count.textContent = tt("icom.m.listCount", { p0: shown.length, p1: parties.length });
      list.replaceChildren();
      for (const p of shown) {
        const on = p.id === this.#selParty;
        const row = el("button", `display:flex;gap:8px;align-items:center;text-align:left;padding:5px 10px;border-radius:6px;border:1px solid ${on ? "var(--omp-accent-cyan,#19d3f3)" : "transparent"};background:${on ? "color-mix(in srgb,var(--omp-accent-cyan,#19d3f3) 14%,transparent)" : "none"};cursor:pointer;flex:none;`);
        const dot = el("span", "width:9px;height:9px;border-radius:50%;background:var(--omp-border);flex:none;");
        dot.dataset.partyDot = String(p.id);
        row.append(dot, el("span", "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", p.name || `#${p.id}`), el("span", "font-size:11px;" + DIM, tt(`icom.party.kind.${p.kind ?? "human"}` as never)));
        row.dataset.pick = String(p.id);
        row.addEventListener("click", () => {
          this.#selParty = p.id;
          this.#render();
        });
        list.append(row);
      }
      this.#paintDots();
    };
    fillList();
    left.append(list);
    left.append(btn(tt("icom.party.add"), () => {
      this.#selParty = addParty(this.#draft, "").id;
      this.#pText = "";
      this.#render();
    }));

    // Sammelanlage: „Kamera 1 … Kamera 40“ in einem Zug, optional mit den Zuordnungen eines Musters.
    const det = el("details", "margin-top:6px;");
    det.append(el("summary", "cursor:pointer;" + DIM, tt("icom.m.bulkAdd")));
    const form = el("div", "display:flex;flex-direction:column;gap:6px;margin-top:6px;");
    const cnt = el("input", "padding:3px 6px;width:80px;");
    cnt.type = "number";
    cnt.min = "1";
    cnt.max = String(MAX_BULK_ADD);
    cnt.value = String(this.#bulkCount);
    cnt.addEventListener("input", () => (this.#bulkCount = Number(cnt.value)));
    const kindSel = el("select", "padding:3px 6px;");
    for (const k of ["human", "seat", "program", "port"] as PartyKind[]) {
      const o = el("option", "", tt(`icom.party.kind.${k}` as never));
      o.value = k;
      kindSel.append(o);
    }
    kindSel.value = this.#bulkKind;
    kindSel.addEventListener("change", () => (this.#bulkKind = kindSel.value as PartyKind));
    const like = el("select", "padding:3px 6px;max-width:200px;");
    const none = el("option", "", tt("icom.m.bulkLikeNone"));
    none.value = "0";
    like.append(none);
    for (const p of parties) {
      const o = el("option", "", p.name || `#${p.id}`);
      o.value = String(p.id);
      like.append(o);
    }
    like.value = String(this.#bulkLike);
    like.addEventListener("change", () => (this.#bulkLike = Number(like.value)));
    form.append(
      field(tt("icom.m.bulkPrefix"), textInput(this.#bulkPrefix, (v) => (this.#bulkPrefix = v), "180px", tt("icom.m.bulkPrefixPh"))),
      el("div", "display:flex;gap:8px;"), field(tt("icom.m.bulkLike"), like),
    );
    (form.children[1] as HTMLElement).append(field(tt("icom.m.bulkCount"), cnt), field(tt("icom.party.kind"), kindSel));
    form.append(btn(tt("icom.m.bulkCreate"), () => {
      if (!this.#bulkPrefix.trim()) {
        showToast(tt("icom.m.bulkNeedPrefix"));
        return;
      }
      const made = addParties(this.#draft, this.#bulkPrefix, this.#bulkCount, this.#bulkKind, parties.find((p) => p.id === this.#bulkLike));
      if (made.length) this.#selParty = made[0].id;
      this.#pText = "";
      showToast(tt("icom.m.bulkCreated", { p0: made.length }));
      this.#render();
    }));
    det.append(form);
    left.append(det);
    cols.append(left);
    const sel = parties.find((p) => p.id === this.#selParty);
    const detail = el("div", "flex:1 1 380px;min-width:300px;");
    if (sel) detail.append(this.#partyCard(sel));
    else detail.append(el("div", DIM + "padding:6px 0;", tt("icom.noParties")));
    cols.append(detail);
    box.append(cols);
    return box;
  }

  #partyCard(p: Party): HTMLElement {
    const card = el("div", "border:1px solid var(--omp-border);border-radius:8px;padding:12px 14px;");
    card.dataset.party = String(p.id);
    const head = el("div", "display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;");
    const dot = el("span", "width:10px;height:10px;border-radius:50%;background:var(--omp-border);align-self:center;");
    dot.dataset.partyDot = String(p.id);
    const kind = el("select", "padding:3px 6px;");
    for (const k of ["human", "seat", "program", "port"] as PartyKind[]) {
      const o = el("option", "", tt(`icom.party.kind.${k}` as never));
      o.value = k;
      kind.append(o);
    }
    kind.value = p.kind ?? "human";
    kind.addEventListener("change", () => {
      p.kind = kind.value as PartyKind;
      this.#render();
    });
    const prio = el("input", "padding:3px 6px;width:60px;");
    prio.type = "number";
    prio.min = "0";
    prio.max = "9";
    prio.value = String(p.priority ?? 0);
    prio.addEventListener("input", () => {
      p.priority = Number(prio.value);
      this.#touch();
    });
    head.append(dot, field(tt("icom.party.name"), textInput(p.name, (v) => { p.name = v; this.#touch(); }, "180px")), field(tt("icom.party.kind"), kind), field(tt("icom.party.priority"), prio));
    head.append(btn(tt("icom.m.duplicate"), () => {
      const d = duplicateParty(this.#draft, p.id);
      if (d) this.#selParty = d.id;
      this.#render();
    }, tt("icom.m.duplicateHint")), btn("✕", async () => {
      if (!(await confirmDialog(tt("icom.party.removeConfirm", { p0: p.name || `#${p.id}` })))) return;
      removeParty(this.#draft, p.id);
      this.#render();
    }, tt("icom.party.remove")));
    card.append(head);
    const sec = (key: string): HTMLElement => el("div", "font-size:11px;letter-spacing:.06em;text-transform:uppercase;margin:14px 0 4px;" + DIM, tt(key as never));
    const human = (p.kind ?? "human") === "human" || p.kind === "seat";
    if (p.kind === "program" || p.kind === "port") {
      const slot = (label: string, value: number | undefined, set: (n: number) => void): HTMLElement => {
        const i = el("input", "padding:3px 6px;width:70px;");
        i.type = "number";
        i.min = "0";
        i.max = "16";
        i.value = String(value ?? 0);
        i.addEventListener("input", () => {
          set(Number(i.value));
          this.#touch();
        });
        return field(label, i);
      };
      const ports = el("div", "display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;align-items:flex-end;");
      ports.append(
        slot(tt("icom.party.mxlIn"), p.mxl_in, (n) => (p.mxl_in = n)),
        slot(tt("icom.party.mxlOut"), p.mxl_out, (n) => (p.mxl_out = n)),
        el("span", DIM + "font-size:12px;", tt("icom.party.mxlHint")),
      );
      card.append(sec("icom.party.section.link"), ports);
    }
    if (human) {
      const who = el("div", "display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;align-items:flex-end;");
      who.append(field(tt("icom.party.users"), textInput((p.users ?? []).join(", "), (v) => { p.users = splitList(v); this.#touch(); }, "260px")));
      if (this.#groups.length) {
        const g = el("select", "padding:3px 6px;min-width:160px;");
        g.multiple = true;
        g.size = Math.min(4, this.#groups.length);
        for (const x of this.#groups) {
          const o = el("option", "", x.name);
          o.value = x.id;
          o.selected = (p.groups ?? []).includes(x.id);
          g.append(o);
        }
        g.addEventListener("change", () => {
          p.groups = [...g.selectedOptions].map((o) => o.value);
          this.#touch();
        });
        who.append(field(tt("icom.party.groups"), g));
      }
      who.append(btn(tt("icom.party.rotate"), async () => {
        if (!(await confirmDialog(tt("icom.party.rotateConfirm", { p0: p.name })))) return;
        const r = await apiFetch(`/api/v1/ext/intercom/parties/${p.id}/rotate-token`, { method: "POST" });
        showToast(r.ok ? tt("icom.party.rotated") : tt("icom.saveFailed", { p0: r.status }));
      }));
      card.append(sec("icom.party.section.access"), who);
    }

    const flags = el("div", "display:flex;gap:16px;flex-wrap:wrap;margin-top:8px;");
    flags.append(check(tt("icom.party.force"), !!p.force, (v) => { p.force = v; this.#touch(); }), check(tt("icom.party.onairLock"), !!p.onair_lock, (v) => { p.onair_lock = v; this.#touch(); }));
    if (human) flags.append(check(tt("icom.party.open"), !!p.open, (v) => { p.open = v; this.#touch(); }));
    card.append(sec("icom.party.section.rights"), flags);

    const routes = this.#draft.channels.filter((c) => getRoute(p, c.id)?.talk || getRoute(p, c.id)?.listen);
    const sum = el("div", "display:flex;gap:8px;align-items:center;flex-wrap:wrap;");
    sum.dataset.role = "summary";
    sum.append(el("span", routes.length ? "" : DIM, routes.length
      ? tt("icom.party.summary", { p0: routes.map((c) => `${c.name || `#${c.id}`} ${getRoute(p, c.id)?.talk ? "🎤" : ""}${getRoute(p, c.id)?.listen ? "🎧" : ""}`).join(" · ") })
      : tt("icom.party.summaryNone")), btn(tt("icom.party.toAssign"), () => this.#goto("assign")));
    card.append(sec("icom.matrix"), sum);

    if (human) {
      const det = el("details", "margin-top:14px;");
      det.open = p.layout !== undefined || p.template !== undefined;
      det.append(el("summary", "cursor:pointer;" + DIM, tt("icom.layout.advanced")), this.#layoutSection(p));
      card.append(det);
    }
    return card;
  }

  #layoutSection(p: Party): HTMLElement {
    const box = el("div", "margin-top:10px;");
    box.dataset.role = "layout";
    box.append(el("div", "font-size:11px;letter-spacing:.05em;text-transform:uppercase;" + DIM, tt("icom.layout")), el("div", "font-size:12px;" + DIM, tt("icom.layout.hint")));
    const row = el("div", "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px;");
    const mode = layoutMode(p);
    const sel = el("select", "padding:3px 6px;");
    for (const m of ["default", "template", "own"] as const) {
      const o = el("option", "", tt(`icom.layout.mode.${m}` as never));
      o.value = m;
      if (m === "template" && !(this.#draft.templates ?? []).length) {
        o.disabled = true;
        o.textContent += ` (${tt("icom.layout.noTemplates")})`;
      }
      sel.append(o);
    }
    sel.value = mode;
    sel.addEventListener("change", () => {
      const m = sel.value as "default" | "template" | "own";
      if (m === "default") {
        delete p.layout;
        delete p.template;
      } else if (m === "template") {
        delete p.layout;
        p.template = (this.#draft.templates ?? [])[0]?.id;
      } else {
        delete p.template;
        p.layout ??= layoutFromAssignment(p, this.#draft);
      }
      this.#render();
    });
    row.append(sel);
    if (mode === "template") {
      const ts = el("select", "padding:3px 6px;");
      for (const t of this.#draft.templates ?? []) {
        const o = el("option", "", t.name || `#${t.id}`);
        o.value = String(t.id);
        ts.append(o);
      }
      ts.value = String(p.template);
      ts.addEventListener("change", () => {
        p.template = Number(ts.value);
        this.#touch();
      });
      row.append(ts);
    }
    if (mode === "own") {
      row.append(btn(tt("icom.layout.fromAssignment"), async () => {
        if (!(await confirmDialog(tt("icom.layout.fromAssignmentConfirm", { p0: p.name })))) return;
        p.layout = layoutFromAssignment(p, this.#draft);
        this.#render();
      }));
    }
    box.append(row);
    if (mode === "own" && p.layout) box.append(layoutEditor(p.layout, this.#draft, () => this.#touch(), () => this.#render()));
    return box;
  }

  #templatesBox(): HTMLElement {
    const box = el("div", BOX);
    box.dataset.role = "templates";
    box.append(el("h3", H, tt("icom.templates")), el("div", DIM + "font-size:12px;margin-bottom:8px;", tt("icom.templatesHint")));
    const list = this.#draft.templates ?? [];
    if (list.length === 0) box.append(el("div", DIM + "padding:6px 0;", tt("icom.noTemplates")));
    for (const t of list) {
      const card = el("div", "border:1px solid var(--omp-border);border-radius:6px;padding:10px;margin-bottom:10px;");
      card.dataset.template = String(t.id);
      const head = el("div", "display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;");
      const users = this.#draft.parties.filter((p) => p.template === t.id && !p.layout).map((p) => p.name || `#${p.id}`);
      head.append(field(tt("icom.template.name"), textInput(t.name, (v) => { t.name = v; this.#touch(); }, "200px")));
      if (users.length) head.append(el("span", DIM + "font-size:12px;", tt("icom.template.usedBy", { p0: users.join(", ") })));
      head.append(btn("✕", async () => {
        if (!(await confirmDialog(tt("icom.template.removeConfirm", { p0: t.name || `#${t.id}` })))) return;
        removeTemplate(this.#draft, t.id);
        this.#render();
      }, tt("icom.template.remove")));
      card.append(head, layoutEditor(t.layout, this.#draft, () => this.#touch(), () => this.#render()));
      box.append(card);
    }
    box.append(btn(tt("icom.template.add"), () => {
      addTemplate(this.#draft, "");
      this.#render();
    }));
    return box;
  }

  #guestsBox(): HTMLElement {
    const box = el("div", BOX);
    box.dataset.role = "guests";
    box.append(el("h3", H, tt("icom.guests")), el("div", DIM + "font-size:12px;margin-bottom:8px;", tt("icom.guestsHint")));
    if (this.#guests.length === 0) box.append(el("div", DIM + "padding:6px 0;", tt("icom.guest.none")));
    const fmt = new Intl.DateTimeFormat(dateLocale(), { dateStyle: "short", timeStyle: "short" });
    for (const g of this.#guests) {
      const row = el("div", "display:flex;gap:10px;align-items:center;margin-bottom:6px;flex-wrap:wrap;");
      row.dataset.guest = String(g.id);
      row.append(el("strong", "", g.name), el("span", DIM + "font-size:12px;", tt("icom.guest.until", { p0: fmt.format(new Date(g.expires)) })));
      row.append(btn(tt("icom.guest.copy"), async () => {
        try {
          await navigator.clipboard.writeText(g.url ?? "");
          showToast(tt("icom.guest.copied"));
        } catch {
          showToast(tt("icom.guest.copyFailed", { p0: g.url ?? "" }));
        }
      }), btn(tt("icom.guest.delete"), async () => {
        await apiFetch(`/api/v1/ext/intercom/guests/${g.id}`, { method: "DELETE" });
        await this.#load();
      }));
      box.append(row);
    }
    const form = el("div", "display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-top:10px;border-top:1px solid var(--omp-border);padding-top:10px;");
    const ttl = el("input", "padding:3px 6px;width:90px;");
    ttl.type = "number";
    ttl.min = "1";
    ttl.value = String(this.#guestTtl);
    ttl.addEventListener("input", () => (this.#guestTtl = Number(ttl.value)));
    form.append(field(tt("icom.guest.name"), textInput(this.#guestName, (v) => (this.#guestName = v), "180px")), field(tt("icom.guest.ttl"), ttl));
    const chans = el("div", "display:flex;gap:12px;flex-wrap:wrap;align-self:center;");
    for (const c of this.#saved.channels) {
      chans.append(check(c.name, this.#guestSel.has(c.id), (v) => (v ? this.#guestSel.add(c.id) : this.#guestSel.delete(c.id))));
    }
    chans.append(check(tt("icom.talk"), this.#guestTalk, (v) => (this.#guestTalk = v)));
    form.append(chans, btn(tt("icom.guest.create"), async () => {
      if (this.#guestSel.size === 0) {
        showToast(tt("icom.guest.pickChannel"));
        return;
      }
      const res = await apiFetch("/api/v1/ext/intercom/guests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: this.#guestName, ttl_minutes: this.#guestTtl, routes: guestRoutes(this.#guestSel, this.#guestTalk) }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        showToast(tt("icom.guest.createFailed", { p0: body.error ?? res.status }));
        return;
      }
      this.#guestName = "";
      await this.#load();
    }));
    box.append(form);
    return box;
  }
}

if (!customElements.get("omp-intercom-admin")) customElements.define("omp-intercom-admin", IntercomAdmin);
