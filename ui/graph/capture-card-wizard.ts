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
export function createCardWizard(
  onChange: (cardType: string, ports: string[]) => void,
  onElements: (value: string) => void = () => {},
): Wizard {
  const root = el("div", "margin-bottom:10px;");
  let devices: CardDevice[] = [];
  let selected: string[] = [];
  let labels = new Map<string, string>();
  let hostId = "";
  let elements = "";

  const publish = () => {
    const vendor = devices.find((d) => d.ports.some((p) => p.portId === selected[0]))?.vendor ?? "";
    onChange(vendor, selected);
  };

  const api = async (url: string, init: RequestInit): Promise<string> => {
    const res = await apiFetch(url, init);
    return res.ok ? "" : (await res.text()).trim() || `HTTP ${res.status}`;
  };

  const removeDevice = async (device: number) => {
    const err = await api(`/api/v1/hosts/${encodeURIComponent(hostId)}/cards/manual/${device}`, { method: "DELETE" });
    if (err) render(t("cc.error", { p0: err }));
    else void load(hostId);
  };

  // Karten ohne Geräteabfrage (Matrox xMIO / DSX LE5): das SDK-Plugin bringt keine mit, die Anschlüsse legt der Betreiber hier an.
  const manualForm = (): HTMLElement => {
    const box = el("details", "margin:8px 0;");
    box.append(el("summary", "cursor:pointer;", t("cc.manual")));
    const hint = el("div", "margin:4px 0;" + DIM, t("cc.manualHint"));
    const name = el("input");
    name.type = "text";
    name.placeholder = t("cc.manualName");
    name.maxLength = 60;
    const count = el("input", "width:70px;");
    count.type = "number";
    count.min = "1";
    count.max = "16";
    count.value = "2";
    const kind = el("select");
    for (const [v, k] of [["duplex", "cc.kindDuplex"], ["in", "cc.kindIn"], ["out", "cc.kindOut"]] as const) kind.append(new Option(t(k), v));
    const add = el("button", "cursor:pointer;font:inherit;padding:2px 10px;", t("cc.manualAdd"));
    add.type = "button";
    add.addEventListener("click", async () => {
      const n = Math.max(1, Math.min(16, Number(count.value) || 1));
      const err = await api(`/api/v1/hosts/${encodeURIComponent(hostId)}/cards/manual`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.value.trim() || "Matrox", connectors: Array(n).fill(kind.value) }),
      });
      if (err) render(t("cc.error", { p0: err }));
      else void load(hostId);
    });
    const row = el("div", "display:flex;gap:8px;align-items:center;flex-wrap:wrap;");
    row.append(name, el("span", DIM, t("cc.manualCount")), count, kind, add);
    box.append(hint, row);
    return box;
  };

  const elementsField = (): HTMLElement => {
    const w = el("label", "display:flex;flex-direction:column;gap:3px;margin:8px 0;");
    w.append(el("span", "font-size:11px;letter-spacing:.05em;text-transform:uppercase;" + DIM, t("cc.elements")));
    const i = el("input", "box-sizing:border-box;width:100%;");
    i.type = "text";
    i.placeholder = "videosrc,audiosrc,videosink,audiosink";
    i.value = elements;
    i.addEventListener("input", () => {
      elements = i.value.trim();
      onElements(elements);
    });
    w.append(i, el("span", "font-size:11px;" + DIM, t("cc.elementsHint")));
    return w;
  };

  const render = (note = "") => {
    root.replaceChildren(el("div", "font-size:11px;letter-spacing:.05em;text-transform:uppercase;" + DIM, t("cc.title")));
    if (note) root.append(el("div", "margin:4px 0;" + DIM, note));
    const groups = groupCards(devices);
    if (groups.length === 0) root.append(el("div", "margin:6px 0;" + DIM, t("cc.none")));
    if (hostId) root.append(manualForm());
    if (groups.length === 0) return;
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
        if (g.vendor === "matrox") {
          const rm = el("button", "cursor:pointer;font:inherit;padding:1px 8px;margin-left:auto;", t("cc.remove"));
          rm.type = "button";
          rm.title = t("cc.removeTitle");
          rm.addEventListener("click", () => void removeDevice(d.device));
          row.append(rm);
        }
        box.append(row);
      }
      root.append(box);
    }
    if (selected.some((p) => p.startsWith("matrox-"))) root.append(elementsField());
    const c = countSelection(selected);
    root.append(el("div", DIM, selected.length === 0 ? t("cc.pick") : t("cc.summary", { p0: c.ins, p1: c.outs })));
  };

  const load = async (host: string) => {
    hostId = host;
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
