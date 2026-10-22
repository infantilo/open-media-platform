// Bedienoberfläche des Intercom-Dienstes in der Operator-Konsole (Kapitel 47, ab Kapitel 49 über den Dienstvertrag): bettet
// die eigene Sprechstelle ein und bietet dem Stream Deck die Eigenschaft `streamDeck` (Adapter dieser Oberfläche, nicht der
// Shell). Der Dienst wird über Typ und Rolle gefunden (`GET /api/v1/ext`, docs/CONTRACT-INTERCOM.md), nie über einen
// Produktnamen. Eigenständiges Bundle (kein Zugriff auf die Shell außer dem Anmelde-Token) — es kommt vom Node selbst
// (`/ui/bundle.js`).

import { type DeckIO, intercomAdapter } from "./deck/adapter.ts";
import type { Cmd, DeckState } from "./deck/logic.ts";

const L = (document.documentElement.lang || "de").startsWith("en") ? "en" : "de";
const D = {
  de: { pick: "Sprechstelle", newTab: "In neuem Tab öffnen", none: "Für Sie ist keine Sprechstelle eingerichtet (Administration → Produktion → Intercom).", err: "Sprechstellen laden fehlgeschlagen", cert: "Zeigt das Panel nichts an: einmal „In neuem Tab öffnen“ und das Zertifikat bestätigen.", online: "online", noService: "Kein Intercom-Dienst gefunden." },
  en: { pick: "Station", newTab: "Open in new tab", none: "No station is set up for you (Administration → Production → Intercom).", err: "Loading stations failed", cert: "If the panel shows nothing: open it once in a new tab and accept the certificate.", online: "online", noService: "No intercom service found." },
}[L];

interface RoleRoute {
  method: string;
  path: string;
}
interface Service {
  name: string;
  kind?: string;
  live: boolean;
  roles?: Record<string, RoleRoute>;
}
interface PanelEntry {
  party_id: number;
  name: string;
  url: string;
}

function headers(): Record<string, string> {
  let tok: string | null = null;
  try {
    tok = localStorage.getItem("omp-auth-token");
  } catch { /* ohne Speicher: ohne Anmeldung */ }
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

/** Findet den Intercom-Dienst über Typ und Rolle; bevorzugt einen laufenden. */
export async function findIntercom(): Promise<Service | null> {
  const r = await fetch("/api/v1/ext", { headers: headers() });
  if (!r.ok) throw new Error(String(r.status));
  const all = ((await r.json()) as Service[]).filter((s) => s.kind === "intercom");
  return all.find((s) => s.live) ?? all[0] ?? null;
}

async function call(svc: Service, role: string, params: Record<string, string | number> = {}, body?: unknown): Promise<Response> {
  const rt = svc.roles?.[role];
  if (!rt) throw new Error(`Rolle ${role} nicht verfügbar`);
  let path = rt.path;
  for (const [k, v] of Object.entries(params)) path = path.replace(`{${k}}`, encodeURIComponent(String(v)));
  const init: RequestInit = { method: rt.method, headers: { ...headers(), ...(body !== undefined ? { "content-type": "application/json" } : {}) } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return await fetch(`/api/v1/ext/${svc.name}${path}`, init);
}

class OmpIntercomPanel extends HTMLElement {
  deckParty: number | null = null; // der Stream-Deck-Adapter liest die eigene Sprechstelle von hier
  #svc: Service | null = null;
  #panels: PanelEntry[] = [];
  #current = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #error = "";
  #deck: ReturnType<typeof intercomAdapter> | null = null;

  /** Adapter fürs Stream Deck (Schnittstelle `streamDeck`, shell/streamdeck/adapter.ts). */
  get streamDeck() {
    this.#deck ??= intercomAdapter(this.#deckIO(), () => this.deckParty);
    return this.#deck;
  }

  #deckIO(): DeckIO {
    return {
      state: async (party) => {
        const svc = this.#svc ?? (this.#svc = await findIntercom());
        if (!svc) throw new Error(D.noService);
        const r = await call(svc, "deck.state", { party });
        if (!r.ok) throw new Error(String(r.status));
        return (await r.json()) as DeckState;
      },
      command: async (party: number, cmd: Cmd) => {
        const svc = this.#svc ?? (this.#svc = await findIntercom());
        if (!svc) throw new Error(D.noService);
        const r = await call(svc, "deck.command", { party }, cmd);
        if (!r.ok) throw new Error(String(r.status));
      },
    };
  }

  connectedCallback() {
    this.style.cssText = "display:block;padding:8px;font:13px system-ui,sans-serif;";
    void this.#load();
    this.#timer = setInterval(() => void this.#status(), 3000);
  }

  disconnectedCallback() {
    clearInterval(this.#timer);
  }

  async #load() {
    try {
      this.#svc = await findIntercom();
      if (!this.#svc) throw new Error(D.noService);
      const r = await call(this.#svc, "panels");
      if (!r.ok) throw new Error(String(r.status));
      this.#panels = ((await r.json()) as { panels?: PanelEntry[] }).panels ?? [];
      this.#error = "";
    } catch (e) {
      this.#error = `${D.err} (${(e as Error).message})`;
    }
    let saved = NaN;
    try {
      saved = Number(sessionStorage.getItem("omp-intercom-party") ?? "");
    } catch { /* egal */ }
    const idx = this.#panels.findIndex((p) => p.party_id === saved);
    this.#current = idx >= 0 ? idx : 0;
    this.#render();
  }

  async #status() {
    const el = this.querySelector<HTMLElement>("[data-status]");
    if (!el || !this.#svc) return;
    try {
      const r = await call(this.#svc, "status");
      if (!r.ok) return;
      const st = (await r.json()) as { parties?: { online?: boolean }[] };
      el.textContent = `${(st.parties ?? []).filter((p) => p.online).length} ${D.online}`;
    } catch { /* Anzeige bleibt */ }
  }

  #render() {
    this.replaceChildren();
    if (this.#error) {
      const e = document.createElement("div");
      e.style.color = "var(--omp-error,#e57373)";
      e.textContent = this.#error;
      this.append(e);
    }
    if (!this.#panels.length) {
      this.deckParty = null;
      if (!this.#error) {
        const n = document.createElement("div");
        n.style.opacity = "0.7";
        n.textContent = D.none;
        this.append(n);
      }
      return;
    }
    const p = this.#panels[Math.min(this.#current, this.#panels.length - 1)];
    this.deckParty = p.party_id;
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px;";
    if (this.#panels.length > 1) {
      const lab = document.createElement("span");
      lab.textContent = D.pick;
      const sel = document.createElement("select");
      this.#panels.forEach((x, i) => sel.add(new Option(x.name, String(i))));
      sel.value = String(this.#current);
      sel.onchange = () => {
        this.#current = Number(sel.value);
        try {
          sessionStorage.setItem("omp-intercom-party", String(this.#panels[this.#current].party_id));
        } catch { /* egal */ }
        this.#render();
      };
      bar.append(lab, sel);
    } else {
      const s = document.createElement("strong");
      s.textContent = p.name;
      bar.append(s);
    }
    const a = document.createElement("a");
    a.href = p.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = D.newTab;
    const st = document.createElement("span");
    st.dataset.status = "1";
    st.style.opacity = "0.7";
    const hint = document.createElement("span");
    hint.style.cssText = "opacity:.6;font-size:11px;";
    hint.textContent = D.cert;
    bar.append(a, st, hint);
    const f = document.createElement("iframe");
    f.src = p.url;
    f.title = p.name;
    f.setAttribute("allow", "microphone; autoplay");
    f.style.cssText = "width:100%;max-width:980px;height:calc(100% - 40px);min-height:420px;border:1px solid var(--omp-border,#223049);border-radius:8px;background:var(--omp-bg,#080c16);";
    this.append(bar, f);
    void this.#status();
  }
}

if (!customElements.get("omp-intercom-panel")) customElements.define("omp-intercom-panel", OmpIntercomPanel);
