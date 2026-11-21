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

export class AlarmHistory {
  readonly el = h("div", { class: "mcr-page" });
  #body = h("div", { class: "mcr-alarm-list" });
  #days = select([{ value: "1", label: t("mcr.alarms.d1") }, { value: "7", label: t("mcr.alarms.d7") }, { value: "30", label: t("mcr.alarms.d30") }], "7");
  #kind = input("", { placeholder: t("mcr.alarms.kind") });
  #events: Record<string, string> = {};

  constructor(eventNames: Record<string, string>) {
    this.#events = eventNames;
    this.el.append(h("h2", {}, t("mcr.tab.alarms")), h("p", { class: "mcr-sub" }, t("mcr.alarms.sub")), h("div", { class: "mcr-quick", style: "margin:8px 0" }, this.#days, this.#kind), this.#body);
    this.#days.addEventListener("change", () => void this.load());
    this.#kind.addEventListener("change", () => void this.load());
  }

  async load() {
    const q = new URLSearchParams({ days: this.#days.value });
    if (this.#kind.value.trim()) q.set("kind", this.#kind.value.trim());
    let list: Alarm[] = [];
    try {
      const r = await apiFetch(`/api/v1/mcr/alarms/history?${q}`);
      if (r.ok) list = ((await r.json()) as { alarms: Alarm[] }).alarms ?? [];
    } catch { /* leer */ }
    const dateFmt = (iso: string) => new Date(iso).toLocaleString();
    this.#body.replaceChildren(...(list.length ? [h("table", { class: "mcr-alarm-table" }, h("thead", {}, h("tr", {}, ...["start", "event", "line", "kind", "duration", "ack"].map((c) => h("th", {}, t(`mcr.alarms.c.${c}`))))),
      h("tbody", {}, ...list.map((a) => h("tr", { "data-open": String(!a.endedAt), "data-sev": a.severity }, h("td", {}, dateFmt(a.startedAt)), h("td", {}, this.#events[a.eventId] ?? a.eventId.slice(0, 8)), h("td", {}, a.lineName), h("td", { title: a.text }, a.kind.replace(/^signal-/, "")),
        h("td", {}, a.endedAt ? fmtDuration(a.durationSec) : `${t("mcr.alarms.open")} · ${fmtDuration(a.durationSec)}`), h("td", {}, a.ackedBy ?? "")))))] : [h("div", { class: "mcr-hint" }, t("mcr.alarms.none"))]));
  }
}
