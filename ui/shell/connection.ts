// ConnectionMonitor (ARCHITECTURE.md §22.1/§1.3a des END-GOAL-FEATURES-
// Kapitels, UMSETZUNG.md K1-Teil-1): ein einziges, geteiltes
// Verbindungs-Zustandsobjekt statt der bisherigen, rein internen
// Reconnect-Logik in flow-canvas.ts (die dort verbaute
// #connectEvents/#scheduleReconnect-Logik zieht hierher um). Zustände:
//
// - "connected"    — SSE-Stream lebt (Primärsignal, ist de facto der
//                    Heartbeat zum Orchestrator).
// - "degraded"     — SSE lebt, aber ein einzelner apiFetch()-Aufruf ist
//                    fehlgeschlagen (Sekundärsignal). Die bestehende
//                    "nächster Poll holt es auf"-Semantik der Panels
//                    bleibt, wird aber nicht mehr still verschluckt.
// - "disconnected" — SSE-Verbindung abgebrochen, Reconnect mit
//                    exponentiellem Backoff läuft (gleiche Konstanten
//                    wie vorher in flow-canvas.ts).
//
// Genau eine EventSource pro Shell (nicht mehr eine pro Komponente):
// `connectionMonitor.start()` ist idempotent, flow-canvas.ts und die
// neue App-Bar (shell.ts) rufen sie unabhängig voneinander auf, ohne
// eine zweite Verbindung zu öffnen. Rohe SSE-Payloads werden
// unverändert als CustomEvent("sse-message", { detail: string })
// weitergereicht — #handleServerEvent() (Graph-Refresh/Tally/Crash-
// Events) bleibt Sache von flow-canvas.ts, dieses Modul kennt die
// Nutzlast-Struktur nicht.
//
// Bewusst kein `import { getToken } from "./auth.ts"`: dessen Modul-
// Ladezeit-Seiteneffekt (der globale `window.fetch`-Patch, s. dortiger
// Kommentar) bricht unter `deno test` ("window is not defined", Deno 2
// kennt nur `globalThis`) — dieses Modul braucht ohnehin nur den
// Token-Lesezugriff, kein Fetch-Patching. Gleicher Storage-Key wie
// `auth.ts`s `TOKEN_KEY`, absichtlich dupliziert statt einer gemeinsamen
// dritten Datei nur für eine Konstante.
const TOKEN_KEY = "omp-auth-token";

export type ConnectionState = "connected" | "degraded" | "disconnected";

export interface ConnectionChangeDetail {
  state: ConnectionState;
  nextRetryAt: number | null;
}

const SSE_RECONNECT_INITIAL_DELAY_MS = 1000;
const SSE_RECONNECT_MAX_DELAY_MS = 30000;
// Live-Test-Fund (K1-Teil-1, CDP-Stop/Start-Zyklus): ein einzelner
// apiFetch()-Aufruf, der schon VOR einem Verbindungsabbruch lief (z. B.
// #maybeFetchPreviewUrl in flow-canvas.ts), kann Sekunden bis über eine
// Minute später mit einem 5xx auflösen — lange nachdem die SSE-Verbindung
// längst wieder "connected" war (beobachtet: 68s späte 502-Antwort auf
// einen Params-Fetch von Seitenladezeit). Ohne Gegenmaßnahme blieb
// "degraded" für immer stehen, weil auf dem Flow-Editor-Tab sonst nichts
// periodisch apiFetch() aufruft, das den Zustand zurückkorrigieren
// könnte. Ein leiser Recovery-Probe gegen /healthz (unauthentifiziert,
// bereits von stop-omp.sh genutzt) heilt das automatisch.
const DEGRADED_RECOVERY_PROBE_INTERVAL_MS = 3000;

class ConnectionMonitor extends EventTarget {
  #state: ConnectionState = "connected";
  #es: EventSource | null = null;
  #reconnectDelayMs = SSE_RECONNECT_INITIAL_DELAY_MS;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #nextRetryAt: number | null = null;
  #degradedProbeTimer: ReturnType<typeof setTimeout> | undefined;

  get state(): ConnectionState {
    return this.#state;
  }

  get nextRetryAt(): number | null {
    return this.#nextRetryAt;
  }

  // Idempotent: zweiter/dritter Aufruf (App-Bar UND flow-canvas rufen
  // beide start() in ihrem connectedCallback) öffnet keine zweite
  // EventSource-Verbindung.
  start() {
    if (this.#es) return;
    this.#connect();
  }

  // Für den "Jetzt verbinden"-Knopf im Disconnected-Banner: verwirft
  // den laufenden Backoff-Timer und versucht sofort neu, statt auf den
  // nächsten geplanten Versuch zu warten.
  reconnectNow() {
    clearTimeout(this.#reconnectTimer);
    this.#es?.close();
    this.#es = null;
    this.#connect();
  }

  #connect() {
    // Browser-`EventSource` kann keine eigenen Header setzen (Web-
    // Plattform-Einschränkung) — der Server akzeptiert deshalb seit D3-2
    // (`docs/decisions.md`) `?access_token=` als Fallback zum
    // `Authorization`-Header. Live-Test-Fund (K3/K4-Teil-1-Sitzung):
    // dieser Fallback wurde beim Auslagern der SSE-Verbindung aus
    // flow-canvas.ts nach hier nie tatsächlich verdrahtet — die Shell
    // blieb dadurch dauerhaft "disconnected", sobald ein echter Nutzer
    // (also außerhalb des Zero-User-Bootstrap-Zustands) angemeldet war.
    const token = localStorage.getItem(TOKEN_KEY);
    const url = token ? `/api/v1/events?access_token=${encodeURIComponent(token)}` : "/api/v1/events";
    const es = new EventSource(url);
    this.#es = es;

    es.onopen = () => {
      this.#reconnectDelayMs = SSE_RECONNECT_INITIAL_DELAY_MS;
      this.#nextRetryAt = null;
      this.#setState("connected");
    };
    es.onmessage = (ev) => {
      this.dispatchEvent(new CustomEvent<string>("sse-message", { detail: ev.data }));
    };
    es.onerror = () => {
      es.close();
      this.#setState("disconnected");
      this.#scheduleReconnect();
    };
  }

  #scheduleReconnect() {
    clearTimeout(this.#reconnectTimer);
    this.#nextRetryAt = Date.now() + this.#reconnectDelayMs;
    this.dispatchEvent(new Event("retry-scheduled"));
    this.#reconnectTimer = setTimeout(() => this.#connect(), this.#reconnectDelayMs);
    this.#reconnectDelayMs = Math.min(this.#reconnectDelayMs * 2, SSE_RECONNECT_MAX_DELAY_MS);
  }

  // apiFetch() meldet hierüber fehlgeschlagene Requests — nur relevant,
  // während der SSE-Stream selbst noch lebt ("connected"): ist er schon
  // "disconnected", ist das ohnehin der schlechtere, bereits sichtbare
  // Zustand; ein einzelner Fetch-Fehler soll ihn nicht überschreiben.
  reportApiFailure() {
    if (this.#state === "connected") {
      this.#setState("degraded");
      this.#startDegradedRecoveryProbe();
    }
  }

  reportApiSuccess() {
    if (this.#state === "degraded") this.#setState("connected");
  }

  #setState(next: ConnectionState) {
    if (next !== "degraded") this.#stopDegradedRecoveryProbe();
    if (this.#state === next) return;
    this.#state = next;
    this.dispatchEvent(
      new CustomEvent<ConnectionChangeDetail>("statechange", {
        detail: { state: next, nextRetryAt: this.#nextRetryAt },
      }),
    );
  }

  // "degraded" ist als Sekundärsignal gedacht, nicht als Sackgasse: ohne
  // diesen Probe könnte ein einzelner, längst veralteter Fetch-Fehlschlag
  // (s. Kommentar bei DEGRADED_RECOVERY_PROBE_INTERVAL_MS oben) den
  // Zustand für den Rest der Sitzung einfrieren, wenn gerade niemand eine
  // andere apiFetch()-Aktion auslöst. apiFetch() selbst ruft hier wieder
  // rein (reportApiSuccess()/-Failure()), es ist also derselbe Pfad wie
  // jeder andere Aufrufer — kein Sonderfall.
  #startDegradedRecoveryProbe() {
    if (this.#degradedProbeTimer !== undefined) return;
    const probe = () => {
      this.#degradedProbeTimer = undefined;
      if (this.#state !== "degraded") return;
      apiFetch("/healthz").finally(() => {
        if (this.#state === "degraded") {
          this.#degradedProbeTimer = setTimeout(probe, DEGRADED_RECOVERY_PROBE_INTERVAL_MS);
        }
      });
    };
    this.#degradedProbeTimer = setTimeout(probe, DEGRADED_RECOVERY_PROBE_INTERVAL_MS);
  }

  #stopDegradedRecoveryProbe() {
    clearTimeout(this.#degradedProbeTimer);
    this.#degradedProbeTimer = undefined;
  }
}

export const connectionMonitor = new ConnectionMonitor();

// apiFetch() ersetzt den rohen `fetch(...)`-Aufruf in flow-canvas.ts/
// hosts-view.ts/workflows-view.ts: gleiche Signatur/gleiches
// Rückgabeverhalten (Aufrufer prüfen weiterhin selbst `res.ok`), meldet
// aber zusätzlich Fehlschläge an den ConnectionMonitor statt sie wie
// bisher still zu verschlucken. Nur 5xx/Netzwerkfehler zählen als
// Verbindungsproblem — ein 4xx ist eine legitime Anwendungsantwort
// (z. B. 404/409 aus einer normalen Validierung), kein Konnektivitäts-
// Symptom.
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    const res = await fetch(input, init);
    if (res.ok || res.status < 500) {
      connectionMonitor.reportApiSuccess();
    } else {
      connectionMonitor.reportApiFailure();
    }
    return res;
  } catch (err) {
    connectionMonitor.reportApiFailure();
    throw err;
  }
}
