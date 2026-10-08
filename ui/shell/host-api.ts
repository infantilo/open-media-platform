// Host-Schnittstelle für Modul-Oberflächen (UMSETZUNG.md Kapitel 36.3): Modul-Bundles sind eigenständige ESM-Dateien und
// dürfen die Singletons der Shell (Sprache/Wörterbuch, Verbindungsüberwachung, Anmeldung) nicht doppelt bündeln. Die Shell
// legt sie deshalb vor dem Laden der Bundles unter `globalThis.__omp` ab; Module greifen über `ui/modules/host.ts` darauf zu.
import { apiFetch } from "./connection.ts";
import { whoami } from "./auth.ts";
import { showToast } from "../kit/omp-toast.ts";
import { addMessages, dateLocale, getLang, tLoose } from "./i18n.ts";

export interface HostApi {
  t: typeof tLoose;
  addMessages: typeof addMessages;
  apiFetch: typeof apiFetch;
  whoami: typeof whoami;
  showToast: typeof showToast;
  dateLocale: typeof dateLocale;
  getLang: typeof getLang;
}

export function exposeHostApi(): void {
  (globalThis as unknown as { __omp: HostApi }).__omp = { t: tLoose, addMessages, apiFetch, whoami, showToast, dateLocale, getLang };
}
