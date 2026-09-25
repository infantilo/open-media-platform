// Gemeinsamer Client für `/api/v1/tools/ffmpeg/...` (UMSETZUNG.md
// Kapitel 22, W1: orchestrator/internal/ffmpegtools) — von
// process-step-config.ts (W2, Formular-Wizard) UND filter-graph.ts (W3,
// visueller Filter-Builder) genutzt, damit die Introspektionsdaten nicht
// zweimal abgefragt/gecacht werden.
import { apiFetch } from "../shell/connection.ts";
import type { FFDetail } from "./process-step-config-logic.ts";

const listCache = new Map<string, Promise<unknown[]>>();

export function fetchFFmpegList<T>(which: string): Promise<T[]> {
  if (!listCache.has(which)) {
    listCache.set(
      which,
      (async () => {
        try {
          const res = await apiFetch(`/api/v1/tools/ffmpeg/${which}`);
          return res.ok ? await res.json() : [];
        } catch {
          return [];
        }
      })(),
    );
  }
  return listCache.get(which)! as Promise<T[]>;
}

const detailCache = new Map<string, Promise<FFDetail | null>>();

export function fetchFFmpegDetail(kind: string, name: string): Promise<FFDetail | null> {
  const key = `${kind}/${name}`;
  if (!detailCache.has(key)) {
    detailCache.set(
      key,
      (async () => {
        try {
          const res = await apiFetch(`/api/v1/tools/ffmpeg/${kind}/${encodeURIComponent(name)}`);
          return res.ok ? await res.json() : null;
        } catch {
          return null;
        }
      })(),
    );
  }
  return detailCache.get(key)!;
}
