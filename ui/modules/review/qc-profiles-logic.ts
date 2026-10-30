// Logik der Admin-Ansicht „QC-Profile“ (ohne DOM).
import type { Cfg } from "./settings-logic.ts";

export interface QcProfile extends Cfg {
  id: string;
  version: number;
  name: string;
}

/** Kennung für ein neues Profil aus dem Namen; kollisionsfrei, nur Kleinbuchstaben/Ziffern/Bindestrich, höchstens 40 Zeichen. */
export function newProfileId(name: string, existing: string[]): string {
  const slug = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const base = slug.slice(0, 36).replace(/-+$/g, "") || "profil";
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let i = 2;; i++) {
    const c = `${base}-${i}`;
    if (!taken.has(c)) return c;
  }
}

/** Kopie als Ausgangspunkt eines neuen Profils: eigene Kennung und Name, Version 1. */
export function cloneProfile(src: QcProfile, name: string, existing: string[]): QcProfile {
  const copy = JSON.parse(JSON.stringify(src)) as QcProfile;
  copy.name = name;
  copy.id = newProfileId(name, existing);
  copy.version = 1;
  return copy;
}

/** Kurzfassung der Erwartungen an die Datei für die Liste, z. B. „1920×1080 · 25/1 · mxf · ≥ 8 Tonspuren“. */
export function describeExpect(p: QcProfile, words: { tracks: string; none: string; captions: string }): string {
  const e = (p.expect ?? {}) as Cfg;
  const parts: string[] = [];
  if (e.width || e.height) parts.push(`${e.width || "?"}×${e.height || "?"}`);
  if (e.frameRate) parts.push(String(e.frameRate));
  if (e.fieldOrder && e.fieldOrder !== "any") parts.push(String(e.fieldOrder));
  if (e.videoCodecs?.length) parts.push((e.videoCodecs as string[]).join("/"));
  if (e.container) parts.push(String(e.container));
  if (e.audioTracks) parts.push(`≥ ${e.audioTracks} ${words.tracks}`);
  if (e.sampleRate) parts.push(`${e.sampleRate} Hz`);
  if (e.captions) parts.push(words.captions);
  return parts.length ? parts.join(" · ") : words.none;
}

/** Kurzfassung der Lautheit: „−23 LUFS ±1/±3 LU, ≤ −1 dBTP“ oder leer, wenn aus. */
export function describeLoudness(p: QcProfile): string {
  const l = (p.loudness ?? {}) as Cfg;
  if (!l.enabled) return "";
  const n = (v: number) => String(v).replace("-", "−");
  let s = `${n(l.targetLufs)} LUFS ±${l.warnToleranceLu}/±${l.failToleranceLu} LU`;
  if (l.maxTruePeakDbtp !== undefined) s += `, ≤ ${n(l.maxTruePeakDbtp)} dBTP`;
  return s;
}

/** Name vorhanden und Kennung gültig — mehr prüft der Server. */
export function canSaveProfile(name: string, id: string, isNew: boolean): string | null {
  if (!name.trim()) return "name";
  if (isNew && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) return "id";
  return null;
}
