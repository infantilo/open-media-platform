// Administration → Produktion → Intercom (Kapitel 47): Kanäle, Teilnehmer (mit Kanal-Matrix), Gäste und Betriebsstatus.
// Explizites Speichern (Entwurf lokal, ein PUT); Gäste und Zugangslinks laufen über eigene Endpunkte und wirken sofort.

import { apiFetch, confirmDialog, dateLocale, directory, showToast, t as tt } from "../host.ts";
import { layoutEditor } from "./intercom-layout-editor.ts";
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

    const bar = el("div", "display:flex;gap:8px;align-items:center;margin-bottom:12px;");
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
    this.append(bar);

    const st = el("div", BOX);
    st.dataset.role = "status";
    st.append(el("h3", H, tt("icom.status")), el("div", "", ""));
    this.append(st);

    this.append(this.#channelsBox(), this.#partiesBox(), this.#templatesBox(), this.#guestsBox());
    this.#renderStatus();
  }

  #renderStatus() {
    const box = this.querySelector<HTMLElement>("[data-role=status]");
    if (!box) return;
    const line = box.lastElementChild as HTMLElement;
    if (!this.#status) {
      line.textContent = this.#statusError || "…";
      line.style.cssText = "color:var(--omp-error);";
    } else {
      const online = this.#status.parties.filter((p) => p.online).length;
      line.style.cssText = "";
      line.textContent = tt("icom.statusLine", { p0: online, p1: this.#status.parties.length, p2: this.#status.late_ticks, p3: (this.#status.max_tick_us / 1000).toFixed(1) });
    }
    for (const d of this.querySelectorAll<HTMLElement>("[data-party-dot]")) {
      const p = this.#status?.parties.find((x) => x.id === Number(d.dataset.partyDot));
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
    const [save, discard] = this.querySelectorAll<HTMLButtonElement>(":scope > div:first-child > button");
    const d = this.#dirty();
    if (save) save.disabled = !d;
    if (discard) discard.disabled = !d;
  }

  #partiesBox(): HTMLElement {
    const box = el("div", BOX);
    box.dataset.role = "parties";
    box.append(el("h3", H, tt("icom.parties")), el("div", DIM + "font-size:12px;margin-bottom:8px;", tt("icom.partiesHint")));
    if (this.#draft.parties.length === 0) box.append(el("div", DIM + "padding:6px 0;", tt("icom.noParties")));
    for (const p of this.#draft.parties) box.append(this.#partyCard(p));
    box.append(btn(tt("icom.party.add"), () => {
      addParty(this.#draft, "");
      this.#render();
    }));
    return box;
  }

  #partyCard(p: Party): HTMLElement {
    const card = el("div", "border:1px solid var(--omp-border);border-radius:6px;padding:10px;margin-bottom:10px;");
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
    head.append(btn("✕", async () => {
      if (!(await confirmDialog(tt("icom.party.removeConfirm", { p0: p.name || `#${p.id}` })))) return;
      removeParty(this.#draft, p.id);
      this.#render();
    }, tt("icom.party.remove")));
    card.append(head);

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
      card.append(ports);
    }
    const flags = el("div", "display:flex;gap:16px;flex-wrap:wrap;margin-top:8px;");
    flags.append(check(tt("icom.party.force"), !!p.force, (v) => { p.force = v; this.#touch(); }), check(tt("icom.party.onairLock"), !!p.onair_lock, (v) => { p.onair_lock = v; this.#touch(); }));
    if (human) flags.append(check(tt("icom.party.open"), !!p.open, (v) => { p.open = v; this.#touch(); }));
    card.append(flags);

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
      card.append(who);
    }

    if (human) card.append(this.#layoutSection(p));

    const m = el("div", "margin-top:10px;");
    m.append(el("div", "font-size:11px;letter-spacing:.05em;text-transform:uppercase;" + DIM, tt("icom.matrix")));
    const grid = el("div", "display:grid;grid-template-columns:minmax(120px,1fr) auto auto;gap:4px 16px;align-items:center;margin-top:4px;max-width:420px;");
    grid.append(el("span"), el("span", "font-size:11px;" + DIM, tt("icom.talk")), el("span", "font-size:11px;" + DIM, tt("icom.listen")));
    for (const c of this.#draft.channels) {
      const r = getRoute(p, c.id);
      grid.append(el("span", "", c.name || `#${c.id}`));
      for (const f of ["talk", "listen"] as const) {
        const cb = el("input");
        cb.type = "checkbox";
        cb.checked = !!r?.[f];
        cb.addEventListener("change", () => {
          setRoute(p, c.id, f, cb.checked);
          this.#touch();
        });
        grid.append(cb);
      }
    }
    m.append(grid);
    card.append(m);
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
