// Test-Hilfe für Modul-Oberflächen (Kapitel 36.3/36.7): installiert eine minimale Host-Schnittstelle (`globalThis.__omp`) mit den
// echten Singletons der Shell (Sprache/Wörterbuch) und den Texten des Moduls — so laufen Modul-Tests ohne Browser und ohne Shell.
import { addMessages, getLang, setLang, tLoose, dateLocale } from "../shell/i18n.ts";

export function installHost(messages: Record<"de" | "en", Record<string, string>>, lang: "de" | "en" = "de"): void {
  setLang(lang, false);
  addMessages("de", messages.de);
  addMessages("en", messages.en);
  (globalThis as unknown as { __omp: unknown }).__omp = {
    t: tLoose,
    addMessages,
    getLang,
    dateLocale,
    apiFetch: () => Promise.reject(new Error("apiFetch ist im Test nicht verfügbar")),
    whoami: () => Promise.resolve({ authRequired: false, authenticated: false }),
    showToast: () => {},
    confirmDialog: () => Promise.resolve(true),
  };
}
