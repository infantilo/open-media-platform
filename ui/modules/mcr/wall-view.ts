// Multiview-Wand (106.13f): alle laufenden und nächsten Events dynamisch. Events mit Fehlern/Alarmen erscheinen automatisch und
// zuerst, mit Bild; ein Klick auf eine Leitung routet sie zum Abhören oder auf das Messgerät. Aktualisiert Kacheln in ihren Werten
// (kein Neuaufbau), der Takt läuft nur, solange die Wand sichtbar ist.
import { apiFetch, showToast, t } from "../host.ts";
import { h, modal } from "./mcr-dom.ts";
import { hotspot, LEVEL_COLOR, MAX_PICTURES, newNotices, pictureIds, type WallEvent, type WallLine } from "./wall-logic.ts";

const TOKEN_KEY = "omp-auth-token";
const POLL_MS = 3000;
const PICTURE_MS = 1000;

type Obj = Record<string, any>;

function previewSrc(nodeId: string): string {
  let token: string | null = null;
  try {
    token = localStorage.getItem(TOKEN_KEY);
  } catch { /* ohne Speicher */ }
  const base = `/api/v1/nodes/${nodeId}/stream/previewUrl`;
  return `${base}?${token ? `access_token=${encodeURIComponent(token)}&` : ""}_=${Date.now()}`;
}

interface Tile {
  root: HTMLElement;
  lamp: HTMLElement;
  sub: HTMLElement;
  pic: HTMLElement;
  img: HTMLImageElement;
  chips: HTMLElement;
  pin: HTMLButtonElement;
  pipbar: HTMLElement;
}

export class Wall {
  readonly el = h("div", { class: "mcr-wall" });
  #grid = h("div", { class: "mcr-wall-grid" });
  #head = h("div", { class: "mcr-wall-head" });
  #tiles = new Map<string, Tile>();
  #events: WallEvent[] = [];
  #pinned = new Set<string>();
  #seenNotices = new Set<string>();
  #firstPoll = true;
  #timer = 0;
  #pic = 0;
  #canRoute: boolean;
  #openEvent: (id: string) => void;

  constructor(canRoute: boolean, openEvent: (id: string) => void) {
    this.#canRoute = canRoute;
    this.#openEvent = openEvent;
    this.el.append(this.#head, this.#grid);
  }

  start() {
    this.stop();
    void this.#poll();
    this.#timer = setInterval(() => void this.#poll(), POLL_MS) as unknown as number;
    this.#pic = setInterval(() => this.#refreshPictures(), PICTURE_MS) as unknown as number;
  }

  stop() {
    clearInterval(this.#timer);
    clearInterval(this.#pic);
  }

  async #poll() {
    // Bilder nur anfordern, wenn sie zu sehen sind: jede Anforderung hält einen Multiviewer am Laufen.
    const want = document.hidden || !this.el.getClientRects().length ? [] : pictureIds(this.#events, this.#pinned);
    try {
      const res = await apiFetch(`/api/v1/mcr/monitor${want.length ? `?watch=${want.join(",")}` : ""}`);
      if (!res.ok) return;
      this.#events = ((await res.json()) as { events: WallEvent[] }).events ?? [];
    } catch {
      return;
    }
    // Hinweise (Reaktion „notice“): beim ersten Abruf nur merken, danach jeden neuen Alarm einmal melden
    for (const { event, alarm } of newNotices(this.#events, this.#seenNotices)) {
      this.#seenNotices.add(alarm.id);
      if (!this.#firstPoll) showToast(t("mcr.wall.noticeTitle", { event: event.name, line: alarm.lineName, kind: alarm.kind.replace(/^signal-/, "") }));
    }
    this.#firstPoll = false;
    this.#render();
  }

  #render() {
    const pics = new Set(pictureIds(this.#events, this.#pinned));
    const alarms = this.#events.filter((e) => e.level === "bad" || e.level === "warn").length;
    this.#head.textContent = this.#events.length ? t("mcr.wall.summary", { n: this.#events.length, a: alarms }) : "";
    const seen = new Set<string>();
    let prev: Element | null = null as Element | null;
    for (const e of this.#events) {
      seen.add(e.id);
      let tile = this.#tiles.get(e.id);
      if (!tile) {
        tile = this.#build(e);
        this.#tiles.set(e.id, tile);
      }
      this.#update(tile, e, pics.has(e.id));
      // Reihenfolge nachführen, nur wenn sie abweicht (kein Flackern)
      const at: Element | null = prev ? (prev as Element).nextElementSibling : this.#grid.firstElementChild;
      if (at !== tile.root) this.#grid.insertBefore(tile.root, at);
      prev = tile.root;
    }
    for (const [id, tile] of this.#tiles) {
      if (!seen.has(id)) {
        tile.root.remove();
        this.#tiles.delete(id);
      }
    }
    if (!this.#events.length && !this.#grid.querySelector(".mcr-empty")) this.#grid.replaceChildren(h("div", { class: "mcr-empty" }, h("h3", {}, t("mcr.wall.none")), h("p", {}, t("mcr.wall.noneHint"))));
    else if (this.#events.length) this.#grid.querySelector(".mcr-empty")?.remove();
  }

  #build(e: WallEvent): Tile {
    const lamp = h("span", { class: "mcr-wall-lamp" });
    const sub = h("div", { class: "mcr-wall-sub" });
    const pin = h("button", { type: "button", class: "mcr-btn mcr-btn-sm mcr-btn-quiet", title: t("mcr.wall.pin") }, "▣") as HTMLButtonElement;
    pin.addEventListener("click", () => {
      if (this.#pinned.has(e.id)) this.#pinned.delete(e.id);
      else this.#pinned.add(e.id);
      void this.#poll();
    });
    const open = h("button", { type: "button", class: "mcr-btn mcr-btn-sm mcr-btn-quiet", title: t("mcr.wall.open") }, "↗");
    open.addEventListener("click", () => this.#openEvent(e.id));
    const img = h("img", { alt: "", class: "mcr-wall-img" }) as HTMLImageElement;
    const pic = h("div", { class: "mcr-wall-pic" }, img);
    const chips = h("div", { class: "mcr-wall-chips" });
    const pipbar = h("div", { class: "mcr-wall-pipbar" });
    const root = h("article", { class: "mcr-wall-tile", "data-id": e.id }, h("header", {}, lamp, h("b", {}, e.name), sub, h("span", { class: "mcr-wall-spacer" }), pin, open), pic, pipbar, chips);
    return { root, lamp, sub, pic, img, chips, pin, pipbar };
  }

  #update(tile: Tile, e: WallEvent, big: boolean) {
    tile.root.style.setProperty("--lv", LEVEL_COLOR[e.level] ?? LEVEL_COLOR[""]);
    tile.root.dataset.level = e.level || "none";
    tile.root.classList.toggle("big", big);
    tile.sub.textContent = [t(`mcr.state.${e.state}`), e.alarmCount ? t("mcr.wall.alarms", { n: e.alarmCount }) : ""].filter(Boolean).join(" · ");
    tile.pin.style.display = e.state === "planned" ? "none" : "";
    tile.pin.setAttribute("aria-pressed", String(this.#pinned.has(e.id)));
    tile.pic.style.display = big ? "" : "none";
    tile.pic.style.aspectRatio = e.canvasW && e.canvasH ? `${e.canvasW} / ${e.canvasH}` : "16 / 9";
    tile.pic.dataset.node = big ? (e.previewNodeId ?? "") : "";
    if (!big) tile.img.removeAttribute("src");
    // Klickflächen über dem Bild
    tile.pic.querySelectorAll(".mcr-wall-hot").forEach((n) => n.remove());
    if (big) {
      for (const l of e.lines) {
        const r = hotspot(l, e.canvasW, e.canvasH);
        if (!r) continue;
        const b = h("button", { type: "button", class: "mcr-wall-hot", "data-level": l.level || "none", title: `${l.name}${l.alarms.length ? " — " + l.alarms.join(", ") : ""}`, style: `left:${r.left}%;top:${r.top}%;width:${r.width}%;height:${r.height}%` });
        b.addEventListener("click", (ev) => this.#menu(e, l, b, ev));
        tile.pic.append(b);
      }
    }
    // Alarm-PiP: wer wird gezeigt, ist es festgehalten
    const shown = e.lines.find((l) => l.id === e.pipLine);
    tile.pipbar.style.display = e.hasPip ? "" : "none";
    if (e.hasPip) tile.pipbar.replaceChildren(h("span", {}, "◉"), h("span", {}, shown ? t("mcr.wall.pipShows", { name: shown.name }) : t("mcr.wall.pipShows", { name: "–" })), ...(e.pipLock ? [h("b", {}, t("mcr.wall.pipLocked"))] : []));
    // Leitungs-Chips (immer, kompakt)
    const sig = e.lines.map((l) => `${l.id}${l.level}${l.alarms.join()}${l.umd}${(l.alarmItems ?? []).map((a) => a.id + (a.ackedBy ?? "")).join()}`).join("|");
    if (tile.chips.dataset.sig !== sig) {
      tile.chips.dataset.sig = sig;
      tile.chips.replaceChildren(...e.lines.map((l) => this.#chip(e, l)));
    }
  }

  #chip(e: WallEvent, l: WallLine): HTMLElement {
    const c = h("button", { type: "button", class: "mcr-wall-chip", "data-level": l.level || "none", title: l.umd || l.name }, h("i", {}), h("span", {}, l.name), l.alarms.length ? h("em", {}, l.alarms.join(", ")) : null);
    c.addEventListener("click", (ev) => this.#menu(e, l, c, ev));
    return c;
  }

  #refreshPictures() {
    for (const tile of this.#tiles.values()) {
      const id = tile.pic.dataset.node;
      if (id && tile.root.classList.contains("big") && !document.hidden) {
        const next = new Image();
        next.onload = () => (tile.img.src = next.src);
        next.src = previewSrc(id);
      }
    }
  }

  #menu(e: WallEvent, l: WallLine, anchor: HTMLElement, ev: Event) {
    ev.stopPropagation();
    document.querySelectorAll(".mcr-menu").forEach((m) => m.remove());
    const r = anchor.getBoundingClientRect();
    const menu = h("div", { class: "mcr-menu", style: `position:fixed;z-index:2400;top:${Math.min(r.bottom + 4, innerHeight - 150)}px;left:${Math.max(8, Math.min(r.left, innerWidth - 220))}px;width:210px;background:var(--omp-surface-raised);border:1px solid var(--omp-border);border-radius:8px;padding:4px;box-shadow:0 10px 30px rgba(0,0,0,.5)` });
    const item = (label: string, fn: () => void, disabled = false) => {
      const b = h("button", { type: "button", style: "display:block;width:100%;text-align:left;background:none;border:0;padding:8px 10px;border-radius:5px;color:var(--omp-text);font:inherit;cursor:pointer" }, label) as HTMLButtonElement;
      b.disabled = disabled;
      if (disabled) b.style.opacity = ".45";
      b.addEventListener("click", () => {
        menu.remove();
        fn();
      });
      return b;
    };
    const live = e.state === "testing" || e.state === "live";
    const may = e.access ? e.access.test : this.#canRoute; // Rechte am Event, sonst die globalen
    menu.append(
      h("div", { class: "mcr-hint", style: "padding:6px 10px 4px" }, l.name),
      ...(l.alarmItems ?? []).map((a) => item(a.ackedBy ? t("mcr.wall.acked", { by: a.ackedBy }) : `${t("mcr.wall.ack")}: ${a.kind.replace(/^signal-/, "")}`, () => void this.#ack(e, a.id), !!a.ackedBy || !may)),
      ...(e.hasPip ? [item(e.pipLock === l.id ? t("mcr.wall.pipUnlock") : t("mcr.wall.pipLock"), () => void this.#lock(e, e.pipLock === l.id ? "" : l.id), !may || !live)] : []),
      item(t("mcr.wall.listen"), () => void this.#route(e, l, "listen"), !may || !live),
      item(t("mcr.wall.meter"), () => void this.#route(e, l, "meter"), !may || !live),
      item(t("mcr.wall.openEvent"), () => this.#openEvent(e.id)),
    );
    document.body.append(menu);
    const off = (x: MouseEvent) => {
      if (!menu.contains(x.target as Node)) {
        menu.remove();
        document.removeEventListener("mousedown", off, true);
      }
    };
    setTimeout(() => document.addEventListener("mousedown", off, true), 0);
  }

  async #ack(e: WallEvent, alarmId: string) {
    try {
      const res = await apiFetch(`/api/v1/mcr/events/${e.id}/alarms/${alarmId}/ack`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!res.ok) showToast(String(((await res.json().catch(() => ({}))) as Obj).error ?? t("mcr.err.generic")));
    } catch (x) {
      showToast(String(x));
    }
    void this.#poll();
  }

  async #lock(e: WallEvent, lineId: string) {
    try {
      const res = await apiFetch(`/api/v1/mcr/events/${e.id}/alarm-pip`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lock: lineId }) });
      if (!res.ok) showToast(String(((await res.json().catch(() => ({}))) as Obj).error ?? t("mcr.err.generic")));
    } catch (x) {
      showToast(String(x));
    }
    void this.#poll();
  }

  async #route(e: WallEvent, l: WallLine, action: "listen" | "meter") {
    showToast(t("mcr.wall.routing"));
    let data: Obj = {};
    let ok = false;
    try {
      const res = await apiFetch(`/api/v1/mcr/events/${e.id}/lines/${l.id}/monitor`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      ok = res.ok;
      data = await res.json().catch(() => ({}));
    } catch (x) {
      data = { error: String(x) };
    }
    if (!ok) return showToast(String(data.error ?? t("mcr.err.generic")));
    if (action === "listen") return showToast(t("mcr.wall.listening", { name: l.name }));
    showToast(t("mcr.wall.metering", { name: l.name }));
    void this.#meterDialog(l, String(data.nodeId ?? ""));
  }

  /** Das Messgerät (Scope im Vollmodus) zeigt Waveform und Vektorskop als Vorschaubild; hier groß angezeigt, solange der Dialog offen ist. */
  async #meterDialog(l: WallLine, nodeId: string) {
    if (!nodeId) return;
    const img = h("img", { alt: "", style: "width:100%;background:#000;border-radius:8px;display:block;min-height:240px" }) as HTMLImageElement;
    const tick = () => {
      const next = new Image();
      next.onload = () => (img.src = next.src);
      next.src = previewSrc(nodeId);
    };
    tick();
    const timer = setInterval(tick, 500);
    const body = h("div", { class: "mcr-form" }, h("div", { class: "mcr-hint" }, t("mcr.wall.meterHint")), img);
    await modal(t("mcr.wall.meterTitle", { name: l.name }), body, { save: t("mcr.wall.close"), wide: true, onSave: () => true });
    clearInterval(timer);
  }
}

export { MAX_PICTURES };
