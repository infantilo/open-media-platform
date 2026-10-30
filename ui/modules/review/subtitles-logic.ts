// Reiter „Untertitel“ im Eingang: SRT mit Sprechererkennung aus der Datei erzeugen — reine Logik (ohne DOM).

export interface SubtitleJob {
  id: string;
  assetId: string;
  name: string;
  state: "running" | "done" | "failed" | "canceled" | string;
  progress: number;
  message?: string;
  phase?: string;
  params: { track: number; language: string; speakers: number; names?: string[]; word?: string; style?: string };
  nodeLabel?: string;
  speakersFound: number;
  cues: number;
  durationS: number;
  downloadable: boolean;
  playoutTrack?: string;
  createdAt: string;
}

export interface SubtitleForm {
  name: string;
  track: string;
  language: string;
  /** "auto" | "1" | "2" … */
  speakers: string;
  /** Namen, durch Komma oder Zeilenumbruch getrennt. */
  names: string;
  style: "colon" | "bracket" | "dash";
}

export const EMPTY_SUBTITLE_FORM: SubtitleForm = { name: "", track: "0", language: "", speakers: "auto", names: "", style: "colon" };

export const SPEAKER_CHOICES = ["auto", "1", "2", "3", "4", "5", "6"];

export function parseNames(s: string): string[] {
  return s.split(/[,\n;]/).map((x) => x.trim()).filter((x) => x !== "");
}

/** Anfragekörper für POST /items/{id}/subtitles. Ohne Sprecherkennung (1) entfallen Namen und Schreibweise. */
export function subtitleBody(f: SubtitleForm): Record<string, unknown> {
  const speakers = f.speakers === "auto" ? 0 : Math.max(1, Math.floor(Number(f.speakers)) || 1);
  const track = Math.max(0, Math.floor(Number(f.track)) || 0);
  const body: Record<string, unknown> = { track, speakers };
  if (f.name.trim()) body.name = f.name.trim();
  if (f.language.trim()) body.language = f.language.trim().toLowerCase();
  if (speakers !== 1) {
    const names = parseNames(f.names);
    if (names.length > 0) body.names = names;
    body.style = f.style;
  }
  return body;
}

export function isActive(j: SubtitleJob): boolean {
  return j.state === "running";
}

export function anyActive(jobs: SubtitleJob[]): boolean {
  return jobs.some(isActive);
}

export function stateColor(state: string): string {
  switch (state) {
    case "done": return "var(--omp-ok, #3a3)";
    case "failed": return "var(--omp-error, #d33)";
    case "running": return "var(--omp-accent, #39f)";
    default: return "var(--omp-text-dim)";
  }
}

export function clampPct(p: number): number {
  return Number.isFinite(p) ? Math.max(0, Math.min(100, Math.round(p))) : 0;
}
