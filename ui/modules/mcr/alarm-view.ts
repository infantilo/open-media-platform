// Alarmhistorie (106.13d): beendete und laufende Signalalarme aller Events, neueste zuerst.
import { apiFetch, t } from "../host.ts";
import { h, input, select } from "./mcr-dom.ts";

interface Alarm { id: string; eventId: string; lineName: string; kind: string; severity: string; text: string; startedAt: string; endedAt?: string; ackedBy?: string; durationSec: number }

export function fmtDuration(s: number): string {
  if (s < 1) return "<1 s";
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

/** Filter der Alarmhistorie (leer = nicht filtern). */
export interface AlarmFilters { days: string; event: string; line: string; kind: string; severity: string; state: string }

/** Abfrage-Parameter der Historie: leere Filter entfallen, Eingaben werden gekürzt. */
export function buildAlarmQuery(f: AlarmFilters): URLSearchParams {
  const q = new URLSearchParams({ days: f.days || "7" });
  for (const k of ["event", "line", "kind", "severity", "state"] as const) {
    const v = f[k].trim();
    if (v) q.set(k, v);
  }
  return q;
}

/** Arten, die der Überwachungs-Node meldet (Vorschläge im Filter; es sind auch andere Teilstrings möglich). */
const KNOWN_KINDS = ["black", "freeze", "silence", "clipping", "loudness", "phase", "monoDropout", "signalLoss", "formatMismatch"].map((k) => `signal-${k}`);

export class AlarmHistory {
  readonly el = h("div", { class: "mcr-page" });
  #body = h("div", { class: "mcr-alarm-list" });
  #days = select([{ value: "1", label: t("mcr.alarms.d1") }, { value: "7", label: t("mcr.alarms.d7") }, { value: "30", label: t("mcr.alarms.d30") }], "7");
  #event: HTMLSelectElement;
  #line = input("", { placeholder: t("mcr.alarms.line"), "aria-label": t("mcr.alarms.line") });
  #kind = input("", { placeholder: t("mcr.alarms.kind"), "aria-label": t("mcr.alarms.kind"), list: "mcr-alarm-kinds" });
  #severity = select([{ value: "", label: t("mcr.alarms.sev.all") }, { value: "error", label: t("mcr.alarms.sev.error") }, { value: "warning", label: t("mcr.alarms.sev.warning") }, { value: "info", label: t("mcr.alarms.sev.info") }], "");
  #state = select([{ value: "", label: t("mcr.alarms.state.all") }, { value: "open", label: t("mcr.alarms.state.open") }, { value: "ended", label: t("mcr.alarms.state.ended") }, { value: "unacked", label: t("mcr.alarms.state.unacked") }], "");
  #events: Record<string, string> = {};
  #timer = 0;
  #seq = 0;

  constructor(eventNames: Record<string, string>) {
    this.#events = eventNames;
    this.#event = select([{ value: "", label: t("mcr.alarms.event.all") }, ...Object.entries(eventNames).map(([id, name]) => ({ value: id, label: name }))], "");
    const reset = h("button", { type: "button", class: "mcr-btn mcr-btn-sm mcr-btn-quiet" }, t("mcr.alarms.reset"));
    const kinds = h("datalist", { id: "mcr-alarm-kinds" }, ...KNOWN_KINDS.map((k) => h("option", { value: k })));
    this.el.append(h("h2", {}, t("mcr.tab.alarms")), h("p", { class: "mcr-sub" }, t("mcr.alarms.sub")),
      h("div", { class: "mcr-quick", style: "margin:8px 0;flex-wrap:wrap" }, this.#days, this.#event, this.#line, this.#kind, this.#severity, this.#state, reset, kinds), this.#body);
    for (const sel of [this.#days, this.#event, this.#severity, this.#state]) sel.addEventListener("change", () => void this.load());
    // Textfelder: schon beim Tippen (leicht verzögert), nicht erst beim Verlassen des Feldes
    for (const inp of [this.#line, this.#kind]) {
      inp.addEventListener("input", () => {
        clearTimeout(this.#timer);
        this.#timer = setTimeout(() => void this.load(), 300) as unknown as number;
      });
      inp.addEventListener("change", () => void this.load());
    }
    reset.addEventListener("click", () => {
      this.#event.value = this.#severity.value = this.#state.value = "";
      this.#line.value = this.#kind.value = "";
      void this.load();
    });
  }

  get filters(): AlarmFilters {
    return { days: this.#days.value, event: this.#event.value, line: this.#line.value, kind: this.#kind.value, severity: this.#severity.value, state: this.#state.value };
  }

  async load() {
    const seq = ++this.#seq; // eine ältere, langsamere Antwort darf eine neuere nicht überschreiben
    const q = buildAlarmQuery(this.filters);
    let list: Alarm[] = [];
    try {
      const r = await apiFetch(`/api/v1/mcr/alarms/history?${q}`);
      if (r.ok) list = ((await r.json()) as { alarms: Alarm[] }).alarms ?? [];
    } catch { /* leer */ }
    if (seq !== this.#seq) return;
    const dateFmt = (iso: string) => new Date(iso).toLocaleString();
    const filtered = [...q.keys()].some((k) => k !== "days");
    this.#body.replaceChildren(...(list.length ? [h("table", { class: "mcr-alarm-table" }, h("thead", {}, h("tr", {}, ...["start", "event", "line", "kind", "sev", "duration", "ack"].map((c) => h("th", {}, t(`mcr.alarms.c.${c}`))))),
      h("tbody", {}, ...list.map((a) => h("tr", { "data-open": String(!a.endedAt), "data-sev": a.severity }, h("td", {}, dateFmt(a.startedAt)), h("td", {}, this.#events[a.eventId] ?? a.eventId.slice(0, 8)), h("td", {}, a.lineName), h("td", { title: a.text }, a.kind.replace(/^signal-/, "")), h("td", {}, a.severity),
        h("td", {}, a.endedAt ? fmtDuration(a.durationSec) : `${t("mcr.alarms.open")} · ${fmtDuration(a.durationSec)}`), h("td", {}, a.ackedBy ?? "")))))] : [h("div", { class: "mcr-hint" }, filtered ? t("mcr.alarms.noneFiltered") : t("mcr.alarms.none"))]));
  }
}
