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
 * Fragt die Vorschau ab und bestätigt den Umzug mit dem Nutzer. false = nicht umziehen (abgebrochen oder vom
 * Orchestrator abgelehnt, die Ablehnung wird mit Grund gemeldet). Ist die Vorschau nicht erreichbar (älterer
 * Orchestrator, Netz), gilt der einfache Bestätigungstext und der Umzug entscheidet selbst.
 */
export async function confirmMigrate(
  instanceId: string,
  targetHostId: string,
  baseMessage: string,
  confirmLabel: string,
  hostLabel: (id: string) => string,
): Promise<boolean> {
  let lines: string[] = [];
  try {
    const res = await apiFetch(`/api/v1/instances/${encodeURIComponent(instanceId)}/migrate-preview?targetHostId=${encodeURIComponent(targetHostId)}`);
    if (res.status === 409) {
      showToast(t("mig.blocked", { p0: (await res.text()).trim() }), { variant: "error", durationMs: 12000 });
      return false;
    }
    if (res.ok) lines = describePreview((await res.json()) as MigratePreview, hostLabel, tr);
  } catch {
    // Vorschau optional
  }
  const text = lines.length ? `${baseMessage}\n\n${lines.join("\n")}` : baseMessage;
  return await confirmDialog(text, { confirmLabel });
}
