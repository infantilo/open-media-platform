// Reiter „Untertitel“ im Eingang: SRT aus der Datei erzeugen (Auto-Untertitel-Node, optional mit Sprechererkennung), Aufträge,
// Download und Name der Spur für das Kind-Event SUBTITLE der Playout-Automation.
import { confirmDialog, showToast, t as tt } from "../host.ts";
import { call, download, errText } from "./api.ts";
import { anyActive, clampPct, EMPTY_SUBTITLE_FORM, SPEAKER_CHOICES, type SubtitleForm, type SubtitleJob, subtitleBody, stateColor } from "./subtitles-logic.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

interface ListResp {
  jobs: SubtitleJob[];
  available: { node: boolean; diarization: boolean };
  subtitleDir: string;
}

export class SubtitlesPanel {
  readonly el = el("div", "display:flex;flex-direction:column;gap:10px;");
  #id: string;
  #form: SubtitleForm = { ...EMPTY_SUBTITLE_FORM };
  #formBox = el("div");
  #list = el("div", "display:flex;flex-direction:column;gap:6px;");
  #info = el("div", "color:var(--omp-text-dim);font-size:12px;");
  #avail = { node: false, diarization: false };
  #dir = "";
  #timer: ReturnType<typeof setTimeout> | undefined;
  #dead = false;

  constructor(itemId: string) {
    this.#id = itemId;
    this.el.dataset.role = "subtitles-panel";
    this.el.append(this.#info, this.#formBox, this.#list);
    void this.#refresh();
  }

  destroy(): void {
    this.#dead = true;
    clearTimeout(this.#timer);
  }

  async #refresh(): Promise<void> {
    const r = await call<ListResp & Record<string, unknown>>("GET", `/items/${encodeURIComponent(this.#id)}/subtitles`);
    if (this.#dead) return;
    if (!r.ok) {
      this.#info.textContent = errText(r.data);
      return;
    }
    this.#avail = r.data.available ?? this.#avail;
    this.#dir = r.data.subtitleDir ?? "";
    this.#renderInfo();
    this.#renderForm();
    this.#renderJobs(r.data.jobs ?? []);
    clearTimeout(this.#timer);
    if (anyActive(r.data.jobs ?? [])) this.#timer = setTimeout(() => void this.#refresh(), 2000);
  }

  #renderInfo(): void {
    this.#info.replaceChildren(el("div", "", tt("rv.sub.hint")));
    if (!this.#avail.node) {
      const w = el("div", "color:var(--omp-warn, #c90);margin-top:4px;", tt("rv.sub.nonode"));
      w.dataset.role = "sub-nonode";
      this.#info.append(w);
    } else if (!this.#avail.diarization) {
      this.#info.append(el("div", "color:var(--omp-warn, #c90);margin-top:4px;", tt("rv.sub.nodiar")));
    }
    if (this.#dir) this.#info.append(el("div", "margin-top:4px;", tt("rv.sub.dir", { p0: this.#dir })));
  }

  #renderForm(): void {
    const f = this.#form;
    const box = el("div", "border:1px solid var(--omp-border);border-radius:6px;padding:10px;display:flex;flex-direction:column;gap:8px;");
    const row = (label: string, ctl: HTMLElement, hint = "") => {
      const r = el("label", "display:flex;gap:8px;align-items:center;");
      r.append(el("span", "min-width:170px;", label), ctl);
      if (hint) r.append(el("span", "color:var(--omp-text-dim);font-size:11px;", hint));
      return r;
    };
    const text = (key: "name" | "track" | "language", w: string, ph = "") => {
      const i = el("input", `width:${w};`);
      i.type = "text";
      i.value = f[key];
      i.placeholder = ph;
      i.dataset.field = key;
      i.addEventListener("input", () => (f[key] = i.value));
      return i;
    };
    const sp = el("select");
    sp.dataset.field = "speakers";
    for (const c of SPEAKER_CHOICES) sp.append(new Option(c === "auto" ? tt("rv.sub.sp.auto") : c === "1" ? tt("rv.sub.sp.one") : c, c));
    sp.value = f.speakers;
    const names = el("input", "width:280px;");
    names.type = "text";
    names.value = f.names;
    names.placeholder = "Alice, Bob";
    names.dataset.field = "names";
    names.addEventListener("input", () => (f.names = names.value));
    const style = el("select");
    style.dataset.field = "style";
    style.append(new Option("Alice: …", "colon"), new Option("[Alice] …", "bracket"), new Option("- Alice: …", "dash"));
    style.value = f.style;
    style.addEventListener("change", () => (f.style = style.value as SubtitleForm["style"]));
    const detail = el("div", "display:flex;flex-direction:column;gap:8px;");
    const syncDetail = () => (detail.style.display = f.speakers === "1" || !this.#avail.diarization ? "none" : "flex");
    sp.addEventListener("change", () => {
      f.speakers = sp.value;
      syncDetail();
    });
    detail.append(row(tt("rv.sub.names"), names, tt("rv.sub.names.hint")), row(tt("rv.sub.style"), style));
    syncDetail();
    const go = el("button", "align-self:flex-start;", tt("rv.sub.start"));
    go.dataset.role = "sub-start";
    go.disabled = !this.#avail.node;
    go.addEventListener("click", async () => {
      go.disabled = true;
      const body = subtitleBody(this.#avail.diarization ? f : { ...f, speakers: "1" });
      const r = await call("POST", `/items/${encodeURIComponent(this.#id)}/subtitles`, body);
      if (!r.ok) showToast(errText(r.data) || tt("rv.sub.err"));
      go.disabled = !this.#avail.node;
      void this.#refresh();
    });
    box.append(
      row(tt("rv.sub.name"), text("name", "220px"), tt("rv.sub.name.hint")),
      row(tt("rv.sub.track"), text("track", "60px"), tt("rv.sub.track.hint")),
      row(tt("rv.sub.lang"), text("language", "90px", "de"), tt("rv.sub.lang.hint")),
      row(tt("rv.sub.speakers"), sp),
      detail,
      go,
    );
    this.#formBox.replaceChildren(box);
  }

  #renderJobs(jobs: SubtitleJob[]): void {
    this.#list.replaceChildren();
    if (jobs.length === 0) {
      this.#list.append(el("div", "color:var(--omp-text-dim);", tt("rv.sub.none")));
      return;
    }
    for (const j of jobs) {
      const card = el("div", "border:1px solid var(--omp-border);border-radius:6px;padding:8px;display:flex;flex-direction:column;gap:4px;");
      card.dataset.role = "sub-job";
      card.dataset.state = j.state;
      const head = el("div", "display:flex;gap:10px;align-items:center;");
      head.append(el("b", "", j.name), el("span", `color:${stateColor(j.state)};`, tt(`rv.sub.state.${j.state}`)));
      if (j.state === "running") {
        const pr = el("progress", "width:160px;");
        pr.max = 100;
        pr.value = clampPct(j.progress);
        head.append(pr, el("span", "font-size:12px;", `${clampPct(j.progress)} %${j.phase ? " · " + j.phase : ""}`));
      }
      card.append(head);
      const bits: string[] = [];
      if (j.state === "done") {
        bits.push(tt("rv.sub.result", { p0: String(j.cues), p1: String(j.speakersFound), p2: j.durationS.toFixed(0) }));
        if (j.nodeLabel) bits.push(j.nodeLabel);
      }
      if (j.message && j.state !== "done") bits.push(j.message);
      if (bits.length) card.append(el("div", "color:var(--omp-text-dim);font-size:12px;", bits.join(" · ")));
      if (j.state === "done" && j.playoutTrack) {
        card.append(el("div", "font-size:12px;", tt("rv.sub.playout", { p0: j.playoutTrack })));
      }
      const acts = el("div", "display:flex;gap:6px;");
      if (j.state === "running") {
        const b = el("button", "", tt("rv.sub.cancel"));
        b.addEventListener("click", async () => {
          await call("POST", `/subtitles/${encodeURIComponent(j.id)}/cancel`);
          void this.#refresh();
        });
        acts.append(b);
      }
      if (j.downloadable) {
        const b = el("button", "", tt("rv.sub.download"));
        b.dataset.role = "sub-download";
        b.addEventListener("click", async () => {
          if (!(await download(`/subtitles/${encodeURIComponent(j.id)}/srt`, `${j.name}.srt`))) showToast(tt("rv.sub.err"));
        });
        acts.append(b);
      }
      if (j.state !== "running") {
        const b = el("button", "", tt("rv.sub.delete"));
        b.addEventListener("click", async () => {
          if (!(await confirmDialog(tt("rv.sub.delete.q", { p0: j.name })))) return;
          const r = await call("DELETE", `/subtitles/${encodeURIComponent(j.id)}`);
          if (!r.ok) showToast(errText(r.data) || tt("rv.sub.err"));
          void this.#refresh();
        });
        acts.append(b);
      }
      card.append(acts);
      this.#list.append(card);
    }
  }
}
