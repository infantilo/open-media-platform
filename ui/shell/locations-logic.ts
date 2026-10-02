// Reine Logik der Speicherort-Ansicht (ohne DOM, testbar).

import { fmtBytes } from "./scheduler-logic.ts";

export interface LocationItem {
  id: string;
  name: string;
  hostId: string;
  path: string;
  note?: string;
  status: "active" | "deprecated";
  check?: { exists: boolean; readable: boolean; entries?: number; freeBytes?: number; totalBytes?: number; message: string };
  checkError?: string;
  usage: { nodeType: string; option: string; value: string; instanceLabel?: string }[];
}

/** Statuszeile eines Orts: erreichbar, Einträge, Platz. */
export function describeCheck(l: Pick<LocationItem, "check" | "checkError">): { ok: boolean; text: string } {
  if (l.checkError) return { ok: false, text: l.checkError };
  const c = l.check;
  if (!c) return { ok: false, text: "nicht geprüft" };
  if (!c.readable) return { ok: false, text: c.message };
  const space = c.totalBytes ? ` · frei ${fmtBytes(c.freeBytes ?? 0)} von ${fmtBytes(c.totalBytes)}` : "";
  return { ok: true, text: `lesbar, ${c.entries ?? 0} Einträge${space}` };
}

