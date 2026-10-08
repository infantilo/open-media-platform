// Mehrsprachigkeit der Orchestrator-UI (Nutzerauftrag 2026-10-07: Deutsch +
// Englisch). Bewusst ohne Fremdbibliothek (Minimal-Dependency-Regel): ein
// Wörterbuch je Sprache (i18n/de.ts ist die Quelle, i18n/en.ts muss
// dieselben Schlüssel haben — der Typ erzwingt es, i18n_test.ts prüft
// zusätzlich die {Platzhalter}), t() mit Fallback auf Deutsch und dann auf
// den Schlüssel selbst. Die Sprache gilt je Browser (localStorage), der
// Wechsel lädt die Seite neu — Views bauen ihre Texte einmalig auf.
//
// Migration schrittweise: unübersetzte (noch fest verdrahtete) Texte
// bleiben deutsch, nichts bricht. Neue Texte gehören gleich hierher.
import { de } from "./i18n/de.ts";
import { en } from "./i18n/en.ts";

export type Lang = "de" | "en";
export type I18nKey = keyof typeof de;

export const LANGS: { id: Lang; label: string }[] = [
  { id: "de", label: "Deutsch" },
  { id: "en", label: "English" },
];

const DICTS: Record<Lang, Record<string, string>> = { de, en };
const STORAGE_KEY = "omp-lang";

function isLang(v: unknown): v is Lang {
  return v === "de" || v === "en";
}

function detect(): Lang {
  // Ohne DOM (Tests, Tools): Deutsch als Quellsprache, unabhängig von der Rechner-Locale.
  if (typeof document === "undefined") return "de";
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLang(saved)) return saved;
  } catch {
    // kein localStorage — Browsersprache
  }
  try {
    return navigator.language?.toLowerCase().startsWith("de") ? "de" : "en";
  } catch {
    return "de";
  }
}

let current: Lang = detect();

export function getLang(): Lang {
  return current;
}

/** Setzt die Sprache; mit reload=true (Standard) lädt die Seite neu. */
export function setLang(lang: Lang, reload = true): void {
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // nur eine Komfortfunktion
  }
  try {
    document.documentElement.lang = lang;
  } catch {
    // kein DOM (Tests)
  }
  if (reload) {
    try {
      location.reload();
    } catch {
      // kein Browser
    }
  }
}

/** Übersetzt einen Schlüssel; {name} im Text wird aus params ersetzt. */
export function t(key: I18nKey, params?: Record<string, unknown>): string {
  let s = DICTS[current][key] ?? DICTS.de[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/**
 * Module bringen eigene Texte mit (UMSETZUNG.md Kapitel 36.3): `addMessages` ergänzt das Wörterbuch einer Sprache um die
 * Schlüssel des Moduls. Kern-Schlüssel werden nie überschrieben (ein Modul kann dem Kern keine Texte ändern).
 */
export function addMessages(lang: Lang, dict: Record<string, string>): void {
  for (const [k, v] of Object.entries(dict)) if (!(k in DICTS[lang])) DICTS[lang][k] = v;
}

/** Wie [[t]], aber mit beliebigem Schlüssel — für Module, deren Schlüssel nicht im Kern-Wörterbuch stehen. */
export function tLoose(key: string, params?: Record<string, unknown>): string {
  let s = DICTS[current][key] ?? DICTS.de[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** Locale für Datums-/Zeitformatierung passend zur Sprache. */
export function dateLocale(): string {
  return current === "de" ? "de-DE" : "en-GB";
}

/** Kleine Sprachauswahl (DE/EN) für Appbar und Nutzer-Widget. */
export function buildLangSelect(): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.setAttribute("data-role", "lang-select");
  sel.title = t("lang.title");
  sel.setAttribute("aria-label", t("lang.title"));
  sel.style.cssText = "font-size:var(--omp-font-size-xs);padding:2px var(--omp-space-1);";
  for (const l of LANGS) {
    const o = document.createElement("option");
    o.value = l.id;
    o.textContent = l.id.toUpperCase();
    o.title = l.label;
    sel.appendChild(o);
  }
  sel.value = current;
  sel.addEventListener("change", () => setLang(sel.value as Lang));
  return sel;
}

try {
  document.documentElement.lang = current;
} catch {
  // kein DOM (Tests)
}
