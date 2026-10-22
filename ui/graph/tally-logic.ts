// Tally je Geber (Kapitel 51): eine Quelle kann von mehreren Gebern (z. B. zwei Bildmischern) gleichzeitig auf Sendung
// geschaltet sein. Sie zeigt „on“, solange mindestens ein Geber „on“ gemeldet hat; Ereignisse ohne Geber (ältere Publisher)
// zählen als ein gemeinsamer, namenloser Geber. Gegenstück zu `omp_node_sdk::health::TallyBoard` (Rust).

export class TallyBoard {
  #givers = new Map<string, Set<string>>();

  /** Übernimmt ein Ereignis; `true`, wenn sich der Gesamtzustand der Quelle geändert hat. */
  apply(target: string, on: boolean, src?: string | null): boolean {
    const was = this.isOn(target);
    const giver = src ?? "";
    let set = this.#givers.get(target);
    if (on) {
      if (!set) this.#givers.set(target, (set = new Set()));
      set.add(giver);
    } else if (set) {
      set.delete(giver);
      if (set.size === 0) this.#givers.delete(target);
    }
    return this.isOn(target) !== was;
  }

  isOn(target: string): boolean {
    return (this.#givers.get(target)?.size ?? 0) > 0;
  }

  /** Geber (Node-IDs, `""` = unbekannt), die die Quelle gerade auf Sendung haben, sortiert. */
  givers(target: string): string[] {
    return [...(this.#givers.get(target) ?? [])].sort();
  }

  /** Ein Geber ist verschwunden: alle seine Einträge entfernen; liefert true, wenn sich dadurch etwas geändert hat. */
  dropGiver(giver: string): boolean {
    let changed = false;
    for (const [target, set] of this.#givers) {
      if (set.delete(giver)) {
        changed = true;
        if (set.size === 0) this.#givers.delete(target);
      }
    }
    return changed;
  }
}

/** Beschriftung für die Kachel: „PGM“ bzw. „PGM ×2“ und die Namen der Geber (Tooltip). */
export function tallyLabel(givers: string[], nameOf: (id: string) => string | undefined): { badge: string; tooltip: string } {
  const names = givers.map((g) => (g === "" ? "?" : nameOf(g) ?? g.slice(0, 8)));
  return { badge: givers.length > 1 ? `PGM ×${givers.length}` : "PGM", tooltip: names.join(", ") };
}
