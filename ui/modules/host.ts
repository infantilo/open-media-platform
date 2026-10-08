// Zugriff der Modul-Oberflächen auf die Shell (UMSETZUNG.md Kapitel 36.3). Bewusst dünne Funktionen, die erst beim
// Aufruf auf `globalThis.__omp` zugreifen (die Shell setzt es vor dem Laden der Bundles, s. shell/host-api.ts) — so
// bündelt kein Modul eine zweite Kopie von Sprache, Verbindungsüberwachung oder Anmeldung.
type Params = Record<string, unknown>;

interface Host {
  t(key: string, params?: Params): string;
  addMessages(lang: "de" | "en", dict: Record<string, string>): void;
  apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  whoami(): Promise<{ authRequired: boolean; authenticated: boolean; isAdmin?: boolean }>;
  showToast(message: string): void;
  dateLocale(): string;
  getLang(): "de" | "en";
  confirmDialog(message: string, opts?: { confirmLabel?: string }): Promise<boolean>;
}

function host(): Host {
  const h = (globalThis as unknown as { __omp?: Host }).__omp;
  if (!h) throw new Error("Host-Schnittstelle der Shell fehlt (globalThis.__omp)");
  return h;
}

export const t = (key: string, params?: Params): string => host().t(key, params);
export const addMessages = (lang: "de" | "en", dict: Record<string, string>): void => host().addMessages(lang, dict);
export const apiFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => host().apiFetch(input, init);
export const whoami = () => host().whoami();
export const showToast = (message: string): void => host().showToast(message);
export const dateLocale = (): string => host().dateLocale();
export const getLang = (): "de" | "en" => host().getLang();
export const confirmDialog = (message: string, opts?: { confirmLabel?: string }): Promise<boolean> => host().confirmDialog(message, opts);
