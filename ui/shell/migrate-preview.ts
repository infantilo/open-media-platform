// Umzugsdialog mit Vorschau (Kapitel 108): fragt vor der Bestätigung beim Orchestrator, ob der Umzug Brücken über
// Hostgrenzen bauen muss (oder gar nicht geht), und zeigt das im Bestätigungstext.
import { confirmDialog } from "../kit/omp-confirm.ts";
import { showToast } from "../kit/omp-toast.ts";
import { apiFetch } from "./connection.ts";
import { t } from "./i18n.ts";
import { describePreview, type MigratePreview, type Tr } from "./migrate-preview-logic.ts";

// Die Schlüssel der Vorschau werden zur Laufzeit zusammengesetzt (mig.<medium>), t() kennt nur feste Schlüssel.
const tr: Tr = (k, p) => (t as unknown as (key: string, params?: unknown) => string)(k, p);

/**
 * Fragt die Vorschau ab. blocked = der Orchestrator lehnt den Umzug ab (Grund wurde als Meldung gezeigt);
 * lines = Zeilen für den Bestätigungstext (leer: kein Brückenbau nötig oder Vorschau nicht erreichbar).
 */
export async function previewLines(
  instanceId: string,
  targetHostId: string,
  hostLabel: (id: string) => string,
): Promise<{ blocked: boolean; lines: string[] }> {
  try {
    const res = await apiFetch(`/api/v1/instances/${encodeURIComponent(instanceId)}/migrate-preview?targetHostId=${encodeURIComponent(targetHostId)}`);
    if (res.status === 409) {
      showToast(t("mig.blocked", { p0: (await res.text()).trim() }), { variant: "error", durationMs: 12000 });
      return { blocked: true, lines: [] };
    }
    if (res.ok) return { blocked: false, lines: describePreview((await res.json()) as MigratePreview, hostLabel, tr) };
  } catch {
    // Vorschau optional (älterer Orchestrator, Netz): der Umzug entscheidet selbst
  }
  return { blocked: false, lines: [] };
}

/** Bestätigt einen Umzug mit Vorschau; false = nicht umziehen (abgebrochen oder abgelehnt). */
export async function confirmMigrate(
  instanceId: string,
  targetHostId: string,
  baseMessage: string,
  confirmLabel: string,
  hostLabel: (id: string) => string,
): Promise<boolean> {
  const { blocked, lines } = await previewLines(instanceId, targetHostId, hostLabel);
  if (blocked) return false;
  const text = lines.length ? `${baseMessage}\n\n${lines.join("\n")}` : baseMessage;
  return await confirmDialog(text, { confirmLabel });
}
