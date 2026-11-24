// Host-Schnittstelle für Modul-Oberflächen (UMSETZUNG.md Kapitel 36.3): Modul-Bundles sind eigenständige ESM-Dateien und
// dürfen die Singletons der Shell (Sprache/Wörterbuch, Verbindungsüberwachung, Anmeldung) nicht doppelt bündeln. Die Shell
// legt sie deshalb vor dem Laden der Bundles unter `globalThis.__omp` ab; Module greifen über `ui/modules/host.ts` darauf zu.
import { apiFetch } from "./connection.ts";
import { getToken, whoami } from "./auth.ts";
import { showToast } from "../kit/omp-toast.ts";
import { addMessages, dateLocale, getLang, tLoose } from "./i18n.ts";
import { confirmDialog } from "../kit/omp-confirm.ts";
import { getDirectory, getMyFeatures } from "./features-api.ts";
import { deckSession } from "./streamdeck/session.ts";

export interface HostApi {
  t: typeof tLoose;
  addMessages: typeof addMessages;
  apiFetch: typeof apiFetch;
  whoami: typeof whoami;
  showToast: typeof showToast;
  dateLocale: typeof dateLocale;
  getLang: typeof getLang;
  confirmDialog: typeof confirmDialog;
  /** Sitzungstoken für Medien-URLs (<video>/<img> können keinen Authorization-Header senden, Kapitel 43). */
  authToken: typeof getToken;
  /** Funktionsrechte der angemeldeten Person (Kapitel 44). */
  features: typeof getMyFeatures;
  /** Nutzer und Gruppen zum Zuweisen. */
  directory: typeof getDirectory;
  /** Stream Deck: eine Modul-Ansicht meldet sich als Tab am Gerät an (Adapter nach Elementname, s. streamdeck/adapters/index.ts). */
  deckTab: { register(id: string, label: string, el: HTMLElement): void; unregister(id: string): void };
}

export function exposeHostApi(): void {
  (globalThis as unknown as { __omp: HostApi }).__omp = { t: tLoose, addMessages, apiFetch, whoami, showToast, dateLocale, getLang, confirmDialog, authToken: getToken, features: getMyFeatures, directory: getDirectory, deckTab: { register: (id, label, el) => deckSession.registerTab(id, label, el, id), unregister: (id) => deckSession.unregisterTab(id) } };
}
