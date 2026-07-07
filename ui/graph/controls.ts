// Descriptor→Control-Mapping (UMSETZUNG.md B6): reine Zuordnungslogik,
// welches Eingabeelement ein Parameter aus dem Self-Describe-Descriptor
// (docs/descriptor-v0.schema.json, Schritt A8) bekommt. Kein DOM-Zugriff,
// damit sie per `deno test` prüfbar ist — das Bauen der DOM-Elemente
// selbst übernimmt flow-canvas.ts.

export type ParamType = "number" | "boolean" | "enum" | "string";

export interface NumberRange {
  min: number;
  max: number;
}

export interface EnumRange {
  values: string[];
}

export interface ParamSpec {
  name: string;
  type: ParamType | string;
  unit?: string | null;
  range?: NumberRange | EnumRange | null;
  readonly: boolean;
}

export interface MethodArg {
  name: string;
  type: string;
}

export interface MethodSpec {
  name: string;
  args: MethodArg[];
}

export interface Descriptor {
  parameters: ParamSpec[];
  methods: MethodSpec[];
}

export type ControlKind = "slider" | "toggle" | "select" | "text" | "readonly";

/** Welches Steuerelement ein Parameter bekommt: readonly-Parameter immer
 * schreibgeschützt angezeigt (unabhängig vom Typ), sonst nach Typ
 * (number→Slider, boolean→Toggle, enum→Select, string→Textfeld).
 * Unbekannte/zukünftige Typen fallen auf schreibgeschützte Anzeige
 * zurück, statt versehentlich ein falsches Steuerelement anzubieten. */
export function controlKindFor(param: ParamSpec): ControlKind {
  if (param.readonly) return "readonly";
  switch (param.type) {
    case "number":
      return "slider";
    case "boolean":
      return "toggle";
    case "enum":
      return "select";
    case "string":
      return "text";
    default:
      return "readonly";
  }
}

/** Zahlen-Wertebereich eines Parameters, falls vorhanden. */
export function numberRange(param: ParamSpec): NumberRange | null {
  if (param.range && "min" in param.range && "max" in param.range) {
    return param.range;
  }
  return null;
}

/** Erlaubte Werte eines enum-Parameters, falls vorhanden. */
export function enumValues(param: ParamSpec): string[] {
  if (param.range && "values" in param.range) {
    return param.range.values;
  }
  return [];
}
