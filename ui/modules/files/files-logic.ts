// Reine Logik des Dateien-Moduls (Kapitel 86): Formatierung, Pfade, Bewertung der Lösch-Vorschau.

/** Bytes lesbar (1024er-Stufen). */
export function fmtBytes(n: number | undefined | null): string {
  if (n === undefined || n === null || !isFinite(n)) return "–";
  let f = n;
  for (const u of ["B", "KB", "MB", "GB", "TB"]) {
    if (f < 1024 || u === "TB") return `${u === "B" ? f.toFixed(0) : f.toFixed(1)} ${u}`;
    f /= 1024;
  }
  return "";
}

/** Brotkrumen eines wurzelrelativen Pfads: [{name, path}] ab der Wurzel. */
export function crumbs(path: string): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  let acc = "";
  for (const seg of path.split("/").filter(Boolean)) {
    acc = acc ? `${acc}/${seg}` : seg;
    out.push({ name: seg, path: acc });
  }
  return out;
}

/** Ordner über dem Pfad ("" = Wurzel). */
export function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Pfad + Name (relativ). */
export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export interface PlanItem { rel: string; status: string; error?: string; derived?: boolean; rootName?: string }
export interface Plan { items: PlanItem[]; blocked: boolean; needsForce: boolean; needsConfirm: boolean }

export type DeleteMode = "blocked" | "force" | "confirm" | "ok";

/** Wie weit darf die Person löschen? blocked: nie; force: nur mit Erzwingen+Begründung; confirm: Hinweise bestätigen; ok. */
export function deleteMode(p: Plan): DeleteMode {
  if (p.blocked) return "blocked";
  if (p.needsForce) return "force";
  if (p.needsConfirm) return "confirm";
  return "ok";
}

/** Kann der Löschen-Knopf mit dem aktuellen Eingabestand gedrückt werden? */
export function canSubmitDelete(p: Plan, o: { confirm: boolean; force: boolean; reason: string; canForce: boolean }): boolean {
  switch (deleteMode(p)) {
    case "blocked": return false;
    case "force": return o.canForce && o.force && o.reason.trim().length >= 5;
    case "confirm": return o.confirm;
    default: return p.items.length > 0;
  }
}

/** Freier Platz in Prozent (0–100) oder null. */
export function freePercent(free?: number, total?: number): number | null {
  if (free === undefined || total === undefined || total <= 0) return null;
  return Math.max(0, Math.min(100, (free / total) * 100));
}

/** Verbleibende Zeit bis zum endgültigen Löschen aus dem Papierkorb (ms → "3 T 4 h" / "abgelaufen"). */
export function remaining(expiresMs: number, nowMs: number): string {
  const d = expiresMs - nowMs;
  if (d <= 0) return "0";
  const h = Math.floor(d / 3_600_000);
  if (h >= 48) return `${Math.floor(h / 24)} d`;
  if (h >= 1) return `${h} h`;
  return `${Math.max(1, Math.floor(d / 60_000))} min`;
}
