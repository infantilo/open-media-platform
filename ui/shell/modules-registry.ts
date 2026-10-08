// Gemeinsamer Zugriff der Shell auf das Modul-Manifest und die Modul-Bundles (UMSETZUNG.md Kapitel 36.3/36.7): das Manifest wird
// einmal geladen, jedes Bundle höchstens einmal importiert (Hauptleiste und Administration teilen sich beides).
import { apiFetch } from "./connection.ts";
import { exposeHostApi } from "./host-api.ts";
import type { ModuleInfo } from "./modules-logic.ts";

let manifest: Promise<ModuleInfo[]> | null = null;
const bundles = new Map<string, Promise<string | null>>();

/** Manifest von GET /api/v1/modules (leer, wenn nicht erreichbar). `force` lädt neu. */
export function getModules(force = false): Promise<ModuleInfo[]> {
  if (!manifest || force) {
    exposeHostApi();
    manifest = (async () => {
      try {
        const res = await apiFetch("/api/v1/modules");
        return res.ok ? ((await res.json()) as ModuleInfo[]) : [];
      } catch {
        return [];
      }
    })();
  }
  return manifest;
}

/** Lädt ein Modul-Bundle (einmal). Rückgabe: Fehlermeldung oder null bei Erfolg. */
export function ensureBundle(url: string): Promise<string | null> {
  let p = bundles.get(url);
  if (!p) {
    exposeHostApi();
    p = import(/* webpackIgnore: true */ url).then(
      () => null,
      (e) => {
        console.warn(`module bundle ${url} failed to load`, e);
        return String(e);
      },
    );
    bundles.set(url, p);
  }
  return p;
}
