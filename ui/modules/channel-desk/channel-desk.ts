// <omp-channel-desk>: Mehrkanal-Platz für Operatoren, die mehrere Playout-Channels betreuen (Kapitel 96).
//
// - Übersicht: je Channel eine Kachel mit Sendestand, Restzeit, Zeitleiste und Kennzahlen, live (1 s).
// - Gruppen-Start („Gang Roll“): Channels ankreuzen, eine Aktion (Next/Take/Next Live/Hold/Auto) wirkt auf alle.
// - Bearbeiten: Klick auf einen Channel öffnet dessen vollständige Playlist-Oberfläche; die Wechselleiste oben
//   (mit Live-Ampel und Restzeit je Channel, Alt+←/→) schaltet ohne Umweg zwischen den Channels um.
// Alles dynamisch: Die Channel-Liste folgt `setEntries` (Rollen kommen/gehen); ein Node gilt als Playout-Channel,
// wenn er die Parameter der Playout-Automation liefert — kein fest verdrahteter Typ.
import { apiFetch } from "../../shell/connection.ts";
import { confirmDialog } from "../../kit/omp-confirm.ts";
import { showToast } from "../../kit/omp-toast.ts";
import { t, type I18nKey } from "../../shell/i18n.ts";
import { mountUIBundleEl } from "../../shell/ui-bundle.ts";
import type { ConsoleEntry } from "../../shell/console-view.ts";
import type { DeckInput } from "./deck-logic.ts";
import {
  attentionList, axisTicks, buildBlocks, childRows, nextByKind, planWarnings, TIMELINE_PAST_SHARE, upcomingList, urgencyOf,
  type AttentionItem, type Upcoming, fmtRemain, gangCall, nodeIdFromBundleUrl, nowOffsetPct, playlistNow, pruneSelection, stepChannel,
  summarize, summarizeGang, waitKindOf,
  type ChannelSummary, type ChannelValues, type GangAction, type GangResult, type TimelineEntry,
} from "./multichannel-logic.ts";

const PARAMS = [
  "items", "schedule", "childEvents", "currentItemId", "cuedItemId", "mode", "connected", "playheadPositionMs", "currentDurationMs", "channelName", "operatorWait",
];
const ACTIONS: GangAction[] = ["next", "take", "nextLive", "hold", "auto"];
const WINDOWS_MIN = [10, 30, 60];
const POLL_MS = 1000;
const TL_EVERY = 5; // Zeitleiste alle 5 s (oder sofort bei Änderung der Sendeposition)

interface Channel {
  key: string; // nodeRoleId
  entry: ConsoleEntry;
  nodeId: string;
  values: ChannelValues | null;
  tl: TimelineEntry[];
  tlKey: string;
  summary: ChannelSummary;
  upcoming: Upcoming[];
  card: HTMLElement;
  switchBtn: HTMLButtonElement;
}

const STYLE = `
omp-channel-desk{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:var(--omp-bg);color:var(--omp-text);font-family:var(--omp-font)}
omp-channel-desk .cd-bar{display:flex;gap:6px;align-items:center;padding:6px;border-bottom:1px solid var(--omp-border);flex-shrink:0;overflow-x:auto}
omp-channel-desk .cd-tab{display:flex;gap:8px;align-items:center;border:1px solid transparent;border-radius:var(--omp-radius);padding:6px 12px;background:transparent;color:var(--omp-text-dim);font:inherit;font-size:var(--omp-font-size-sm);cursor:pointer;white-space:nowrap}
omp-channel-desk .cd-tab.active{background:var(--omp-surface-raised);color:var(--omp-text);border-color:var(--omp-border)}
omp-channel-desk .cd-tab .rem{font-variant-numeric:tabular-nums;opacity:.8;min-width:3.4em;text-align:right}
omp-channel-desk .cd-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;background:var(--omp-text-dim)}
omp-channel-desk .cd-dot.ok{background:var(--omp-success,#3ecf6e)}
omp-channel-desk .cd-dot.wait{background:var(--omp-warning,#f0b429)}
omp-channel-desk .cd-dot.warn{background:var(--omp-error,#ff5c5c)}
omp-channel-desk .cd-dot.offline{background:#666}
omp-channel-desk .cd-main{flex:1;min-height:0;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:12px}
omp-channel-desk .cd-edit{flex:1;min-height:0}
omp-channel-desk .cd-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
omp-channel-desk .cd-tools .grow{flex:1}
omp-channel-desk .cd-tools .sep{width:1px;align-self:stretch;background:var(--omp-border);margin:0 4px}
omp-channel-desk .cd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:12px;align-content:start}
omp-channel-desk .cd-card{display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid var(--omp-border);border-radius:var(--omp-radius);background:var(--omp-surface)}
omp-channel-desk .cd-card.sel{border-color:var(--omp-accent,#4aa3ff);box-shadow:0 0 0 1px var(--omp-accent,#4aa3ff) inset}
omp-channel-desk .cd-head{display:flex;gap:8px;align-items:center}
omp-channel-desk .cd-name{font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
omp-channel-desk .cd-badge{font-size:var(--omp-font-size-sm);padding:1px 8px;border-radius:10px;border:1px solid var(--omp-border);color:var(--omp-text-dim)}
omp-channel-desk .cd-badge.hold,omp-channel-desk .cd-badge.wait{color:var(--omp-warning,#f0b429);border-color:var(--omp-warning,#f0b429)}
omp-channel-desk .cd-now{display:flex;gap:10px;align-items:baseline}
omp-channel-desk .cd-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:1.05em}
omp-channel-desk .cd-clock{font-size:1.8em;font-variant-numeric:tabular-nums;font-weight:600;min-width:3.6em;text-align:right}
omp-channel-desk .cd-prog{height:6px;border-radius:3px;background:var(--omp-surface-raised);overflow:hidden}
omp-channel-desk .cd-prog>i{display:block;height:100%;background:var(--omp-accent,#4aa3ff)}
omp-channel-desk .cd-next{min-height:1.3em;color:var(--omp-text-dim);font-size:var(--omp-font-size-sm);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
omp-channel-desk .cd-tl{position:relative;border-radius:3px;background:var(--omp-surface-raised);overflow:hidden}
omp-channel-desk .lane{position:relative;height:26px}
omp-channel-desk .krow{position:relative;height:16px;margin-top:2px}
omp-channel-desk .kid{position:absolute;top:0;bottom:0;border-radius:2px;background:linear-gradient(#7c52b0,#5a3585);color:#f2e8ff;font-size:10px;line-height:14px;padding:0 4px;box-sizing:border-box;overflow:hidden;white-space:nowrap;border:1px solid #000}
omp-channel-desk .kid.Fired,omp-channel-desk .kid.Active{background:linear-gradient(#35b862,#1c8a48);color:#02150a}
omp-channel-desk .kid.Failed{background:linear-gradient(#e05050,#a02020);color:#fff}
omp-channel-desk .kid.Completed,omp-channel-desk .kid.Cancelled{opacity:.5}
omp-channel-desk .cd-cnt{display:flex;gap:6px;flex-wrap:wrap}
omp-channel-desk .cd-cnt span{font-size:var(--omp-font-size-sm);padding:1px 8px;border-radius:10px;border:1px solid var(--omp-border);font-variant-numeric:tabular-nums;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
omp-channel-desk .cd-cnt span.empty{opacity:.45}
omp-channel-desk .u-soon{color:var(--omp-warning,#f0b429);border-color:var(--omp-warning,#f0b429)!important}
omp-channel-desk .u-now{color:#fff;background:#b3261e;border-color:#ff5c5c!important;font-weight:600}
omp-channel-desk .cd-attn{display:flex;gap:10px;flex-wrap:wrap;align-items:center;padding:8px 10px;border:1px solid var(--omp-border);border-radius:var(--omp-radius);background:var(--omp-surface)}
omp-channel-desk .cd-attn .ttl{font-weight:600;margin-right:4px}
omp-channel-desk .cd-attn .it{display:flex;gap:6px;align-items:center;padding:2px 10px;border-radius:12px;border:1px solid var(--omp-border);font-variant-numeric:tabular-nums}
omp-channel-desk .cd-attn .none{color:var(--omp-text-dim)}
omp-channel-desk .cd-bar .cd-attn-mini{margin-left:auto;display:flex;gap:6px;align-items:center;white-space:nowrap;padding:2px 10px;border-radius:12px;border:1px solid var(--omp-border);font-size:var(--omp-font-size-sm);font-variant-numeric:tabular-nums;cursor:pointer}
omp-channel-desk .cd-all .lanewrap{position:relative;flex:1;min-width:0}
omp-channel-desk .cd-all .lanewrap .lane{border-radius:3px;background:var(--omp-surface-raised);overflow:hidden}
omp-channel-desk .cd-all .lanewrap .nowline{z-index:2}
omp-channel-desk .cd-tl b{position:absolute;top:3px;bottom:3px;border-radius:2px;background:linear-gradient(#3a6f9a,#24506f);overflow:hidden;font-weight:400;font-size:11px;line-height:20px;padding:0 3px;box-sizing:border-box;white-space:nowrap;color:#fff;border:1px solid #000}
omp-channel-desk .cd-tl u{position:absolute;top:0;bottom:0;width:2px;background:#ff5c5c;text-decoration:none}
omp-channel-desk .cd-stats{display:flex;gap:14px;color:var(--omp-text-dim);font-size:var(--omp-font-size-sm);font-variant-numeric:tabular-nums}
omp-channel-desk .cd-all{display:flex;flex-direction:column;gap:3px;padding:10px;border:1px solid var(--omp-border);border-radius:var(--omp-radius);background:var(--omp-surface)}
omp-channel-desk .cd-all .row{display:flex;gap:8px;align-items:center}
omp-channel-desk .cd-all .lbl{width:130px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--omp-font-size-sm);display:flex;gap:6px;align-items:center}
omp-channel-desk .cd-all .lane b{position:absolute;top:3px;bottom:3px;border-radius:2px;background:linear-gradient(#3a6f9a,#24506f);overflow:hidden;font-weight:400;font-size:11px;line-height:20px;padding:0 3px;box-sizing:border-box;white-space:nowrap;color:#fff;border:1px solid #000;cursor:pointer}
omp-channel-desk .cd-all .axis{position:relative;height:16px;flex:1;font-size:11px;color:var(--omp-text-dim);font-variant-numeric:tabular-nums}
omp-channel-desk .cd-all .axis span{position:absolute;transform:translateX(-50%);white-space:nowrap}
omp-channel-desk .cd-all .grid{position:absolute;top:0;bottom:0;width:1px;background:#ffffff14}
omp-channel-desk .cd-all .nowline{position:absolute;top:0;bottom:0;width:2px;background:#ff5c5c}
omp-channel-desk b.live{background:linear-gradient(#b3407a,#7d2455)!important}
omp-channel-desk b.ctl{background:linear-gradient(#555,#3a3a3a)!important}
omp-channel-desk b.fix{box-shadow:0 0 0 1px var(--omp-accent,#4aa3ff) inset}
omp-channel-desk b.cued{background:linear-gradient(#c79a1c,#8a6a0a)!important;color:#1a1100!important}
omp-channel-desk b.onair{background:linear-gradient(#35b862,#1c8a48)!important;color:#02150a!important}
omp-channel-desk b.miss{background:repeating-linear-gradient(135deg,#c42b2b 0 6px,#7a1414 6px 12px)!important;box-shadow:0 0 0 2px #ff4040;z-index:1}
omp-channel-desk b.bad{background:repeating-linear-gradient(135deg,#d98a14 0 6px,#7a4a08 6px 12px)!important;box-shadow:0 0 0 2px #ff9f1c;z-index:1}
omp-channel-desk .cd-empty{color:var(--omp-text-dim);padding:24px;text-align:center}
`;

export class ChannelDesk extends HTMLElement {
  #entries: ConsoleEntry[] = [];
  #channels: Channel[] = [];
  #isPlayout = new Map<string, boolean>(); // nodeRoleId|url → Probe-Ergebnis
  #selected = new Set<string>();
  #openKey: string | null = null;
  #winMin = 30;
  #combined = false;
  #optWarn = true;
  #optKids = false;
  #attn!: HTMLDivElement;
  #attnMini!: HTMLDivElement;
  #optBtns: HTMLButtonElement[] = [];
  #allBox!: HTMLDivElement;
  #allBtn!: HTMLButtonElement;
  #timer?: number;
  #tick = 0;
  #polling = false;
  #bar!: HTMLDivElement;
  #main!: HTMLDivElement;
  #grid!: HTMLDivElement;
  #tools!: HTMLDivElement;
  #selInfo!: HTMLSpanElement;
  #gangBtns: HTMLButtonElement[] = [];
  #editHost?: HTMLElement;
  #overviewTab!: HTMLButtonElement;
  #keyHandler = (ev: KeyboardEvent) => this.#onKey(ev);
  #loading = true;

  connectedCallback() {
    if (!document.getElementById("omp-channel-desk-style")) {
      const s = document.createElement("style");
      s.id = "omp-channel-desk-style";
      s.textContent = STYLE;
      document.head.append(s);
    }
    try {
      const w = Number(localStorage.getItem("omp-cd-window"));
      if (WINDOWS_MIN.includes(w)) this.#winMin = w;
      this.#combined = localStorage.getItem("omp-cd-combined") === "1";
      this.#optWarn = localStorage.getItem("omp-cd-warn") !== "0";
      this.#optKids = localStorage.getItem("omp-cd-kids") === "1";
    } catch { /* ohne Speicher: Standard */ }
    this.#bar = document.createElement("div");
    this.#bar.className = "cd-bar";
    this.#main = document.createElement("div");
    this.#main.className = "cd-main";
    this.append(this.#bar, this.#main);
    this.#buildOverview();
    this.#renderAll();
    addEventListener("keydown", this.#keyHandler);
    this.#timer = setInterval(() => void this.#poll(), POLL_MS) as unknown as number;
  }

  disconnectedCallback() {
    clearInterval(this.#timer);
    removeEventListener("keydown", this.#keyHandler);
  }

  /** Setzt die Konsolen-Liste (aus /api/v1/me/consoles oder dem Node-Bestand); wiederholt aufrufbar. */
  async setEntries(entries: ConsoleEntry[]) {
    this.#entries = entries;
    const probes = await Promise.all(entries.map(async (e) => {
      const id = `${e.nodeRoleId}|${e.uiBundleUrl}`;
      if (!this.#isPlayout.has(id)) {
        // Nur eindeutige Antworten merken: ein vorübergehend unerreichbarer Node wird beim nächsten Mal erneut geprüft.
        const r = await apiFetch(`${e.uiBundleUrl}/params/currentItemId`).catch(() => null);
        if (r && (r.ok || r.status === 404)) this.#isPlayout.set(id, r.ok);
        else return false;
      }
      return this.#isPlayout.get(id) === true;
    }));
    const wanted = entries.filter((_, i) => probes[i]);
    const old = new Map(this.#channels.map((c) => [c.key, c]));
    this.#channels = wanted.map((e) => {
      const prev = old.get(e.nodeRoleId);
      if (prev && prev.entry.uiBundleUrl === e.uiBundleUrl) { prev.entry = e; return prev; }
      return this.#makeChannel(e);
    });
    this.#loading = false;
    this.#selected = pruneSelection(this.#selected, this.#channels.map((c) => c.key));
    if (this.#openKey && !this.#channels.some((c) => c.key === this.#openKey)) this.#openKey = null;
    this.#renderAll();
    void this.#poll();
  }

  /** Wird bei jeder Änderung angezeigter Werte, der Auswahl oder des geöffneten Channels aufgerufen (Stream Deck). */
  onModelChange?: () => void;

  /** Stand für die Stream-Deck-Belegung (siehe deck-logic.ts). */
  deckInput(armed: GangAction | null, openMode: boolean): DeckInput {
    const first = attentionList(this.#channels.map((c) => ({ key: c.key, name: c.summary.name, list: c.upcoming })), 1)[0];
    return {
      channels: this.#channels.map((c) => ({
        key: c.key, name: c.summary.name, health: c.summary.health, remainingMs: c.summary.remainingMs,
        onAir: !!c.summary.onAir, selected: this.#selected.has(c.key),
      })),
      openKey: this.#openKey,
      openMode,
      attention: first ? { key: first.key, channel: first.channel, label: first.label, inMs: first.inMs, waiting: first.waiting, kind: first.kind === "live" ? "live" : "manual" } : undefined,
      armed,
    };
  }
  toggleSelect(key: string) {
    if (this.#selected.has(key)) this.#selected.delete(key); else this.#selected.add(key);
    if (this.#openKey === null) this.#syncSelection(); else this.onModelChange?.();
  }
  selectAll() { this.#selected = new Set(this.#channels.map((c) => c.key)); this.#syncIfOverview(); }
  selectNone() { this.#selected.clear(); this.#syncIfOverview(); }
  #syncIfOverview() { if (this.#openKey === null) this.#syncSelection(); else this.onModelChange?.(); }
  /** Channel am Bildschirm öffnen (`null` = Übersicht). */
  openChannel(key: string | null) { this.#open(key); }
  /** Werte sofort nachladen (auch wenn die Ansicht gerade verdeckt ist). */
  async refreshNow() { await this.#poll(true); }

  /** Channels, die die Ansicht zeigt (für die Shell: gibt es überhaupt etwas zu übersichten?). */
  get channelCount(): number { return this.#channels.length; }

  #makeChannel(e: ConsoleEntry): Channel {
    const switchBtn = document.createElement("button");
    switchBtn.className = "cd-tab";
    switchBtn.addEventListener("click", () => this.#open(e.nodeRoleId));
    const ch: Channel = {
      key: e.nodeRoleId, entry: e, nodeId: nodeIdFromBundleUrl(e.uiBundleUrl), values: null, tl: [], tlKey: "",
      summary: summarize(null, e.nodeLabel), upcoming: [], card: document.createElement("div"), switchBtn,
    };
    this.#buildCard(ch);
    return ch;
  }

  // ---- Übersicht ------------------------------------------------------------------------------------------------

  #buildOverview() {
    this.#tools = document.createElement("div");
    this.#tools.className = "cd-tools";
    const title = document.createElement("strong");
    title.textContent = t("mc.title");
    const grow = document.createElement("span");
    grow.className = "grow";
    const win = document.createElement("select");
    win.title = t("mc.window");
    for (const m of WINDOWS_MIN) {
      const o = document.createElement("option");
      o.value = String(m);
      o.textContent = t("mc.winMin", { n: m });
      win.append(o);
    }
    win.value = String(this.#winMin);
    win.addEventListener("change", () => {
      this.#winMin = Number(win.value);
      try { localStorage.setItem("omp-cd-window", String(this.#winMin)); } catch { /* egal */ }
      for (const c of this.#channels) this.#updateCard(c);
      this.#updateCombined();
    });
    const all = this.#btn(t("mc.selectAll"), () => { this.#selected = new Set(this.#channels.map((c) => c.key)); this.#syncSelection(); });
    const none = this.#btn(t("mc.selectNone"), () => { this.#selected.clear(); this.#syncSelection(); });
    this.#selInfo = document.createElement("span");
    this.#selInfo.style.color = "var(--omp-text-dim)";
    const sep = document.createElement("span");
    sep.className = "sep";
    const gangLabel = document.createElement("span");
    gangLabel.textContent = t("mc.gang");
    gangLabel.title = t("mc.gangHint");
    this.#gangBtns = ACTIONS.map((a) => {
      const b = this.#btn(t(`mc.act.${a}` as I18nKey), () => void this.#gang(a));
      b.title = t("mc.gangHint");
      return b;
    });
    this.#allBtn = this.#btn(t("mc.allTimeline"), () => {
      this.#combined = !this.#combined;
      try { localStorage.setItem("omp-cd-combined", this.#combined ? "1" : "0"); } catch { /* egal */ }
      this.#renderAll();
    });
    this.#allBtn.title = t("mc.allTimelineTip");
    const opt = (key: string, label: string, tip: string, get: () => boolean, set: (v: boolean) => void) => {
      const b = this.#btn(label, () => {
        set(!get());
        try { localStorage.setItem(key, get() ? "1" : "0"); } catch { /* egal */ }
        sync();
        this.#refreshViews();
      });
      b.title = tip;
      const sync = () => { b.style.borderColor = get() ? "var(--omp-accent,#4aa3ff)" : ""; };
      sync();
      return b;
    };
    this.#optBtns = [
      opt("omp-cd-warn", t("mc.optWarn"), t("mc.optWarnTip"), () => this.#optWarn, (v) => { this.#optWarn = v; }),
      opt("omp-cd-kids", t("mc.optKids"), t("mc.optKidsTip"), () => this.#optKids, (v) => { this.#optKids = v; }),
    ];
    this.#allBox = document.createElement("div");
    this.#allBox.className = "cd-all";
    this.#tools.append(title, grow, win, this.#allBtn, ...this.#optBtns, all, none, this.#selInfo, sep, gangLabel, ...this.#gangBtns);
    this.#grid = document.createElement("div");
    this.#grid.className = "cd-grid";
    this.#attn = document.createElement("div");
    this.#attn.className = "cd-attn";
  }

  #btn(text: string, on: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = text;
    b.addEventListener("click", on);
    return b;
  }

  #buildCard(ch: Channel) {
    const card = ch.card;
    card.className = "cd-card";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.role = "sel";
    cb.addEventListener("change", () => {
      if (cb.checked) this.#selected.add(ch.key); else this.#selected.delete(ch.key);
      this.#syncSelection();
    });
    const dot = document.createElement("span");
    dot.className = "cd-dot";
    dot.dataset.role = "dot";
    const name = document.createElement("span");
    name.className = "cd-name";
    name.dataset.role = "name";
    const badge = document.createElement("span");
    badge.className = "cd-badge";
    badge.dataset.role = "badge";
    const edit = this.#btn(t("mc.edit"), () => this.#open(ch.key));
    const head = document.createElement("div");
    head.className = "cd-head";
    head.append(cb, dot, name, badge, edit);
    const title = document.createElement("span");
    title.className = "cd-title";
    title.dataset.role = "title";
    const clock = document.createElement("span");
    clock.className = "cd-clock";
    clock.dataset.role = "clock";
    const now = document.createElement("div");
    now.className = "cd-now";
    now.append(title, clock);
    const prog = document.createElement("div");
    prog.className = "cd-prog";
    prog.innerHTML = "<i></i>";
    const next = document.createElement("div");
    next.className = "cd-next";
    next.dataset.role = "next";
    const tl = document.createElement("div");
    tl.className = "cd-tl";
    tl.dataset.role = "tl";
    tl.addEventListener("dblclick", () => this.#open(ch.key));
    const stats = document.createElement("div");
    stats.className = "cd-stats";
    stats.dataset.role = "stats";
    const cnt = document.createElement("div");
    cnt.className = "cd-cnt";
    cnt.dataset.role = "cnt";
    card.append(head, now, prog, cnt, next, tl, stats);
    this.#updateCard(ch);
  }

  #q(el: HTMLElement, role: string): HTMLElement {
    return el.querySelector(`[data-role="${role}"]`) as HTMLElement;
  }

  /** Spur eines Channels (Balken) plus optionale Child-Event-Zeilen — für Kachel und Gesamt-Timeline. */
  #lanes(ch: Channel, now: number, past: number, future: number): { lane: HTMLElement; kids: HTMLElement[] } {
    const v = ch.values!;
    const items = v.items ?? [];
    const lane = document.createElement("div");
    lane.className = "lane";
    const opts = this.#optWarn ? { warnings: planWarnings(v.schedule), childRuntime: v.childEvents ?? [] } : {};
    for (const b of buildBlocks(items, ch.tl, now, v.currentItemId, past, future, v.cuedItemId, opts)) {
      const el = document.createElement("b");
      el.style.left = `${b.leftPct}%`;
      el.style.width = `${b.widthPct}%`;
      el.textContent = b.cls.includes("bad") && b.note ? `⚠ ${b.label}` : b.label;
      el.title = b.note ? `⚠ ${b.note}\n${b.label}` : b.label;
      el.className = b.cls;
      el.addEventListener("dblclick", () => this.#open(ch.key));
      lane.append(el);
    }
    const kids: HTMLElement[] = [];
    if (this.#optKids) {
      for (const row of childRows(items, ch.tl, v.childEvents ?? [], now, past, future)) {
        const r = document.createElement("div");
        r.className = "krow";
        for (const k of row) {
          const el = document.createElement("div");
          el.className = `kid ${k.state}`;
          el.style.left = `${k.leftPct}%`;
          el.style.width = `${k.widthPct}%`;
          el.textContent = k.label;
          el.title = k.label;
          r.append(el);
        }
        kids.push(r);
      }
    }
    return { lane, kids };
  }

  #cntChip(kind: "live" | "manual" | "missing", u?: Upcoming): HTMLElement {
    const icon = { live: "●", manual: "✋", missing: "⚠" }[kind];
    const el = document.createElement("span");
    if (!u) {
      el.className = "empty";
      el.textContent = t(`mc.cnt.${kind}` as I18nKey) + ": —";
      return el;
    }
    const when = u.waiting ? t("mc.cnt.waiting") : fmtRemain(u.inMs);
    el.className = `u-${urgencyOf(u)}`;
    el.textContent = [icon, [u.atEnd && u.label ? t("mc.cnt.after", { label: u.label }) : u.label, when].filter(Boolean).join(" · ")].join(" ");
    el.title = t(`mc.cnt.${kind}` as I18nKey);
    return el;
  }

  #refreshViews() {
    for (const c of this.#channels) this.#updateCard(c);
    this.#updateCombined();
  }

  /** Kanalübergreifend: wann muss der Operator als Nächstes etwas tun (manuell/Live, z. B. externen Regieplatz starten). */
  #updateAttention() {
    const list: AttentionItem[] = attentionList(this.#channels.map((c) => ({ key: c.key, name: c.summary.name, list: c.upcoming })), 4);
    const mk = (u: AttentionItem) => {
      const el = document.createElement("span");
      el.className = `it u-${urgencyOf(u)}`;
      const icon = u.kind === "live" ? "●" : "✋";
      el.textContent = [icon, [u.channel, u.atEnd && u.label ? t("mc.cnt.after", { label: u.label }) : u.label, u.waiting ? t("mc.cnt.waiting") : fmtRemain(u.inMs)].filter(Boolean).join(" · ")].join(" ");
      el.title = t(u.kind === "live" ? "mc.cnt.live" : "mc.cnt.manual");
      el.style.cursor = "pointer";
      el.addEventListener("click", () => this.#open(u.key));
      return el;
    };
    this.#attn.replaceChildren(
      Object.assign(document.createElement("span"), { className: "ttl", textContent: t("mc.attn.title"), title: t("mc.attn.tip") }),
      ...(list.length ? list.map(mk) : [Object.assign(document.createElement("span"), { className: "none", textContent: t("mc.attn.none") })]),
    );
    // Kompakt in der Wechselleiste, damit es auch beim Bearbeiten eines Channels sichtbar bleibt.
    if (!this.#attnMini) {
      this.#attnMini = document.createElement("div");
      this.#attnMini.className = "cd-attn-mini";
    }
    const first = list[0];
    this.#attnMini.className = `cd-attn-mini${first ? ` u-${urgencyOf(first)}` : ""}`;
    this.#attnMini.style.display = first ? "" : "none";
    this.#attnMini.replaceChildren(...(first ? [mk(first)] : []));
    this.#attnMini.firstElementChild?.setAttribute("class", "");
    this.#attnMini.title = t("mc.attn.title");
    if (!this.#attnMini.isConnected) this.#bar.append(this.#attnMini);
  }

  #updateCard(ch: Channel) {
    const s = ch.summary;
    const c = ch.card;
    c.classList.toggle("sel", this.#selected.has(ch.key));
    (this.#q(c, "sel") as HTMLInputElement).checked = this.#selected.has(ch.key);
    this.#q(c, "dot").className = `cd-dot ${s.health}`;
    this.#q(c, "dot").title = t(`mc.health.${s.health}` as I18nKey);
    this.#q(c, "name").textContent = s.name;
    const badge = this.#q(c, "badge");
    const waitText = s.waitKind ? t(`mc.wait.${s.waitKind}` as I18nKey) : "";
    badge.textContent = waitText || s.mode.toUpperCase();
    badge.className = `cd-badge ${s.waitKind ? "wait" : s.mode}`;
    badge.style.display = badge.textContent ? "" : "none";
    this.#q(c, "title").textContent = s.onAir || t("mc.nothing");
    this.#q(c, "clock").textContent = fmtRemain(s.remainingMs);
    (c.querySelector(".cd-prog>i") as HTMLElement).style.width = `${Math.round(s.progress * 100)}%`;
    this.#q(c, "next").textContent = s.nextLabel ? `${t("mc.next")}: ${s.nextLabel}` : "";

    // Zeitleiste: Fenster um die Sendeposition
    const v = ch.values;
    const tlEl = this.#q(c, "tl");
    const now = v ? playlistNow(ch.tl, v.currentItemId, v.playheadPositionMs ?? 0, v.cuedItemId) : null;
    if (v && now !== null) {
      const past = Math.round(this.#winMin * 60_000 * TIMELINE_PAST_SHARE);
      const future = this.#winMin * 60_000 - past;
      const { lane, kids } = this.#lanes(ch, now, past, future);
      tlEl.replaceChildren(lane, ...kids, Object.assign(document.createElement("u"), { style: `left:${nowOffsetPct(past, future)}%` }));
    } else {
      tlEl.replaceChildren();
    }
    // Zähler: nächstes Live-, manuelles und fehlendes Event
    const nb = nextByKind(ch.upcoming);
    this.#q(c, "cnt").replaceChildren(
      this.#cntChip("live", nb.live), this.#cntChip("manual", nb.manual), this.#cntChip("missing", nb.missing),
    );
    const stats = this.#q(c, "stats");
    const ends = s.remainingTotalMs > 0 ? new Date(Date.now() + s.remainingTotalMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    stats.replaceChildren(
      ...[
        t("mc.stat.events", { n: s.itemCount }),
        s.remainingTotalMs > 0 ? t("mc.stat.rest", { t: fmtRemain(s.remainingTotalMs) }) : "",
        ends ? t("mc.stat.ends", { at: ends }) : "",
      ].filter(Boolean).map((x) => Object.assign(document.createElement("span"), { textContent: x })),
    );

    // Wechselleiste
    ch.switchBtn.replaceChildren(
      Object.assign(document.createElement("span"), { className: `cd-dot ${s.health}` }),
      Object.assign(document.createElement("span"), { textContent: s.name }),
      Object.assign(document.createElement("span"), { className: "rem", textContent: s.onAir ? fmtRemain(s.remainingMs) : "" }),
    );
    ch.switchBtn.title = `${s.name}${s.onAir ? ` — ${s.onAir}` : ""}`;
  }

  // Gesamt-Timeline: eine Spur je Channel auf gemeinsamer Wanduhr-Achse (jeder Channel ist relativ zu seiner eigenen
  // Sendeposition gezeichnet, „jetzt“ ist für alle dieselbe Linie — dadurch liegen gleichzeitige Events untereinander).
  #updateCombined() {
    if (!this.#combined || !this.#allBox.isConnected) return;
    const past = Math.round(this.#winMin * 60_000 * TIMELINE_PAST_SHARE);
    const future = this.#winMin * 60_000 - past;
    const nowPct = nowOffsetPct(past, future);
    const ticks = axisTicks(Date.now(), past, future);
    const mk = (cls: string, css = "", text = "") => Object.assign(document.createElement("div"), { className: cls, style: css, textContent: text });
    const axis = mk("axis");
    axis.append(...ticks.map((k) => Object.assign(document.createElement("span"), {
      style: `left:${k.leftPct}%`, textContent: new Date(k.epochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    })));
    const axisRow = mk("row");
    axisRow.append(mk("lbl"), axis);
    const rows = this.#channels.map((c) => {
      const wrap = mk("lanewrap");
      const v = c.values;
      const now = v ? playlistNow(c.tl, v.currentItemId, v.playheadPositionMs ?? 0, v.cuedItemId) : null;
      if (v && now !== null) {
        const { lane, kids } = this.#lanes(c, now, past, future);
        lane.prepend(...ticks.map((k) => mk("grid", `left:${k.leftPct}%`)));
        wrap.append(lane, ...kids);
      } else {
        const lane = mk("lane");
        lane.append(...ticks.map((k) => mk("grid", `left:${k.leftPct}%`)));
        wrap.append(lane);
      }
      wrap.append(mk("nowline", `left:${nowPct}%`));
      const lbl = mk("lbl");
      lbl.append(mk(`cd-dot ${c.summary.health}`), Object.assign(document.createElement("span"), { textContent: c.summary.name }));
      lbl.title = c.summary.name;
      const row = mk("row");
      row.append(lbl, wrap);
      return row;
    });
    this.#allBox.replaceChildren(axisRow, ...rows);
  }

  #syncSelection() {
    for (const c of this.#channels) {
      c.card.classList.toggle("sel", this.#selected.has(c.key));
      (this.#q(c.card, "sel") as HTMLInputElement).checked = this.#selected.has(c.key);
    }
    this.onModelChange?.();
    this.#selInfo.textContent = this.#selected.size ? t("mc.selected", { n: this.#selected.size }) : "";
    for (const b of this.#gangBtns) b.disabled = this.#selected.size === 0;
  }

  // ---- Gruppen-Start --------------------------------------------------------------------------------------------

  async #gang(a: GangAction) {
    await this.runAction(a, [...this.#selected], true);
  }

  /** Aktion auf Channels (Schlüssel); `ask`: bei mehr als einem Channel erst bestätigen (Stream Deck bestätigt selbst per Doppeldruck). */
  async runAction(a: GangAction, keys: string[], ask: boolean) {
    const targets = this.#channels.filter((c) => keys.includes(c.key));
    if (targets.length === 0) return;
    const action = t(`mc.act.${a}` as I18nKey);
    // Ein Klick soll nie versehentlich mehrere Sendungen fahren: bei mehr als einem Channel erst bestätigen.
    if (ask && targets.length > 1) {
      const ok = await confirmDialog(t("mc.confirm", { action, n: targets.length, names: targets.map((c) => c.summary.name).join(", ") }), { confirmLabel: action });
      if (!ok) return;
    }
    const call = gangCall(a);
    const results: GangResult[] = await Promise.all(targets.map(async (c): Promise<GangResult> => {
      try {
        const res = call.kind === "method"
          ? await apiFetch(`/api/v1/nodes/${c.nodeId}/methods/${call.name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
          : await apiFetch(`/api/v1/nodes/${c.nodeId}/params/${call.name}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: call.value }) });
        if (res.ok) return { channel: c.summary.name, ok: true };
        return { channel: c.summary.name, ok: false, error: (await res.text().catch(() => "")) || `HTTP ${res.status}` };
      } catch (e) {
        return { channel: c.summary.name, ok: false, error: String(e) };
      }
    }));
    const sum = summarizeGang(results);
    if (sum.failed.length) showToast(t("mc.result.fail", { action, n: sum.failed.length, names: sum.failed.map((f) => `${f.channel} (${f.error})`).join(", ") }), { variant: "error" });
    else showToast(t("mc.result.ok", { action, n: sum.ok }), { variant: "info" });
    void this.#poll();
  }

  // ---- Wechsel / Bearbeiten -------------------------------------------------------------------------------------

  #open(key: string | null) {
    if (key === this.#openKey) return;
    this.#openKey = key;
    this.#renderAll();
    this.onModelChange?.();
  }

  #onKey(ev: KeyboardEvent) {
    if (!ev.altKey || ev.ctrlKey || ev.metaKey || !this.isConnected) return;
    const ids = this.#channels.map((c) => c.key);
    if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
      ev.preventDefault();
      this.#open(stepChannel(ids, this.#openKey, ev.key === "ArrowRight" ? 1 : -1));
    } else if (ev.key === "0") {
      ev.preventDefault();
      this.#open(null);
    } else if (/^[1-9]$/.test(ev.key) && ids[Number(ev.key) - 1]) {
      ev.preventDefault();
      this.#open(ids[Number(ev.key) - 1]);
    }
  }

  #renderAll() {
    // Wechselleiste
    this.#overviewTab = document.createElement("button");
    this.#overviewTab.className = "cd-tab";
    this.#overviewTab.textContent = t("mc.overview");
    this.#overviewTab.title = t("mc.keys");
    this.#overviewTab.addEventListener("click", () => this.#open(null));
    this.#bar.replaceChildren(this.#overviewTab, ...this.#channels.map((c) => c.switchBtn));
    this.#updateAttention();
    this.#bar.style.display = this.#channels.length > 0 ? "flex" : "none";
    this.#overviewTab.classList.toggle("active", this.#openKey === null);
    for (const c of this.#channels) c.switchBtn.classList.toggle("active", c.key === this.#openKey);

    if (this.#openKey === null) {
      this.#editHost = undefined;
      if (this.#loading) {
        this.#main.replaceChildren(Object.assign(document.createElement("p"), { className: "cd-empty", textContent: t("mc.loading") }));
      } else if (this.#channels.length === 0) {
        this.#main.replaceChildren(Object.assign(document.createElement("p"), { className: "cd-empty", textContent: t("mc.empty") }));
      } else {
        this.#grid.replaceChildren(...this.#channels.map((c) => c.card));
        this.#main.replaceChildren(this.#tools, this.#attn, ...(this.#combined ? [this.#allBox] : []), this.#grid);
        this.#allBtn.classList.toggle("active", this.#combined);
        this.#allBtn.style.borderColor = this.#combined ? "var(--omp-accent,#4aa3ff)" : "";
        this.#syncSelection();
        this.#updateCombined();
      }
      return;
    }
    const ch = this.#channels.find((c) => c.key === this.#openKey);
    if (!ch) return;
    const host = document.createElement("div");
    host.className = "cd-edit";
    this.#editHost = host;
    this.#main.replaceChildren(host);
    void (async () => {
      const el = await mountUIBundleEl(host, ch.entry.uiBundleUrl);
      if (this.#editHost !== host) return; // zwischenzeitlich weitergewechselt
      if (!el) host.replaceChildren(Object.assign(document.createElement("p"), { className: "cd-empty", textContent: t("mc.noBundle", { name: ch.entry.nodeLabel }) }));
    })();
  }

  // ---- Abfrage --------------------------------------------------------------------------------------------------

  async #poll(force = false) {
    if (this.#polling || this.#channels.length === 0 || (!force && this.offsetParent === null)) return; // versteckt: nicht abfragen
    this.#polling = true;
    this.#tick++;
    try {
      await Promise.all(this.#channels.map((c) => this.#pollOne(c)));
    } finally {
      this.#polling = false;
    }
    for (const c of this.#channels) {
      const v = c.values;
      c.upcoming = v?.connected === false ? [] : upcomingList(v?.items ?? [], c.tl, v?.currentItemId, v?.playheadPositionMs ?? 0, v?.operatorWait);
    }
    this.#updateAttention();
    this.#refreshViews();
    this.onModelChange?.();
  }

  async #pollOne(c: Channel) {
    try {
      const pairs = await Promise.all(PARAMS.map(async (n) => {
        const r = await apiFetch(`/api/v1/nodes/${c.nodeId}/params/${n}`);
        return [n, r.ok ? (await r.json()).value : undefined] as const;
      }));
      const v = Object.fromEntries(pairs) as ChannelValues;
      // Läuft der Node nicht mehr, fehlen alle Werte.
      c.values = pairs.every(([, x]) => x === undefined) ? { ...v, connected: false } : v;
      if (typeof v.operatorWait === "string") v.operatorWait = { kind: waitKindOf(v.operatorWait) };
      c.summary = summarize(c.values, c.entry.nodeLabel);
      const key = `${v.currentItemId ?? ""}|${v.items?.length ?? 0}`;
      if (key !== c.tlKey || this.#tick % TL_EVERY === 0) {
        const n = v.items?.length ?? 0;
        const r = n ? await apiFetch(`/api/v1/nodes/${c.nodeId}/timeline/window?fromIndex=0&count=${n}`) : null;
        c.tl = r && r.ok ? ((await r.json()) as TimelineEntry[]) : [];
        c.tlKey = key;
      }
    } catch {
      c.values = { connected: false };
      c.summary = summarize(c.values, c.entry.nodeLabel);
    }
  }
}

if (!customElements.get("omp-channel-desk")) {
  customElements.define("omp-channel-desk", ChannelDesk);
}
