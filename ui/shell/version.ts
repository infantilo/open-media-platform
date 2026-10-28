import { t } from "./i18n.ts";
// Firmware-/Build-Stempel des Orchestrators (GET /api/v1/version, öffentlich —
// auch vor der Anmeldung lesbar). Wird im Login-Bildschirm und im Admin-Bereich
// „System-Update“ angezeigt.

export interface BuildInfo {
  version: string;
  commit?: string;
  builtAt?: string;
  /** Release, auf dem der Stand aufbaut: „v0.7.0“ oder „v0.7.0+31“ (31 Änderungen danach). */
  release?: string;
}

/** „Entwicklungsstand“, bei bekanntem Release „Entwicklungsstand nach v0.7.0 (+31)“; genau auf dem Tag: nur das Release. */
export function devLabel(release?: string): string {
  const m = /^(.+?)\+(\d+)$/.exec(release ?? "");
  if (!release) return t("ver.a4394c");
  if (!m) return release;
  return t("ver.afterRelease", { p0: m[1], p1: m[2] });
}

/** Kurzform für den Login-Fuß, z. B. „Firmware 2026.10.0 (abc1234)“. */
export function formatFirmware(info: BuildInfo | null | undefined): string {
  if (!info || !info.version) return "";
  // „dev“ = ohne Release-Stempel gebaut (Entwicklungsstand) — mit Hinweis, auf welchem Release er aufbaut.
  const v = info.version === "dev" ? devLabel(info.release) : info.version;
  const commit = info.commit ? ` (${info.commit.slice(0, 7)})` : "";
  return t("ver.f7c666", { p0: v, p1: commit });
}

/** Ausführliche Form für Admin/System-Update, inkl. Bauzeitpunkt. */
export function formatFirmwareLong(info: BuildInfo | null | undefined): string {
  const short = formatFirmware(info);
  if (!short) return "";
  return info?.builtAt ? `${short}, gebaut ${info.builtAt}` : short;
}

/** Liest den Stempel; `null` bei Fehler (Anzeige bleibt dann einfach leer). */
export async function fetchBuildInfo(): Promise<BuildInfo | null> {
  try {
    const res = await fetch("/api/v1/version");
    if (!res.ok) return null;
    const j = await res.json();
    return typeof j?.version === "string" ? (j as BuildInfo) : null;
  } catch {
    return null;
  }
}
