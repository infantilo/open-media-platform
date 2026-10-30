// Detailansicht eines Eingangs-Assets: QC-Bericht, Review & Conform (Player + Editor), Verlauf.
import { confirmDialog, dateLocale, showToast, t as tt } from "../host.ts";
import { type Directory, groupName } from "../../kit/features.ts";
import { call, errText, mediaUrl } from "./api.ts";
import { ComparePanel } from "./compare-panel.ts";
import { SubtitlesPanel } from "./subtitles-panel.ts";
import { ConformPanel, type Draft, type MetaField } from "./conform-panel.ts";
import { type Job, QcPanel, type Report } from "./qc-panel.ts";
import { ReviewPlayer } from "./player.ts";
import { assignmentLabel, EDITABLE_STATES, isOverdue, isoToLocalInput, type Item, localInputToIso, type Policy, proxyProgress, qcBadge, type Segment, stateBadge, toServerSegments } from "./review-logic.ts";
import { timecodeOf } from "./timecode.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

export interface Me {
  username: string;
  canConfigure: boolean;
  isAdmin: boolean;
  /** Funktionsrecht der Person (Kapitel 44), z. B. `review.approve`. */
  can: (feature: string) => boolean;
  /** Nutzer und Gruppen zum Zuweisen (null: nicht sichtbar). */
  dir: Directory | null;
}

export interface Config {
  metadataFields: MetaField[];
  qcProfiles: Record<string, unknown>;
  defaultQcProfile: string;
  allowOverlap: boolean;
  allowGaps: boolean;
  minSegmentFrames: number;
  approvalMode: string;
}

interface Proxy {
  id: string;
  state: string;
  verified: boolean;
  error?: string;
  width?: number;
  height?: number;
  frames: number;
  audioTracks: number;
  progress?: number;
}

interface ConformDto {
  revision: number;
  state: string;
  usableIn?: number;
  usableOut?: number;
  assetMetadata?: Record<string, unknown>;
  segments: Segment[];
  decisionNote?: string;
  decidedBy?: string;
}

interface Detail {
  item: Item;
  qcJob: Job | null;
  qcReport: Report | null;
  proxy: Proxy | null;
  conform: ConformDto | null;
  policy: { claimable: boolean; qcBlocksReview: boolean };
}

/** Kleiner Texteingabe-Dialog (kein JS-prompt) — für Ablehnungsgrund / Neuzuweisung. */
export function askText(title: string, label: string, confirmLabel: string, initial = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = el("div");
    overlay.className = "omp-modal-overlay";
    overlay.style.zIndex = "3000";
    const m = el("div", "max-width:460px;");
    m.className = "omp-modal";
    const h1 = el("div", "margin-bottom:6px;", title);
    h1.className = "omp-h1";
    m.append(h1);
    const ta = el("textarea", "width:100%;box-sizing:border-box;min-height:80px;") as HTMLTextAreaElement;
    ta.value = initial;
    ta.dataset.role = "ask-text";
    const row = el("div", "display:flex;gap:8px;justify-content:flex-end;margin-top:10px;");
    const cancel = el("button", "", tt("rv.cancel"));
    const ok = el("button", "", confirmLabel);
    ok.className = "omp-btn-primary";
    ok.dataset.role = "ask-ok";
    const done = (v: string | null) => {
      overlay.remove();
      resolve(v);
    };
    cancel.addEventListener("click", () => done(null));
    ok.addEventListener("click", () => done(ta.value));
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") done(null);
    });
    row.append(cancel, ok);
    m.append(el("label", "font-size:12px;color:var(--omp-text-dim);", label), ta, row);
    overlay.append(m);
    document.body.append(overlay);
    ta.focus();
  });
}

/** Zuweisung erfassen: Person, Gruppe, Frist. Alles leer = Zuweisung aufheben. */
export function askAssign(initial: { user: string; group: string; dueAt?: string }, dir: Directory | null): Promise<{ user: string; group: string; dueAt?: string } | null> {
  return new Promise((resolve) => {
    const overlay = el("div");
    overlay.className = "omp-modal-overlay";
    overlay.style.zIndex = "3000";
    const m = el("div", "max-width:460px;");
    m.className = "omp-modal";
    const h1 = el("div", "margin-bottom:6px;", tt("rv.assign.title"));
    h1.className = "omp-h1";
    const field = (label: string, input: HTMLElement): HTMLElement => {
      const w = el("label", "display:flex;flex-direction:column;gap:2px;margin-top:8px;font-size:12px;color:var(--omp-text-dim);");
      w.append(label, input);
      return w;
    };
    const pick = (none: string, options: [string, string][], current: string, role: string): HTMLSelectElement => {
      const s = el("select", "box-sizing:border-box;width:100%;") as HTMLSelectElement;
      s.dataset.role = role;
      const list: [string, string][] = [["", none], ...options];
      if (current && !options.some(([v]) => v === current)) list.push([current, current]); // z. B. gelöschte Person/Gruppe nicht still verlieren
      for (const [v, l] of list) {
        const o = el("option", "", l);
        o.value = v;
        s.append(o);
      }
      s.value = current;
      return s;
    };
    const user = pick(tt("rv.assign.nobody"), (dir?.users ?? []).map((u) => [u.username, u.username]), initial.user, "assign-user");
    const group = pick(tt("rv.assign.nogroup"), (dir?.groups ?? []).map((g) => [g.id, g.name]), initial.group, "assign-group");
    const due = el("input", "box-sizing:border-box;width:100%;") as HTMLInputElement;
    due.type = "datetime-local";
    due.value = isoToLocalInput(initial.dueAt);
    due.dataset.role = "assign-due";
    const row = el("div", "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;");
    const cancel = el("button", "", tt("rv.cancel"));
    const ok = el("button", "", tt("rv.act.assign"));
    ok.className = "omp-btn-primary";
    ok.dataset.role = "assign-ok";
    const done = (v: { user: string; group: string; dueAt?: string } | null) => {
      overlay.remove();
      resolve(v);
    };
    cancel.addEventListener("click", () => done(null));
    ok.addEventListener("click", () => done({ user: user.value, group: group.value, dueAt: localInputToIso(due.value) }));
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") done(null);
    });
    row.append(cancel, ok);
    m.append(h1, el("div", "font-size:12px;color:var(--omp-text-dim);", tt("rv.assign.hint")), field(tt("rv.assign.user"), user), field(tt("rv.assign.group"), group), field(tt("rv.assign.due"), due), row);
    overlay.append(m);
    document.body.append(overlay);
    user.focus();
  });
}

export class ReviewDetail {
  readonly el = el("div", "display:flex;flex-direction:column;gap:10px;");
  #id: string;
  #me: Me;
  #cfg: Config;
  #onClose: () => void;
  #d: Detail | null = null;
  #tab: "qc" | "review" | "compare" | "subtitles" | "history" = "qc";
  #compare: ComparePanel | null = null;
  #subtitles: SubtitlesPanel | null = null;
  #draft: Draft = { usable: null, segments: [], assetMetadata: {} };
  #dirty = false;
  #remoteChanged = false;
  #banner = el("div");
  #head = el("div");
  #body = el("div");
  #player: ReviewPlayer | null = null;
  #conform: ConformPanel | null = null;
  #qc: QcPanel | null = null;
  #poll = 0;
  #proxyTimer = 0;
  #beforeUnload = (e: BeforeUnloadEvent) => {
    if (this.#dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  };

  constructor(id: string, me: Me, cfg: Config, onClose: () => void) {
    this.#id = id;
    this.#me = me;
    this.#cfg = cfg;
    this.#onClose = onClose;
    this.el.dataset.role = "review-detail";
    this.el.append(this.#head, this.#banner, this.#body);
    addEventListener("beforeunload", this.#beforeUnload);
    void this.#load(true).then(() => {
      this.#tab = this.#d && this.#isMine() ? "review" : "qc";
      this.#render();
    });
    this.#poll = setInterval(() => void this.#refreshQuiet(), 5000) as unknown as number;
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  destroy(): void {
    clearInterval(this.#poll);
    clearTimeout(this.#proxyTimer);
    removeEventListener("beforeunload", this.#beforeUnload);
    this.#player?.destroy();
    this.#qc?.destroy();
  }

  /** Zurück zur Liste — bei ungesicherten Änderungen nach Rückfrage. */
  async close(): Promise<void> {
    if (this.#dirty && !(await confirmDialog(tt("rv.unsaved"), { confirmLabel: tt("rv.discard") }))) return;
    this.destroy();
    this.#onClose();
  }

  #isMine(): boolean {
    return !!this.#d && this.#d.item.assignee === this.#me.username;
  }

  #editable(): boolean {
    return !!this.#d && this.#isMine() && EDITABLE_STATES.includes(this.#d.item.state);
  }

  async #load(resetDraft: boolean): Promise<void> {
    const r = await call<Detail>("GET", `/items/${this.#id}`);
    if (!r.ok) {
      this.#banner.replaceChildren(el("div", "color:var(--omp-error);", errText(r.data as unknown as Record<string, unknown>) || tt("rv.err.generic")));
      return;
    }
    this.#d = r.data;
    if (resetDraft) this.#draftFromServer();
    this.#remoteChanged = false;
  }

  #draftFromServer(): void {
    const c = this.#d?.conform;
    const md: Record<string, unknown> = { ...(c?.assetMetadata ?? {}) };
    // Titel vorbelegen: der Asset-Titel, solange noch keine redaktionellen Metadaten erfasst sind. Der Entwurf weicht dann vom
    // Serverstand ab und gilt als geändert (damit „Einreichen“ ihn mitspeichert).
    const prefill = !md.title && !!this.#d?.item.title && !!this.#editable();
    if (prefill) md.title = this.#d!.item.title;
    this.#draft = {
      usable: c && c.usableIn !== undefined && c.usableOut !== undefined ? { in: c.usableIn, out: c.usableOut } : null,
      segments: (c?.segments ?? []).map((s) => ({ ...s, metadata: { ...(s.metadata ?? {}) } })),
      assetMetadata: md,
    };
    this.#dirty = prefill;
  }

  async #refreshQuiet(): Promise<void> {
    if (!this.#d) return;
    const r = await call<Detail>("GET", `/items/${this.#id}`);
    if (!r.ok) return;
    const old = this.#d.item;
    const nw = r.data;
    this.#d = { ...nw, conform: this.#dirty ? this.#d.conform : nw.conform };
    if (nw.item.revision !== old.revision) {
      if (this.#dirty) this.#remoteChanged = true;
      else {
        this.#draftFromServer();
        this.#d = nw;
        this.#render();
        return;
      }
    }
    this.#renderHead();
    this.#renderBanner();
    this.#qc?.update(this.#qcCtx());
  }

  // ---- Aktionen ---------------------------------------------------------------------------------------------------

  async #act(path: string, body: Record<string, unknown> = {}, okMsg = ""): Promise<boolean> {
    const rev = this.#d?.item.revision ?? 0;
    const r = await call<{ item?: Item; error?: string; code?: string; problems?: string[] }>("POST", `/items/${this.#id}/${path}`, { expectedRevision: rev, ...body });
    if (!r.ok) {
      const msg = errText(r.data as Record<string, unknown>);
      showToast(r.status === 409 && r.data.code === "claimed" ? tt("rv.err.claimed") : msg || tt("rv.err.generic"));
      await this.#load(!this.#dirty);
      this.#render();
      return false;
    }
    if (okMsg) showToast(okMsg);
    await this.#load(true);
    this.#render();
    return true;
  }

  async #save(ack = false, force = false): Promise<boolean> {
    if (!this.#d) return false;
    const d = this.#draft;
    const r = await call<{ item: Item; conform: ConformDto; code?: string; current?: Item; problems?: string[]; error?: string }>("PUT", `/items/${this.#id}/conform`, {
      expectedRevision: force && this.#conflictRev !== null ? this.#conflictRev : this.#d.item.revision,
      usableIn: d.usable?.in ?? null,
      usableOut: d.usable?.out ?? null,
      segments: toServerSegments(d.segments).map((s) => ({ id: s.id, label: s.label, in: s.in, out: s.out, description: s.description ?? "", metadata: s.metadata ?? {} })),
      assetMetadata: d.assetMetadata,
      ackSourceChange: ack,
    });
    if (r.ok) {
      this.#conflictRev = null;
      await this.#load(true);
      showToast(tt("rv.saved"));
      this.#render();
      return true;
    }
    if (r.status === 409 && r.data.code === "revision_conflict") {
      const cur = r.data.current;
      this.#conflictRev = cur?.revision ?? null;
      const sourceChanged = cur && cur.revision === this.#d.item.revision;
      this.#showConflict(sourceChanged ? "source" : "revision");
      return false;
    }
    showToast(errText(r.data as Record<string, unknown>) || tt("rv.err.generic"));
    return false;
  }

  #conflictRev: number | null = null;

  #showConflict(kind: "source" | "revision"): void {
    const b = el("div", "border:1px solid var(--omp-cue);border-radius:6px;padding:8px 12px;background:rgba(251,140,0,.08);display:flex;flex-wrap:wrap;gap:8px;align-items:center;");
    b.dataset.role = "conflict-banner";
    b.append(el("b", "color:var(--omp-cue);", tt(kind === "source" ? "rv.conflict.source" : "rv.conflict.revision")));
    const reload = el("button", "", tt("rv.conflict.reload"));
    reload.addEventListener("click", async () => {
      this.#conflictRev = null;
      await this.#load(true);
      this.#render();
    });
    const force = el("button", "", tt(kind === "source" ? "rv.conflict.keep.source" : "rv.conflict.keep"));
    force.dataset.role = "conflict-force";
    force.addEventListener("click", () => void this.#save(kind === "source", true));
    b.append(reload, force);
    this.#banner.replaceChildren(b);
  }

  // ---- Darstellung ------------------------------------------------------------------------------------------------

  #qcCtx() {
    return {
      item: this.#d!.item,
      canOperate: this.#me.can("review.qc.run"),
      profiles: Object.keys(this.#cfg.qcProfiles),
      defaultProfile: this.#cfg.defaultQcProfile,
      goto: (f: number) => {
        this.#tab = "review";
        this.#render();
        setTimeout(() => this.#player?.seek(f), 0);
      },
      reload: async () => {
        await this.#load(!this.#dirty);
        this.#renderHead();
      },
    };
  }

  #render(): void {
    if (!this.#d) return;
    this.#renderHead();
    this.#renderBanner();
    this.#renderBody();
  }

  #renderBanner(): void {
    if (this.#remoteChanged && !this.#banner.querySelector("[data-role=conflict-banner]")) {
      const b = el("div", "border:1px solid var(--omp-cue);border-radius:6px;padding:6px 12px;color:var(--omp-cue);", tt("rv.conflict.remote"));
      b.dataset.role = "remote-banner";
      this.#banner.replaceChildren(b);
    } else if (!this.#remoteChanged && !this.#banner.querySelector("[data-role=conflict-banner]")) {
      this.#banner.replaceChildren();
    }
  }

  #renderHead(): void {
    const d = this.#d!;
    const it = d.item;
    const h = this.#head;
    h.replaceChildren();
    h.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;align-items:center;border-bottom:1px solid var(--omp-border);padding-bottom:8px;";
    h.dataset.role = "detail-head";
    const back = el("button", "padding:3px 10px;", "← " + tt("rv.back"));
    back.dataset.role = "back";
    back.addEventListener("click", () => void this.close());
    h.append(back);
    h.append(el("b", "font-size:15px;", it.title || it.fileName));
    h.append(el("span", "font:12px var(--omp-font-mono);color:var(--omp-text-dim);", it.fileName));
    const st = el("span", stateBadge(it.state), tt("rv.state." + it.state));
    st.dataset.role = "state";
    h.append(st);
    if (it.qcStatus) h.append(el("span", qcBadge(it.qcStatus), "QC: " + tt("rv.qc.overall." + it.qcStatus)));
    h.append(el("span", "color:var(--omp-text-dim);font-size:12px;", it.assignee ? tt("rv.assignee", { p0: it.assignee }) : tt("rv.unassigned")));
    const assigned = assignmentLabel(it, tt("rv.group"), (id) => groupName(this.#me.dir, id));
    if (assigned || it.dueAt) {
      const open = it.state !== "approved" && it.state !== "archived";
      const late = open && isOverdue(it.dueAt, Date.now());
      const chip = el(
        "span",
        `font-size:12px;border:1px solid ${late ? "var(--omp-error)" : "var(--omp-border)"};color:${late ? "var(--omp-error)" : "var(--omp-text-dim)"};border-radius:10px;padding:1px 8px;`,
        [assigned ? tt("rv.assignedTo", { p0: assigned }) : "", it.dueAt ? tt("rv.due", { p0: new Date(it.dueAt).toLocaleString(dateLocale()) }) : ""].filter(Boolean).join(" · "),
      );
      chip.dataset.role = "assignment";
      h.append(chip);
    }
    h.append(el("span", "color:var(--omp-text-dim);font-size:11px;", `rev ${it.revision}`));
    h.append(el("span", "flex:1;"));
    const add = (label: string, fn: () => void, cls = "", role = "", disabled = false): void => {
      const b = el("button", "padding:3px 12px;", label);
      if (cls) b.className = cls;
      if (role) b.dataset.role = role;
      b.disabled = disabled;
      b.addEventListener("click", fn);
      h.append(b);
    };
    const mine = this.#isMine();
    switch (it.state) {
      case "awaiting_review":
      case "rejected":
      case "awaiting_qc":
      case "qc_running":
      case "qc_failed_to_run":
        if (!it.assignee && this.#me.can("review.work")) add(tt("rv.act.claim"), () => void this.#act("claim", {}, tt("rv.claimed")), "omp-btn-primary", "claim", !d.policy.claimable);
        break;
      case "approved":
        add(tt("rv.act.revise"), () => void this.#act("revise"), "", "revise");
        if (this.#me.can("review.approve")) add(tt("rv.act.archive"), () => void this.#act("archive"), "", "archive");
        break;
      case "archived":
        if (this.#me.can("review.approve")) add(tt("rv.act.unarchive"), () => void this.#act("unarchive"));
        break;
    }
    if (it.state === "rejected" && it.assignee === "") {
      // „Übernehmen“ erzeugt die neue Entwurfsrevision aus der abgelehnten
    }
    if (mine && EDITABLE_STATES.includes(it.state)) {
      add(tt("rv.act.save") + (this.#dirty ? " •" : ""), () => void this.#save(), this.#dirty ? "omp-btn-primary" : "", "save");
      add(tt("rv.act.submit"), async () => {
        if (this.#dirty && !(await this.#save())) return;
        await this.#act("submit", {}, tt("rv.submitted"));
      }, "", "submit");
      add(tt("rv.act.release"), async () => {
        if (this.#dirty && !(await confirmDialog(tt("rv.unsaved.release"), { confirmLabel: tt("rv.act.release") }))) return;
        await this.#act("release", {}, tt("rv.released"));
      }, "", "release");
    }
    if (it.state === "ready_for_approval") {
      if (this.#me.can("review.approve")) {
        add(tt("rv.act.approve"), () => void this.#act("approve", { note: "" }, tt("rv.approved")), "omp-btn-primary", "approve");
        add(tt("rv.act.reject"), async () => {
          const reason = await askText(tt("rv.reject.title"), tt("rv.reject.reason"), tt("rv.act.reject"));
          if (reason !== null) await this.#act("reject", { note: reason }, tt("rv.rejected"));
        }, "", "reject");
      }
      if (mine) add(tt("rv.act.withdraw"), () => void this.#act("withdraw"), "", "withdraw");
    }
    if (it.assignee && !mine && this.#me.can("review.assign") && EDITABLE_STATES.includes(it.state)) {
      add(tt("rv.act.reassign"), async () => {
        const to = await askText(tt("rv.reassign.title"), tt("rv.reassign.to"), tt("rv.act.reassign"), this.#me.username);
        if (to && to.trim()) await this.#act("reassign", { to: to.trim() });
      }, "", "reassign");
      add(tt("rv.act.forcerelease"), () => void this.#act("force-release"), "", "force-release");
    }
    if (this.#me.can("review.assign") && it.state !== "approved" && it.state !== "archived") {
      add(tt("rv.act.assign"), async () => {
        const r = await askAssign({ user: it.assignedTo ?? "", group: it.assignedGroup ?? "", dueAt: it.dueAt }, this.#me.dir);
        if (r) await this.#act("assign", r);
      }, "", "assign");
    }
    // Tabs
    const tabs = el("div", "display:flex;gap:2px;width:100%;margin-top:6px;");
    for (const [id, label] of [["qc", tt("rv.tab.qc")], ["review", tt("rv.tab.review")], ["compare", tt("rv.tab.compare")], ["subtitles", tt("rv.tab.subtitles")], ["history", tt("rv.tab.history")]] as const) {
      const b = el("button", `padding:4px 14px;border-radius:6px 6px 0 0;${this.#tab === id ? "background:var(--omp-surface-raised);font-weight:600;" : ""}`, label);
      b.dataset.tab = id;
      b.addEventListener("click", () => {
        this.#tab = id;
        this.#renderHead();
        this.#renderBody();
      });
      tabs.append(b);
    }
    h.append(tabs);
  }

  #renderBody(): void {
    this.#player?.destroy();
    this.#player = null;
    this.#qc?.destroy();
    this.#qc = null;
    this.#conform = null;
    this.#compare?.destroy();
    this.#compare = null;
    this.#subtitles?.destroy();
    this.#subtitles = null;
    clearTimeout(this.#proxyTimer);
    this.#body.replaceChildren();
    if (!this.#d) return;
    if (this.#tab === "qc") {
      this.#qc = new QcPanel(this.#qcCtx());
      this.#body.append(this.#qc.el);
    } else if (this.#tab === "review") {
      this.#renderReview();
    } else if (this.#tab === "compare") {
      this.#compare = new ComparePanel(this.#id);
      this.#body.append(this.#compare.el);
    } else if (this.#tab === "subtitles") {
      this.#subtitles = new SubtitlesPanel(this.#id);
      this.#body.append(this.#subtitles.el);
    } else {
      void this.#renderHistory();
    }
  }

  #renderReview(): void {
    const d = this.#d!;
    const it = d.item;
    const tl = it.timeline;
    if (!tl) {
      this.#body.append(el("div", "color:var(--omp-text-dim);", tt("rv.notimeline")));
      return;
    }
    const readOnly = !this.#editable();
    const info = el("div", "font-size:12px;color:var(--omp-text-dim);");
    if (readOnly) info.textContent = it.assignee ? tt("rv.readonly.other", { p0: it.assignee }) : tt("rv.readonly.claim");
    const wrap = el("div", "display:grid;grid-template-columns:minmax(380px,1.35fr) minmax(320px,1fr);gap:14px;align-items:start;");
    const left = el("div", "display:flex;flex-direction:column;gap:6px;min-width:0;");
    const right = el("div", "min-width:0;");
    wrap.append(left, right);
    this.#body.append(info, wrap);

    const policy: Policy = { allowOverlap: this.#cfg.allowOverlap, allowGaps: this.#cfg.allowGaps, minSegmentFrames: this.#cfg.minSegmentFrames };
    const mkConform = () => {
      this.#conform = new ConformPanel({
        timeline: tl,
        policy,
        fields: this.#cfg.metadataFields,
        readOnly,
        getMarks: () => this.#player?.marks ?? { in: null, out: null },
        getFrame: () => this.#player?.frame ?? 0,
        goto: (f) => {
          this.#player?.pause();
          this.#player?.seek(f);
        },
        preview: (a, b) => this.#player?.previewRange(a, b),
        changed: () => {
          this.#dirty = true;
          this.#renderHeadSaveOnly();
        },
        selectionChanged: () => this.#player?.refresh(),
      }, this.#draft);
      right.replaceChildren(this.#conform.el);
    };
    mkConform();

    // Proxy: vorhanden & verifiziert → Player, sonst erzeugen/abwarten
    const showPlayer = () => {
      const p = this.#d!.proxy;
      left.replaceChildren();
      if (p && p.state === "ready" && p.verified) {
        this.#player = new ReviewPlayer({
          timeline: tl,
          src: mediaUrl(`/${it.assetId}/proxy`) + (mediaUrl("/x").includes("?") ? "&" : "?") + `v=${p.id}`,
          proxyLabel: `${p.width}×${p.height} H.264`,
          audio: p.audioTracks > 0
            ? {
              tracks: p.audioTracks,
              durationSec: (tl.durationFrames * tl.rate.den) / tl.rate.num,
              peaksUrl: (track) => mediaUrl(`/${it.assetId}/peaks/${track}`) + (mediaUrl("/x").includes("?") ? "&" : "?") + `v=${p.id}`,
              urlFor: (track, block) => mediaUrl(`/${it.assetId}/audio/${track}/${block}.wav`) + (mediaUrl("/x").includes("?") ? "&" : "?") + `v=${p.id}`,
            }
            : undefined,
          getSegments: () => this.#draft.segments,
          findings: () => this.#d?.qcReport ? this.#findings : [],
          onAddSegment: (a, b) => {
            if (readOnly) return;
            this.#conform?.add(a, b);
          },
        });
        left.append(this.#player.el);
        left.append(el("div", "font-size:11px;color:var(--omp-text-dim);", tt("rv.player.keys")));
        this.#player.focus();
        void this.#loadFindings();
      } else if (p && p.state === "failed") {
        const b = el("div", "border:1px solid var(--omp-error);border-radius:6px;padding:10px;");
        b.append(el("b", "color:var(--omp-error);", tt("rv.proxy.failed")), el("div", "margin:4px 0;", p.error ?? ""));
        const retry = el("button", "", tt("rv.proxy.retry"));
        retry.addEventListener("click", async () => {
          await call("POST", `/items/${it.assetId}/proxy`, { force: true });
          await this.#load(false);
          showPlayer();
        });
        b.append(retry);
        left.append(b);
      } else {
        // Fortschrittsbalken der Proxy-Erzeugung: wartet noch (unbestimmt) oder zeigt den Anteil der erzeugten Bilder
        const box = el("div", "border:1px solid var(--omp-border);border-radius:6px;padding:14px;");
        box.dataset.role = "proxy-progress";
        const track = el("div", "height:10px;margin-top:8px;border-radius:5px;background:var(--omp-surface-raised);border:1px solid var(--omp-border);overflow:hidden;position:relative;");
        const fill = el("div", "height:100%;width:0;background:var(--omp-info,#4285f4);transition:width .4s linear;");
        track.append(fill);
        const status = el("div", "margin-top:4px;font-size:11px;color:var(--omp-text-dim);");
        box.append(el("div", "", tt("rv.proxy.building")), track, status);
        left.append(box);
        const paint = (px: Proxy | null) => {
          const g = proxyProgress(px);
          track.setAttribute("role", "progressbar");
          if (g.pct === null) {
            fill.style.width = "35%";
            fill.style.opacity = "0.45";
            status.textContent = tt("rv.proxy.waiting");
          } else {
            fill.style.width = `${g.pct}%`;
            fill.style.opacity = "1";
            track.setAttribute("aria-valuenow", String(g.pct));
            status.textContent = tt("rv.proxy.progress", { p0: g.pct });
          }
        };
        paint(p);
        if (!p) void call("POST", `/items/${it.assetId}/proxy`, {});
        const poll = async () => {
          const r = await call<{ proxy: Proxy | null }>("GET", `/items/${it.assetId}/proxy`);
          if (!this.#d) return;
          if (r.ok) {
            this.#d.proxy = r.data.proxy;
            const px = r.data.proxy;
            if (px && (px.state === "ready" || px.state === "failed")) {
              showPlayer();
              return;
            }
            paint(px);
          }
          this.#proxyTimer = setTimeout(poll, 1000) as unknown as number;
        };
        this.#proxyTimer = setTimeout(poll, 1000) as unknown as number;
      }
    };
    showPlayer();
  }

  #findings: import("./review-logic.ts").Finding[] = [];
  async #loadFindings(): Promise<void> {
    const id = this.#d?.item.qcReportId;
    if (!id) return;
    const r = await call<Report>("GET", `/qc/reports/${id}`);
    if (r.ok) {
      this.#findings = r.data.findings ?? [];
      this.#d!.qcReport = r.data;
      this.#player?.refresh();
    }
  }

  #renderHeadSaveOnly(): void {
    const b = this.#head.querySelector("[data-role=save]") as HTMLButtonElement | null;
    if (b) {
      b.textContent = tt("rv.act.save") + " •";
      b.className = "omp-btn-primary";
    }
  }

  async #renderHistory(): Promise<void> {
    const box = el("div", "display:flex;flex-direction:column;gap:12px;");
    this.#body.append(box);
    const [h, c] = await Promise.all([
      call<{ history: { id: number; at: string; actor: string; action: string; fromState?: string; toState?: string; detail?: Record<string, unknown> }[] }>("GET", `/items/${this.#id}/history`),
      call<{ conforms: ConformDto[] }>("GET", `/items/${this.#id}/conforms`),
    ]);
    const confs = c.data.conforms ?? [];
    const cbox = el("div", "border:1px solid var(--omp-border);border-radius:6px;padding:8px 10px;");
    cbox.append(el("div", "font-weight:600;margin-bottom:4px;", tt("rv.hist.revisions")));
    for (const x of confs) {
      cbox.append(el("div", "font-size:12px;", `r${x.revision} · ${tt("rv.conform." + x.state)} · ${x.segments.length} ${tt("rv.seg.count")}${x.decidedBy ? ` · ${x.decidedBy}` : ""}${x.decisionNote ? ` — ${x.decisionNote}` : ""}`));
    }
    if (!confs.length) cbox.append(el("div", "color:var(--omp-text-dim);", "—"));
    const hbox = el("div", "border:1px solid var(--omp-border);border-radius:6px;padding:8px 10px;");
    hbox.dataset.role = "history";
    hbox.append(el("div", "font-weight:600;margin-bottom:4px;", tt("rv.hist.title")));
    for (const x of [...(h.data.history ?? [])].reverse()) {
      const tlx = this.#d?.item.timeline;
      const detail = x.detail ? Object.entries(x.detail).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" ") : "";
      hbox.append(el("div", "font-size:12px;display:flex;gap:10px;", ""))
        ;
      const row = hbox.lastElementChild as HTMLElement;
      row.append(el("span", "color:var(--omp-text-dim);min-width:150px;", new Date(x.at).toLocaleString(dateLocale())), el("span", "min-width:110px;", x.actor), el("b", "min-width:150px;", tt("rv.hist.a." + x.action)), el("span", "color:var(--omp-text-dim);", `${x.fromState && x.toState && x.fromState !== x.toState ? `${tt("rv.state." + x.fromState)} → ${tt("rv.state." + x.toState)}  ` : ""}${detail}`));
      void tlx;
      void timecodeOf;
    }
    box.append(cbox, hbox);
  }
}
