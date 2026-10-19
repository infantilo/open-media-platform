// Funktionsrechte im Rechte-Editor (Kapitel 44): Katalog der Module, Vergaben je Nutzer/Gruppe, Umschalten.
import { featureMatches } from "../kit/features.ts";

export interface FeatureDef {
  id: string;
  label: Record<string, string>;
  description?: Record<string, string>;
  group?: Record<string, string>;
}

export interface FeatureGrant {
  id: string;
  subjectType: "user" | "group";
  subject: string;
  feature: string;
}

export interface FeatureSection {
  /** Modulpräfix (`ingest`), wird für „alle Rechte des Moduls“ (`ingest.*`) gebraucht. */
  module: string;
  title: string;
  items: FeatureDef[];
}

function pick(m: Record<string, string> | undefined, lang: string, fallback: string): string {
  return m?.[lang] || m?.de || fallback;
}

/** Katalog nach Modul gruppiert; Reihenfolge wie geliefert. */
export function sectionsOf(defs: FeatureDef[], lang: string): FeatureSection[] {
  const out: FeatureSection[] = [];
  for (const d of defs) {
    const module = d.id.split(".")[0];
    let s = out.find((x) => x.module === module);
    if (!s) {
      s = { module, title: pick(d.group, lang, module), items: [] };
      out.push(s);
    }
    s.items.push(d);
  }
  return out;
}

export function grantsOf(grants: FeatureGrant[], type: "user" | "group", id: string): FeatureGrant[] {
  return grants.filter((g) => g.subjectType === type && g.subject === id);
}

/** Die Vergabe (eigene oder Muster), die `feature` abdeckt. */
export function coveringGrant(own: FeatureGrant[], feature: string): FeatureGrant | undefined {
  return own.find((g) => g.feature === feature) ?? own.find((g) => featureMatches(g.feature, feature));
}

export interface TogglePlan {
  /** Neu anzulegende Vergabe (Funktion oder `modul.*`). */
  create?: string;
  deleteIds: string[];
}

/**
 * Schaltet ein einzelnes Recht um. Ausschalten entfernt die genau passende Vergabe; ist das Recht nur durch ein Muster
 * (`modul.*`) gedeckt, ist es hier nicht einzeln abwählbar (leerer Plan) — das Muster wird am Modulkopf entfernt.
 */
export function planToggle(own: FeatureGrant[], feature: string, on: boolean): TogglePlan {
  const exact = own.find((g) => g.feature === feature);
  if (on) return exact || coveringGrant(own, feature) ? { deleteIds: [] } : { create: feature, deleteIds: [] };
  return exact ? { deleteIds: [exact.id] } : { deleteIds: [] };
}

/** Schaltet alle Rechte eines Moduls um: an = `modul.*` anlegen und die Einzelvergaben ersetzen, aus = alles des Moduls entfernen. */
export function planToggleModule(own: FeatureGrant[], module: string, on: boolean): TogglePlan {
  const mine = own.filter((g) => g.feature === `${module}.*` || g.feature.startsWith(`${module}.`));
  if (on) {
    const hasPattern = mine.some((g) => g.feature === `${module}.*`);
    return { create: hasPattern ? undefined : `${module}.*`, deleteIds: mine.filter((g) => g.feature !== `${module}.*`).map((g) => g.id) };
  }
  return { deleteIds: mine.map((g) => g.id) };
}
