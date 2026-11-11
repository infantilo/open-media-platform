// Tastenbelegung des Pults (Kap. 93): die festen Funktionstasten (Transport, Cursor, Solo …), das Funktionstastenfeld F1–F8 in
// umschaltbaren Seiten und das Jog-Rad. Reine Daten + Prüfung; die Wirkung steckt in surface-logic.ts. Rust-Gegenstück: keys.rs.
//
// Dynamisch heißt: `{ch}` in Methode/Argumenten steht für den **gewählten Kanal**, die LED einer Taste folgt dem Zustand dieses Kanals
// (Pfad im `mixState`-Eintrag, z. B. `proc.phaseInvert`), die Reihe der acht Ansichtstasten (MIDI Tracks … User) schaltet die Seite.

export type KeyAction = "toggle" | "momentary" | "call" | "internal";

export type InternalAction = "clearPfl" | "clearMute" | "selectPrev" | "selectNext" | "gainUp" | "gainDown" | "deselect" | "jogMode";

export interface KeyBinding {
  /** Kurztext für die Anzeige des Pults (ASCII, wird beim Drücken kurz eingeblendet). */
  label?: string;
  action: KeyAction;
  internal?: InternalAction;
  /** Ziel-Node (Anzeigename); leer = der Audiomischer. */
  node?: string;
  method?: string;
  args?: Record<string, unknown>;
  /** Name des Arguments, das den Wert (an/aus) bekommt. */
  arg?: string;
  onValue?: unknown;
  offValue?: unknown;
  /** LED/Zustand: Punkt-Pfad im Mischer-Eintrag des gewählten Kanals (z. B. `mute`, `proc.eqBypass`); `equals` vergleicht statt „wahr“. */
  led?: string | { path: string; equals?: unknown };
}

export type JogMode =
  | { name?: string; kind: "gain" }
  | { name?: string; kind: "select" }
  | { name?: string; kind: "nudge"; node?: string; method: string; args?: Record<string, unknown>; arg: string; readParam: string; step?: number; min?: number; max?: number };

export interface KeysConfig {
  /** Seiten des Funktionstastenfelds; Seite n wählt die n-te Ansichtstaste. */
  pages?: { name: string; keys: Record<string, KeyBinding> }[];
  /** Belegung unabhängig von der Seite (gilt, wenn die Seite die Taste nicht belegt). */
  global?: Record<string, KeyBinding>;
  /** Jog-Modi; die Taste „Scrub“ schaltet weiter. */
  jog?: JogMode[];
}

/** Ansichtstasten, die die Seite wählen (Reihe über den Schaltern, links nach rechts). */
export const PAGE_KEYS = ["midiTracks", "inputs", "audioTracks", "audioInstruments", "aux", "busses", "outputs", "user"] as const;

const T = (method: string, arg: string, led: string, label: string): KeyBinding => ({ label, action: "toggle", method: `channel.{ch}.${method}`, arg, led });

/** Standardseite „Kanal“: F1–F8 wirken auf den gewählten Kanal. */
export const DEFAULT_PAGE: { name: string; keys: Record<string, KeyBinding> } = {
  name: "Kanal",
  keys: {
    f1: T("setMute", "muted", "mute", "Mute"),
    f2: T("setPfl", "enabled", "pfl", "PFL"),
    f3: T("setPhase", "invert", "proc.phaseInvert", "Phase"),
    f4: T("setEqBypass", "bypass", "proc.eqBypass", "EQ byp"),
    f5: T("setComp", "enabled", "proc.compEnabled", "Comp"),
    f6: T("setGate", "enabled", "proc.gateEnabled", "Gate"),
    f7: T("setMainRoute", "routed", "mainRoute", "Main"),
    f8: { label: "Mute clr", action: "internal", internal: "clearMute" },
  },
};

/** Festbelegung der übrigen Tasten (Audiomischer-Kontext). Transport u. a. bleiben frei und gehen als Ereignis hinaus. */
export const DEFAULT_GLOBAL: Record<string, KeyBinding> = {
  soloGlobal: { label: "PFL clr", action: "internal", internal: "clearPfl" },
  left: { label: "Sel <", action: "internal", internal: "selectPrev" },
  right: { label: "Sel >", action: "internal", internal: "selectNext" },
  up: { label: "Gain +1", action: "internal", internal: "gainUp" },
  down: { label: "Gain -1", action: "internal", internal: "gainDown" },
  cancel: { label: "Desel", action: "internal", internal: "deselect" },
  scrub: { label: "Jog", action: "internal", internal: "jogMode" },
};

export const DEFAULT_JOG: JogMode[] = [{ name: "Gain", kind: "gain" }, { name: "Select", kind: "select" }];

export interface ResolvedKeys {
  pages: { name: string; keys: Record<string, KeyBinding> }[];
  global: Record<string, KeyBinding>;
  jog: JogMode[];
}

/** Konfiguration mit Standardwerten zusammenführen: konfigurierte Seiten ersetzen die Standardseite Stück für Stück. */
export function resolveKeys(c?: KeysConfig | null): ResolvedKeys {
  const pages = [DEFAULT_PAGE, ...(c?.pages ?? []).slice(1)];
  if (c?.pages?.[0]) pages[0] = c.pages[0];
  return { pages: pages.slice(0, PAGE_KEYS.length), global: { ...DEFAULT_GLOBAL, ...(c?.global ?? {}) }, jog: c?.jog?.length ? c.jog : DEFAULT_JOG };
}

export function ledPath(b: KeyBinding): { path: string; equals?: unknown } | null {
  if (!b.led) return null;
  return typeof b.led === "string" ? { path: b.led } : b.led;
}

/** Wert unter einem Punkt-Pfad (`proc.phaseInvert`). */
export function getPath(o: unknown, path: string): unknown {
  let cur: unknown = o;
  for (const p of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function setPath(o: Record<string, unknown>, path: string, v: unknown) {
  const parts = path.split(".");
  let cur = o;
  for (const p of parts.slice(0, -1)) {
    if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = v;
}

/** `{ch}` durch die Kanal-ID ersetzen (in Text und verschachtelten Zeichenketten). */
export function fillTemplate<T>(v: T, ch: string): T {
  if (typeof v === "string") return v.split("{ch}").join(ch) as T;
  if (Array.isArray(v)) return v.map((x) => fillTemplate(x, ch)) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillTemplate(x, ch)])) as T;
  return v;
}

export const usesChannel = (b: KeyBinding): boolean => JSON.stringify([b.method, b.args, b.arg]).includes("{ch}");

const INTERNALS: InternalAction[] = ["clearPfl", "clearMute", "selectPrev", "selectNext", "gainUp", "gainDown", "deselect", "jogMode"];

export function validateKeys(c: unknown, knownKeys: (n: string) => boolean): string[] {
  const errs: string[] = [];
  if (c === null || c === undefined) return errs;
  const o = c as KeysConfig;
  if (typeof o !== "object") return ["keys ist kein Objekt"];
  const bind = (w: string, name: string, b: KeyBinding) => {
    if (!knownKeys(name)) errs.push(`${w}: Taste „${name}“ unbekannt`);
    if (!b || !["toggle", "momentary", "call", "internal"].includes(b.action)) return errs.push(`${w}.${name}: action muss toggle, momentary, call oder internal sein`);
    if (b.action === "internal") {
      if (!b.internal || !INTERNALS.includes(b.internal)) errs.push(`${w}.${name}: internal unbekannt (${INTERNALS.join(", ")})`);
    } else if (!b.method) errs.push(`${w}.${name}: method fehlt`);
    if ((b.action === "toggle" || b.action === "momentary") && b.method && !b.arg) errs.push(`${w}.${name}: arg fehlt (Name des Arguments für an/aus)`);
  };
  if (o.pages !== undefined) {
    if (!Array.isArray(o.pages)) errs.push("pages muss eine Liste sein");
    else {
      if (o.pages.length > PAGE_KEYS.length) errs.push(`höchstens ${PAGE_KEYS.length} Seiten`);
      o.pages.forEach((p, i) => {
        if (!p || typeof p.name !== "string" || !p.name) errs.push(`pages[${i}]: name fehlt`);
        for (const [k, b] of Object.entries(p?.keys ?? {})) bind(`pages[${i}]`, k, b);
      });
    }
  }
  for (const [k, b] of Object.entries(o.global ?? {})) bind("global", k, b);
  if (o.jog !== undefined) {
    if (!Array.isArray(o.jog) || !o.jog.length) errs.push("jog muss eine nicht leere Liste sein");
    else o.jog.forEach((j, i) => {
      if (!j || !["gain", "select", "nudge"].includes(j.kind)) errs.push(`jog[${i}]: kind muss gain, select oder nudge sein`);
      else if (j.kind === "nudge" && (!j.method || !j.arg || !j.readParam)) errs.push(`jog[${i}]: nudge braucht method, arg und readParam`);
    });
  }
  return errs;
}
