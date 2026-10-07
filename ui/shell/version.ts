import { t } from "./i18n.ts";
// Firmware-/Build-Stempel des Orchestrators (GET /api/v1/version, öffentlich —
// auch vor der Anmeldung lesbar). Wird im Login-Bildschirm und im Admin-Bereich
// „System-Update“ angezeigt.

export interface BuildInfo {
  version: string;
  commit?: string;
  builtAt?: string;
}

/** Kurzform für den Login-Fuß, z. B. „Firmware 2026.10.0 (abc1234)“. */
export function formatFirmware(info: BuildInfo | null | undefined): string {
  if (!info || !info.version) return "";
  // „dev“ = ohne Release-Stempel gebaut (Entwicklungsstand).
  const v = info.version === "dev" ? t("ver.a4394c") : info.version;
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
