// Suche nach Nodes im Flow-Editor: reine Logik (ohne DOM), damit testbar.
import { breadcrumbPath, type GroupTree } from "./groups.ts";

export interface SearchableNode {
  id: string;
  label: string;
  health?: string;
}

export interface NodeSearchHit {
  id: string;
  label: string;
  /** Gruppe, in der der Node liegt (null = oberste Ebene). */
  groupId: string | null;
  /** Anzeigepfad der Gruppe, z. B. "Regie 1 › Kameras"; leer am Root. */
  groupPath: string;
}

/** Gruppe, die den Node direkt enthält; null, wenn er in keiner Gruppe liegt. */
export function groupOfNode(tree: GroupTree, nodeId: string): string | null {
  for (const g of Object.values(tree.groups)) {
    if (g.nodeIds.includes(nodeId)) return g.id;
  }
  return null;
}

/** Groß-/Kleinschreibung egal; alle durch Leerzeichen getrennten Wörter müssen im Namen (ab 6 Zeichen auch in der ID) vorkommen.
 * Treffer, die mit dem Suchtext beginnen, stehen vor Treffern in der Mitte, danach alphabetisch. */
export function searchNodes(nodes: SearchableNode[], tree: GroupTree, query: string, limit = 12): NodeSearchHit[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];
  const scored: { hit: NodeSearchHit; rank: number }[] = [];
  for (const n of nodes) {
    const label = n.label.toLowerCase();
    const id = n.id.toLowerCase();
    // IDs sind UUIDs: erst ab 6 Zeichen mitsuchen, sonst träfe jede Ziffer zufällig
    if (!words.every((w) => label.includes(w) || (w.length >= 6 && id.includes(w)))) continue;
    const groupId = groupOfNode(tree, n.id);
    const groupPath = groupId ? breadcrumbPath(tree, groupId).map((g) => g.label).join(" › ") : "";
    scored.push({ hit: { id: n.id, label: n.label, groupId, groupPath }, rank: label.startsWith(words[0]) ? 0 : 1 });
  }
  scored.sort((a, b) => a.rank - b.rank || a.hit.label.localeCompare(b.hit.label, "de"));
  return scored.slice(0, limit).map((s) => s.hit);
}
