// „Letzte Minuten einfrieren“ (UMSETZUNG.md Kap. 72.10): ein Aufruf für alle Stellen der Oberfläche (Kopfleiste, Support-Tab, Node-Diagnose).
import { showToast } from "../kit/omp-toast.ts";
import { apiFetch } from "./connection.ts";
import { t } from "./i18n.ts";
import type { FreezeMeta } from "./support-logic.ts";

/** Friert die letzten `minutes` ein (optional nur für bestimmte Nodes); zeigt Erfolg oder Fehler als Hinweis. */
export async function freezeNow(minutes = 10, note = "", nodeIds: string[] = []): Promise<FreezeMeta | null> {
  try {
    const res = await apiFetch("/api/v1/freezes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minutes, note, nodeIds }),
    });
    if (!res.ok) throw new Error((await res.text()).trim() || `HTTP ${res.status}`);
    const meta = (await res.json()) as FreezeMeta;
    showToast(t("fr.done", { min: meta.windowMinutes }), { variant: "info" });
    return meta;
  } catch (e) {
    showToast(t("fr.failed", { error: String((e as Error).message ?? e) }), { variant: "error" });
    return null;
  }
}
