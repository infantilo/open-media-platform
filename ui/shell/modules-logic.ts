// Reine Logik für Modul-Tabs (UMSETZUNG.md Kapitel 36.3): Manifest von GET /api/v1/modules → Tabs der Hauptleiste.

export interface ModuleUITab {
  id: string;
  placement: string;
  after?: string;
  label: Record<string, string>;
  /** Beschriftung der Admin-Gruppe (nur bei Placement "admin:<gruppe>"). */
  group?: Record<string, string>;
  element: string;
  bundle: string;
}

export interface ModuleInfo {
  name: string;
  state: "registered" | "mounted" | "disabled" | "failed";
  error?: string;
  ui?: ModuleUITab[];
}

/** Ein Tab der Hauptleiste, der aus einem Modul stammt. */
export interface ModuleTab {
  /** Eindeutige Tab-ID: `mod:<modul>:<tab>` (kollidiert nie mit Kern-Tabs). */
  id: string;
  module: string;
  label: string;
  element: string;
  bundle: string;
  after?: string;
}

/** Beschriftung in der Sprache; fehlt sie: Deutsch, dann die Tab-ID. */
export function pickLabel(label: Record<string, string> | undefined, lang: string, fallback: string): string {
  return label?.[lang] || label?.de || fallback;
}

/**
 * Tabs der Hauptleiste aus dem Manifest. Nur gemountete Module zählen (deaktivierte/fehlgeschlagene tragen keine
 * Oberfläche bei); Placements außer "main" werden ignoriert (Admin-Untertabs kommen mit 36.7). Ungültige Einträge
 * (ohne Element oder Bundle) werden übersprungen statt die Leiste zu stören.
 */
export function mainTabs(modules: ModuleInfo[], lang: string): ModuleTab[] {
  const out: ModuleTab[] = [];
  for (const m of modules) {
    if (m.state !== "mounted") continue;
    for (const u of m.ui ?? []) {
      if (u.placement !== "main" || !u.element || !u.bundle) continue;
      out.push({ id: `mod:${m.name}:${u.id}`, module: m.name, label: pickLabel(u.label, lang, u.id), element: u.element, bundle: u.bundle, after: u.after });
    }
  }
  return out;
}

/**
 * Einfügeposition in die vorhandene Tab-Reihenfolge: hinter `after`, sonst ans Ende — aber **vor** dem Administration-Tab.
 * Gibt den Index zurück, vor dem eingefügt wird.
 */
export function insertIndex(existingIds: string[], after: string | undefined): number {
  if (after) {
    const i = existingIds.indexOf(after);
    if (i >= 0) return i + 1;
  }
  const admin = existingIds.indexOf("admin");
  return admin >= 0 ? admin : existingIds.length;
}

/** Ein Untertab der Administration, der aus einem Modul stammt. */
export interface AdminModuleTab {
  id: string;
  module: string;
  label: string;
  element: string;
  bundle: string;
}

export interface AdminModuleGroup {
  id: string;
  label: string;
  tabs: AdminModuleTab[];
}

/**
 * Admin-Untertabs aus dem Manifest, nach Gruppe zusammengefasst (Placement `admin:<gruppe>`). Nur gemountete Module zählen; die
 * Gruppenbeschriftung stammt vom ersten Tab, der eine liefert (sonst die Gruppen-ID). Reihenfolge = Reihenfolge im Manifest.
 */
export function adminGroups(modules: ModuleInfo[], lang: string): AdminModuleGroup[] {
  const groups = new Map<string, AdminModuleGroup>();
  for (const m of modules) {
    if (m.state !== "mounted") continue;
    for (const u of m.ui ?? []) {
      if (!u.placement.startsWith("admin:") || !u.element || !u.bundle) continue;
      const gid = u.placement.slice("admin:".length);
      if (!gid) continue;
      let g = groups.get(gid);
      if (!g) {
        g = { id: gid, label: gid, tabs: [] };
        groups.set(gid, g);
      }
      if (u.group && g.label === gid) g.label = pickLabel(u.group, lang, gid);
      g.tabs.push({ id: `mod:${m.name}:${u.id}`, module: m.name, label: pickLabel(u.label, lang, u.id), element: u.element, bundle: u.bundle });
    }
  }
  return [...groups.values()];
}
