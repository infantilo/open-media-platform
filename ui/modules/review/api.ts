// Dünne Hülle um apiFetch für die Review-Routen.
import { apiFetch, authToken } from "../host.ts";

export interface ApiResult<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  data: T;
}

export async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await apiFetch(`/api/v1/review${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {} as T;
    try {
      data = (await res.json()) as T;
    } catch {
      // leere Antwort
    }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: String(e) } as unknown as T };
  }
}

/** Medien-URL für <video>/<img>: der Browser kann dort keinen Authorization-Header senden (s. queryTokenAllowedPath im Orchestrator). */
export function mediaUrl(path: string): string {
  const tok = authToken();
  return `/api/v1/review/media${path}${tok ? `?access_token=${encodeURIComponent(tok)}` : ""}`;
}

/** Lädt eine Datei mit Authentifizierung herunter (Bericht-Export). */
export async function download(path: string, filename: string): Promise<boolean> {
  try {
    const res = await apiFetch(`/api/v1/review${path}`);
    if (!res.ok) return false;
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return true;
  } catch {
    return false;
  }
}

export function errText(d: Record<string, unknown>): string {
  const problems = d.problems as string[] | undefined;
  if (problems?.length) return problems.join("\n");
  return String(d.error ?? "");
}
