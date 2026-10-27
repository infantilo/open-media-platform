// Reine Logik des Startdialogs im Node-Katalog des Flow-Editors (ohne DOM, testbar).

export interface StartForm {
  /** Anzeigename (leer = automatisch). */
  name: string;
  /** Zielhost ("" = lokal). */
  hostId: string;
  /** I/O-Port-Richtung für DeckLink-Nodes ("" = nicht zutreffend). */
  ioDirection: "" | "in" | "out";
  /** Eingaben je Option (Schlüssel → Text); leere Felder bedeuten „Standard“. */
  options: Record<string, string>;
}

export interface StartBody {
  type: string;
  version?: string;
  hostId?: string;
  label?: string;
  requiredIoPort?: { cardType: string; direction: string };
  options?: Record<string, string>;
}

/** Nur ausgefüllte Optionen (getrimmt) — der Rest bleibt beim Standard bzw. beim Wert des Node-Typs. */
export function filledOptions(options: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(options)) {
    const t = v.trim();
    if (t !== "") out[k] = t;
  }
  return out;
}

/** Anfragekörper für `POST /api/v1/instances` aus Katalogeintrag und Formular. */
export function buildStartBody(type: string, version: string | undefined, f: StartForm): StartBody {
  const body: StartBody = { type };
  if (version) body.version = version;
  if (f.hostId) body.hostId = f.hostId;
  const name = f.name.trim();
  if (name) body.label = name;
  if (f.ioDirection) body.requiredIoPort = { cardType: "decklink", direction: f.ioDirection };
  const opts = filledOptions(f.options);
  if (Object.keys(opts).length > 0) body.options = opts;
  return body;
}

/** Was ein leeres Feld bedeutet: der für den Node-Typ gespeicherte Wert, sonst der Standard des Nodes. */
export function emptyMeaning(o: { value?: string; default?: string }): { text: string; source: "type" | "default" | "node" } {
  if (o.value) return { text: o.value, source: "type" };
  if (o.default) return { text: o.default, source: "default" };
  return { text: "", source: "node" };
}

/** Lässt der Dialog überhaupt etwas einzustellen übrig (sonst genügt eine Bestätigung)? */
export function needsDialogFields(hasHosts: boolean, optionCount: number, ioPort: boolean): boolean {
  return hasHosts || optionCount > 0 || ioPort;
}
