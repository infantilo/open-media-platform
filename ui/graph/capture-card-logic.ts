// Reine Logik des Start-Assistenten für Capture-Karten (Kap. 76, ohne DOM, testbar).

/** Kartentypen im I/O-Port-Inventar (`cardType`). */
export const CARD_TYPES = ["decklink", "aja", "matrox"] as const;

export interface CardPort {
  portId: string;
  dir: "in" | "out";
  state: "free" | "used";
  instanceId?: string;
  role?: string;
}

export interface CardDevice {
  vendor: string;
  device: number;
  name: string;
  ports: CardPort[];
}

export interface CardsResponse {
  cards: CardDevice[];
  note?: string;
}

/** Eine physische Karte: Geräte gleichen Herstellers und Namens (z. B. Duo 2 mit vier Teilgeräten). */
export interface CardGroup {
  vendor: string;
  name: string;
  devices: CardDevice[];
}

export function groupCards(devices: CardDevice[]): CardGroup[] {
  const groups: CardGroup[] = [];
  for (const d of [...devices].sort((a, b) => a.vendor.localeCompare(b.vendor) || a.name.localeCompare(b.name) || a.device - b.device)) {
    const g = groups.find((x) => x.vendor === d.vendor && x.name === d.name);
    if (g) g.devices.push(d);
    else groups.push({ vendor: d.vendor, name: d.name, devices: [d] });
  }
  return groups;
}

export function findPort(devices: CardDevice[], portId: string): CardPort | undefined {
  for (const d of devices) for (const p of d.ports) if (p.portId === portId) return p;
  return undefined;
}

/** Hersteller des Geräts, zu dem der Port gehört. */
export function vendorOf(devices: CardDevice[], portId: string): string {
  return devices.find((d) => d.ports.some((p) => p.portId === portId))?.vendor ?? "";
}

/**
 * Schaltet einen Port um. Eine Instanz bedient genau einen Hersteller: wählt jemand einen Port eines anderen
 * Herstellers, werden die bisherigen Ports verworfen. Belegte Ports lassen sich nicht wählen.
 */
export function togglePort(devices: CardDevice[], selected: string[], portId: string): string[] {
  const port = findPort(devices, portId);
  if (!port || port.state !== "free") return selected;
  if (selected.includes(portId)) return selected.filter((p) => p !== portId);
  const vendor = vendorOf(devices, portId);
  const keep = selected.filter((p) => vendorOf(devices, p) === vendor);
  return [...keep, portId];
}

/** Alle freien Ports der Geräte eines Herstellers (Karte als Ganzes wählen). */
export function allFree(devices: CardDevice[], vendor: string, name?: string): string[] {
  return devices
    .filter((d) => d.vendor === vendor && (name === undefined || d.name === name))
    .flatMap((d) => d.ports.filter((p) => p.state === "free").map((p) => p.portId));
}

/** Kurztext der Auswahl für die Anzeige, z. B. „2 Eingänge, 1 Ausgang“ — Zählung ohne Übersetzung. */
export function countSelection(selected: string[]): { ins: number; outs: number } {
  return { ins: selected.filter((p) => p.endsWith("-in")).length, outs: selected.filter((p) => p.endsWith("-out")).length };
}
