// Fragt vor Marker und Freeze nach einer optionalen Notiz. OK/Enter ohne Text setzt trotzdem (schneller Weg wie bisher);
// Abbrechen/Escape bricht ab. Rückgabe: Notiz ("" = keine) oder null bei Abbruch.
import { promptDialog } from "../kit/omp-prompt.ts";
import { t } from "./i18n.ts";
import { limitNote } from "./note-logic.ts";

export async function askNote(kind: "marker" | "freeze"): Promise<string | null> {
  const text = await promptDialog(t(kind === "marker" ? "note.marker" : "note.freeze"), {
    okLabel: t(kind === "marker" ? "note.markerOk" : "note.freezeOk"),
  });
  return text === null ? null : limitNote(text);
}
