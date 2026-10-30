// Start-Assistent für Capture-Karten (Kap. 76): zeigt die erkannten Karten des gewählten Hosts mit ihren Eingängen
// und Ausgängen (frei/belegt); jeder gewählte Anschluss wird zu Eingang (Sender) bzw. Ausgang (Empfänger) der Instanz.

import { t } from "../shell/i18n.ts";
import { apiFetch } from "../shell/connection.ts";
import { allFree, type CardDevice, type CardsResponse, countSelection, groupCards, togglePort } from "./capture-card-logic.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

const DIM = "color:var(--omp-text-dim);";
const VENDOR_NAMES: Record<string, string> = { decklink: "Blackmagic DeckLink", aja: "AJA", matrox: "Matrox" };

export interface Wizard {
  element: HTMLElement;
  /** Neu laden, wenn ein anderer Host gewählt wurde ("" = lokal, nicht unterstützt). */
  setHost(hostId: string): void;
}

/** `onChange` meldet Hersteller und Port-IDs der Auswahl. */
export function createCardWizard(onChange: (cardType: string, ports: string[]) => void): Wizard {
  const root = el("div", "margin-bottom:10px;");
  let devices: CardDevice[] = [];
  let selected: string[] = [];
  let labels = new Map<string, string>();

  const publish = () => {
    const vendor = devices.find((d) => d.ports.some((p) => p.portId === selected[0]))?.vendor ?? "";
    onChange(vendor, selected);
  };

  const render = (note = "") => {
    root.replaceChildren(el("div", "font-size:11px;letter-spacing:.05em;text-transform:uppercase;" + DIM, t("cc.title")));
    if (note) root.append(el("div", "margin:4px 0;" + DIM, note));
    const groups = groupCards(devices);
    if (groups.length === 0) {
      root.append(el("div", "margin:6px 0;" + DIM, t("cc.none")));
      return;
    }
    for (const g of groups) {
      const box = el("div", "border:1px solid var(--omp-border,#3a3f45);border-radius:var(--omp-radius,6px);padding:8px 10px;margin:6px 0;");
      const head = el("div", "display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px;");
      head.append(el("span", "font-weight:600;", `${g.name || t("cc.unnamed")} · ${VENDOR_NAMES[g.vendor] ?? g.vendor}`));
      const all = el("button", "cursor:pointer;font:inherit;padding:1px 8px;", t("cc.selectAll"));
      all.type = "button";
      all.addEventListener("click", () => {
        const free = allFree(devices, g.vendor, g.name);
        const same = selected.filter((p) => devices.find((d) => d.ports.some((x) => x.portId === p))?.vendor === g.vendor);
        selected = [...new Set([...same, ...free])];
        render(note);
        publish();
      });
      head.append(all);
      box.append(head);
      for (const d of g.devices) {
        const row = el("div", "display:flex;align-items:center;gap:14px;padding:3px 0;");
        row.append(el("span", "min-width:84px;", t("cc.connector", { p0: d.device + 1 })));
        for (const dir of ["in", "out"] as const) {
          const port = d.ports.find((p) => p.dir === dir);
          const cell = el("label", "display:flex;align-items:center;gap:5px;min-width:150px;");
          if (!port) {
            cell.append(el("span", DIM, `– ${t(dir === "in" ? "cc.noIn" : "cc.noOut")}`));
          } else {
            const cb = el("input");
            cb.type = "checkbox";
            cb.checked = selected.includes(port.portId);
            cb.disabled = port.state !== "free";
            cb.addEventListener("change", () => {
              selected = togglePort(devices, selected, port.portId);
              render(note);
              publish();
            });
            cell.append(cb, el("span", "", t(dir === "in" ? "cc.in" : "cc.out")));
            if (port.state === "used") {
              const who = (port.instanceId && labels.get(port.instanceId)) || port.instanceId || port.role || "";
              cell.append(el("span", "color:var(--omp-warn,#d9a441);", t("cc.used", { p0: who })));
            } else {
              cell.append(el("span", "color:var(--omp-success,#4a4);", t("cc.free")));
            }
          }
          row.append(cell);
        }
        box.append(row);
      }
      root.append(box);
    }
    const c = countSelection(selected);
    root.append(el("div", DIM, selected.length === 0 ? t("cc.pick") : t("cc.summary", { p0: c.ins, p1: c.outs })));
  };

  const load = async (hostId: string) => {
    devices = [];
    selected = [];
    publish();
    if (!hostId) {
      render(t("cc.needHost"));
      return;
    }
    render(t("cc.searching"));
    try {
      const [res, inst] = await Promise.all([apiFetch(`/api/v1/hosts/${encodeURIComponent(hostId)}/cards`), apiFetch("/api/v1/instances")]);
      if (inst.ok) labels = new Map(((await inst.json()) as { id: string; label: string }[]).map((i) => [i.id, i.label]));
      if (!res.ok) {
        render(t("cc.error", { p0: (await res.text()).trim() }));
        return;
      }
      const body = (await res.json()) as CardsResponse;
      devices = body.cards ?? [];
      render(body.note ?? "");
    } catch (err) {
      render(t("cc.error", { p0: String(err) }));
    }
  };

  render(t("cc.needHost"));
  return { element: root, setHost: (id) => void load(id) };
}
