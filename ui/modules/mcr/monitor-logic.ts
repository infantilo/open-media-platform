// Überwachung einfach (106.15c): Profil → Reglerwerte, „angepasst“-Erkennung. Werte spiegeln monitor_profiles.json des Scope.
export const PROFILES = ["", "standard", "strict", "off"] as const;
/** Einfach-Regler: Prüfung → Dauer (s) je Profil, bis ein Alarm entsteht. */
export const SIMPLE_CHECKS = ["black", "freeze", "silence"] as const;
export type SimpleCheck = typeof SIMPLE_CHECKS[number];
const HOLD: Record<string, Record<SimpleCheck, number>> = {
  standard: { black: 3, freeze: 5, silence: 5 },
  strict: { black: 1, freeze: 2, silence: 2 },
};

/** Dauer, die das Profil vorgibt (leeres Profil = Voreinstellung = standard); null bei „off“. */
export function profileHold(profile: string, check: SimpleCheck): number | null {
  const p = profile || "standard";
  if (p === "off") return null;
  return (HOLD[p] ?? HOLD.standard)[check];
}

/** Wirksame Dauer: Abweichung, sonst Profilwert. */
export function effectiveHold(profile: string, overrides: Record<string, unknown>, check: SimpleCheck): number | null {
  const o = overrides[`${check}.holdSeconds`];
  return typeof o === "number" ? o : profileHold(profile, check);
}

/** Setzt die Dauer; entspricht sie dem Profil, entfällt die Abweichung. */
export function withHold(profile: string, overrides: Record<string, unknown>, check: SimpleCheck, seconds: number): Record<string, unknown> {
  const out = { ...overrides };
  if (seconds === profileHold(profile, check)) delete out[`${check}.holdSeconds`];
  else out[`${check}.holdSeconds`] = seconds;
  return out;
}

/** „angepasst“: das Profil wird durch mindestens eine Abweichung verändert (bei „off“ zählt nichts). */
export function isCustomized(profile: string, overrides: Record<string, unknown>): boolean {
  return profile !== "off" && Object.keys(overrides).length > 0;
}
