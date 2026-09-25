// Node-UI-Bundle für omp-webrtc-gateway (Nutzerwunsch 2026-09-23):
// Einladungslinks/QR-Codes fürs Handy verwalten — ohne gültige
// Einladung lehnt der Node seit demselben Nutzerauftrag jede /whip-
// bzw. /whep-Verbindung ab (invite.rs, "security!"). Identisches Panel
// für Kamera- UND Monitor-Richtung (dieselben Routen, gleiche Semantik
// auf beiden Seiten).
//
// Die Basis-URL fürs Handy ist NICHT der Orchestrator (dieser Proxy
// hier läuft nur für die Bedienoberfläche selbst) — das Handy lädt
// camera.html/monitor.html weiterhin DIREKT vom Node (eigener Port,
// s. main.rs-Moduldoku). Vorbefüllt aus `api_base_url` (GET
// /api/v1/nodes, dieselbe Adresse, mit der sich der Node bei der
// Registry angemeldet hat), aber bewusst EDITIERBAR — bei NAT/
// Portweiterleitung (s. docs/decisions.md Nachtrag 240 ff.,
// `OMP_PUBLIC_HOST`) kennt nur der Bediener die tatsächlich von
// außen erreichbare Adresse.
//
// Retourbild-Pairing (Nutzerwunsch 2026-09-24, "Handy-Kamera hat kein
// Retourbild/Monitor mehr"): eine per Einladungslink invite-token-
// Sicherheit (2026-09-23) hat `omp-webrtc-gateway` in zwei unabhängige
// Node-Instanzen aufgeteilt (Kamera-/Monitor-Richtung, je eigene
// `InviteStore`, je eigenes Panel). Auf einer KAMERA-Instanz zeigt
// dieses Panel deshalb zusätzlich einen "Retourbild-Node"-Auswähler:
// beim Anlegen einer neuen Einladung wird — falls gewählt — ZUSÄTZLICH
// eine Einladung auf der ausgewählten Monitor-Instanz erzeugt und mit
// der Kamera-Einladung zu EINEM gemeinsamen Link/QR-Code verschmolzen
// (`?token=<cam>&monitorBase=<url>&monitorToken=<mon>`), den
// `camera.html` dann für eine zweite, direkte WHEP-Verbindung zur
// Monitor-Instanz nutzt (deren Node-HTTP-Server sendet immer
// `Access-Control-Allow-Origin: *`, s. omp-node-sdk/src/server.rs
// Nachtrag 197 — kein Backend-Änderungsbedarf für die eigentliche
// Retour-Verbindung, nur für die Einladungs-Erzeugung/-Paarung hier).
//
// Die Paarung (welcher Kamera-Token gehört zu welchem Monitor-Token)
// existiert serverseitig NICHT (jede InviteStore kennt nur ihre eigenen
// Tokens) — sie wird bewusst NUR clientseitig in `localStorage` dieses
// Browsers gehalten (gleiche Kategorie wie der Stream-Token unten:
// reine Bedienoberflächen-Bequemlichkeit, kein Sicherheitsmerkmal). Ein
// anderer Browser/Bediener sieht die Kamera-Einladung dann als
// unpaarte, retourbild-lose Einladung — funktional noch korrekt (WHIP
// tut weiterhin was es soll), nur ohne den zusammengesetzten Link.
class OmpWebrtcGatewayPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; font-family: sans-serif; color: #eee; font-size: 13px; }
      label { display: block; margin-bottom: 8px; }
      input[type="text"], select {
        width: 100%; box-sizing: border-box; padding: 4px 6px; margin-top: 2px;
        background: #222; color: #eee; border: 1px solid #555; border-radius: 4px; font: inherit;
      }
      button {
        cursor: pointer; padding: 5px 10px; border: 1px solid #555;
        background: #222; color: #eee; border-radius: 4px; font-size: 12px;
      }
      button:hover { background: #333; }
      button.danger:hover { background: #5c1a1a; border-color: #a33; }
      .retour-row { margin: 0 0 10px; }
      .retour-row .hint { color: #888; font-size: 11px; margin-top: 2px; }
      .add-row { display: flex; gap: 6px; margin: 8px 0 10px; }
      .add-row input { flex: 1; margin-top: 0; }
      ul { list-style: none; margin: 0; padding: 0; }
      li {
        display: flex; align-items: center; gap: 8px; padding: 6px 0;
        border-top: 1px solid #333;
      }
      .qr { width: 56px; height: 56px; background: #fff; border-radius: 3px; flex: none; }
      .qr img { width: 100%; height: 100%; display: block; }
      .meta { flex: 1; min-width: 0; }
      .meta .label { font-weight: 600; }
      .meta .label:empty::before { content: "(ohne Bezeichnung)"; color: #888; font-weight: normal; }
      .meta .time { color: #888; font-size: 11px; }
      .meta .retour { color: #4c8dff; font-size: 11px; }
      .actions { display: flex; gap: 4px; flex: none; }
      p.empty { color: #888; margin: 8px 0; }
      p.error { color: #e57373; margin: 6px 0; }
    `;

    const root = document.createElement("div");
    root.innerHTML = `
      <label>Basis-URL fürs Handy
        <input type="text" id="base-url" placeholder="https://192.168.1.5:9441">
      </label>
      <div class="retour-row" id="retour-row" hidden>
        <label>Retourbild-Node (optional)
          <select id="retour-node"><option value="">Kein Retourbild</option></select>
        </label>
        <div class="hint">Wird mitgewählt, erzeugt "Neue Einladung" zusätzlich eine Einladung auf dieser Monitor-Instanz und verschmilzt beide zu EINEM Link/QR-Code fürs Handy (Kamera senden + Retourbild ansehen).</div>
      </div>
      <div class="add-row">
        <input type="text" id="new-label" placeholder="Bezeichnung (optional, z. B. „Kamera Regie 1“)">
        <button id="add">+ Neue Einladung</button>
      </div>
      <div id="error"></div>
      <ul id="list"></ul>
    `;
    shadow.append(style, root);

    const baseUrlInput = root.querySelector("#base-url");
    const newLabelInput = root.querySelector("#new-label");
    const errorEl = root.querySelector("#error");
    const listEl = root.querySelector("#list");
    const retourRow = root.querySelector("#retour-row");
    const retourSelect = root.querySelector("#retour-node");

    const api = (path, opts) => fetch(`/api/v1/nodes/${nodeId}${path}`, opts);

    // <img>-Tags können keinen Authorization-Header setzen (native
    // Browser-API, kein `fetch()` — der globale, patchende fetch()-
    // Wrapper aus ui/shell/auth.ts greift hier nicht). Der QR-Code lief
    // deshalb live als "kaputtes Bild" — derselbe, bereits bekannte
    // Fall wie die MJPEG-Vorschau (`ui/shell/node-preview.ts`), Fix
    // ebenso: Token separat aus demselben localStorage-Schlüssel lesen
    // und als `?access_token=` anhängen (Orchestrator akzeptiert das
    // nur für eine explizite Allowlist inkl. `/invites/qr`, s.
    // auth_middleware.go).
    const STREAM_TOKEN_KEY = "omp-auth-token";
    const qrImageUrl = (data) => {
      const token = localStorage.getItem(STREAM_TOKEN_KEY);
      const base = `/api/v1/nodes/${nodeId}/invites/qr?data=${encodeURIComponent(data)}`;
      return token ? `${base}&access_token=${encodeURIComponent(token)}` : base;
    };

    // Kamera<->Monitor-Paarung rein clientseitig (s. Kommentar oben am
    // Custom Element) — Schlüssel ist der Kamera-Token, global
    // eindeutig genug (128-Bit-UUID), daher EIN gemeinsamer
    // localStorage-Schlüssel für alle Panel-Instanzen dieses Browsers.
    const PAIR_STORE_KEY = "omp-webrtc-retour-pairs";
    const loadPairs = () => {
      try {
        const raw = JSON.parse(localStorage.getItem(PAIR_STORE_KEY) || "[]");
        return Array.isArray(raw) ? raw : [];
      } catch {
        return [];
      }
    };
    const savePairs = (pairs) => {
      try {
        localStorage.setItem(PAIR_STORE_KEY, JSON.stringify(pairs));
      } catch {
        // localStorage kann fehlen/blockiert sein (privater Modus u. ä.)
        // — die Paarung ist reine Bedienbequemlichkeit, kein Grund das
        // Panel zu blockieren.
      }
    };
    const findPair = (token) => loadPairs().find((p) => p.token === token);
    const addPair = (pair) => savePairs([...loadPairs(), pair]);
    const removePair = (token) => savePairs(loadPairs().filter((p) => p.token !== token));

    const showError = (msg) => {
      errorEl.textContent = msg || "";
      errorEl.className = msg ? "error" : "";
    };

    // Basis-URL genau EINMAL aus `api_base_url` vorbefüllen, danach nie
    // wieder überschreiben — sonst würde jeder Poll eine Bediener-
    // Korrektur (NAT-Adresse) stillschweigend zurücksetzen.
    let baseUrlSeeded = false;
    const seedBaseUrl = async (nodes) => {
      if (baseUrlSeeded) return;
      const self = nodes.find((n) => n.id === nodeId);
      if (self && self.api_base_url) {
        baseUrlInput.value = self.api_base_url;
        baseUrlSeeded = true;
      }
    };

    // Eigenen Instanz-Typ + online Monitor-Kandidaten auflösen (nur
    // relevant für die Retourbild-Paarung, s. Modul-Kommentar): GET
    // /api/v1/nodes liefert je Node dessen `instance_id`
    // (urn:x-omp:instance-Tag), GET /api/v1/instances dazu den
    // Katalog-`type` ("omp-webrtc-gateway-camera"/"-monitor",
    // deploy/catalog.json) — erst die Kreuzreferenz beider sagt, ob
    // DIESE Node-Instanz eine Kamera ist und welche Monitor-Instanzen
    // gerade online sind.
    let monitorCandidates = [];
    const updateRetourPicker = (nodes, instances) => {
      const self = nodes.find((n) => n.id === nodeId);
      const selfInstance = self && self.instance_id ? instances.find((i) => i.id === self.instance_id) : null;
      const isCamera = selfInstance && selfInstance.type === "omp-webrtc-gateway-camera";
      retourRow.hidden = !isCamera;
      if (!isCamera) {
        monitorCandidates = [];
        return;
      }
      monitorCandidates = instances
        .filter((i) => i.type === "omp-webrtc-gateway-monitor")
        .map((i) => {
          const node = nodes.find((n) => n.instance_id === i.id && n.online && n.api_base_url);
          return node ? { nodeId: node.id, label: i.label || node.label || node.id, baseUrl: node.api_base_url } : null;
        })
        .filter(Boolean);

      const prevValue = retourSelect.value;
      retourSelect.innerHTML = "";
      retourSelect.add(new Option("Kein Retourbild", ""));
      for (const c of monitorCandidates) retourSelect.add(new Option(c.label, c.nodeId));
      if (monitorCandidates.some((c) => c.nodeId === prevValue)) retourSelect.value = prevValue;
    };

    const inviteLink = (token) => {
      const base = baseUrlInput.value.trim().replace(/\/+$/, "");
      let url = `${base}/?token=${encodeURIComponent(token)}`;
      const pair = findPair(token);
      if (pair) {
        url += `&monitorBase=${encodeURIComponent(pair.monitorBase)}&monitorToken=${encodeURIComponent(pair.monitorToken)}`;
      }
      return url;
    };

    const render = (invites) => {
      listEl.innerHTML = "";
      if (invites.length === 0) {
        const p = document.createElement("p");
        p.className = "empty";
        p.textContent = "Keine Einladungen — ohne mindestens eine aktive Einladung nimmt dieser Node keine Verbindung an.";
        listEl.append(p);
        return;
      }
      for (const invite of invites) {
        const link = inviteLink(invite.token);
        const pair = findPair(invite.token);
        const li = document.createElement("li");

        const qr = document.createElement("div");
        qr.className = "qr";
        const img = document.createElement("img");
        img.src = qrImageUrl(link);
        img.alt = "QR-Code";
        qr.append(img);

        const meta = document.createElement("div");
        meta.className = "meta";
        const labelDiv = document.createElement("div");
        labelDiv.className = "label";
        labelDiv.textContent = invite.label || "";
        const timeDiv = document.createElement("div");
        timeDiv.className = "time";
        timeDiv.textContent = new Date(invite.createdAtMs).toLocaleString();
        meta.append(labelDiv, timeDiv);
        if (pair) {
          const retourDiv = document.createElement("div");
          retourDiv.className = "retour";
          retourDiv.textContent = "+ Retourbild";
          meta.append(retourDiv);
        }

        const actions = document.createElement("div");
        actions.className = "actions";
        const copyBtn = document.createElement("button");
        copyBtn.textContent = "Link kopieren";
        copyBtn.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(link);
            copyBtn.textContent = "Kopiert!";
            setTimeout(() => (copyBtn.textContent = "Link kopieren"), 1500);
          } catch {
            showError("Kopieren fehlgeschlagen — Link von Hand markieren: " + link);
          }
        });
        const revokeBtn = document.createElement("button");
        revokeBtn.className = "danger";
        revokeBtn.textContent = "Widerrufen";
        revokeBtn.addEventListener("click", () => void revoke(invite.token));
        actions.append(copyBtn, revokeBtn);

        li.append(qr, meta, actions);
        listEl.append(li);
      }
    };

    const refresh = async () => {
      try {
        const [invitesRes, nodesRes, instancesRes] = await Promise.all([
          api("/invites"),
          fetch("/api/v1/nodes"),
          fetch("/api/v1/instances"),
        ]);
        if (!invitesRes.ok) {
          showError(`Einladungen laden fehlgeschlagen (${invitesRes.status})`);
          return;
        }
        if (nodesRes.ok && instancesRes.ok) {
          const nodes = await nodesRes.json();
          const instances = await instancesRes.json();
          await seedBaseUrl(nodes);
          updateRetourPicker(nodes, instances);
        }
        showError("");
        render(await invitesRes.json());
      } catch (e) {
        showError("Einladungen laden fehlgeschlagen: " + e);
      }
    };

    const create = async () => {
      const label = newLabelInput.value.trim();
      const res = await api("/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!res.ok) {
        showError(`Einladung anlegen fehlgeschlagen (${res.status})`);
        return;
      }
      const invite = await res.json();

      const retourNodeId = retourSelect.value;
      if (retourNodeId) {
        const candidate = monitorCandidates.find((c) => c.nodeId === retourNodeId);
        if (candidate) {
          try {
            const monRes = await fetch(`/api/v1/nodes/${retourNodeId}/invites`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ label: label ? `${label} (Retour)` : "Retour" }),
            });
            if (monRes.ok) {
              const monInvite = await monRes.json();
              addPair({
                token: invite.token,
                monitorNodeId: retourNodeId,
                monitorBase: candidate.baseUrl,
                monitorToken: monInvite.token,
              });
            } else {
              showError(
                `Retourbild-Einladung auf "${candidate.label}" fehlgeschlagen (${monRes.status}) — Kamera-Einladung wurde trotzdem angelegt, nur ohne Retourbild.`
              );
            }
          } catch (e) {
            showError("Retourbild-Einladung fehlgeschlagen: " + e + " — Kamera-Einladung wurde trotzdem angelegt, nur ohne Retourbild.");
          }
        }
      }

      newLabelInput.value = "";
      await refresh();
    };

    // Bugliste 2026-09-25 #1 ("bei 'widerrufen' muss (optional durch
    // Abfrage) die bestehende Verbindung getrennt werden können"): Widerruf
    // selbst bleibt ein Klick ohne Rückfrage (jederzeit reversibel — eine
    // neue Einladung ist sofort wieder angelegt), NUR das zusätzliche,
    // schwerer rückgängig zu machende Trennen einer eventuell aktiven
    // Verbindung wird per `window.confirm()` erfragt — gleiches Muster wie
    // `nodes/omp-audio-mixer`/`omp-mxf-player`/`omp-playout-automation`s
    // eigenständige UI-Bundles (kein `ui/kit`-Zugriff hier, s. `omp-video-
    // mixer-me/ui/bundle.js`s `openModal`-Kommentar dazu). Server-seitig
    // (`invite::route`) ist `disconnect=true` ohnehin ein No-Op, falls der
    // Token gar nicht (mehr) zur aktiven Sitzung gehört.
    const revoke = async (token) => {
      const alsoDisconnect = window.confirm(
        "Einladung widerrufen. Soll eine damit möglicherweise gerade aktive Verbindung sofort getrennt werden?"
      );
      const disconnectQuery = alsoDisconnect ? "&disconnect=true" : "";
      const res = await api(`/invites?token=${encodeURIComponent(token)}${disconnectQuery}`, { method: "DELETE" });
      if (!res.ok) {
        showError(`Widerrufen fehlgeschlagen (${res.status})`);
        return;
      }
      const pair = findPair(token);
      if (pair) {
        try {
          await fetch(
            `/api/v1/nodes/${pair.monitorNodeId}/invites?token=${encodeURIComponent(pair.monitorToken)}${disconnectQuery}`,
            { method: "DELETE" }
          );
        } catch {
          // Best effort — eine verwaiste Retour-Einladung auf der
          // Monitor-Instanz ist kein Grund, den Widerruf der
          // Kamera-Seite zu blockieren (sie läuft ohnehin nur bis zum
          // nächsten Node-Neustart, s. invite.rs-Moduldoku).
        }
        removePair(token);
      }
      await refresh();
    };

    root.querySelector("#add").addEventListener("click", () => void create());
    newLabelInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") void create();
    });
    // Ein geänderter Basiswert wirkt sich auf JEDEN QR-Code/Link aus
    // (die URL wird erst beim Rendern zusammengesetzt) — einfach neu
    // rendern, kein erneuter Server-Roundtrip nötig.
    baseUrlInput.addEventListener("input", () => {
      baseUrlSeeded = true; // Bediener hat selbst eingegriffen, nicht mehr überschreiben.
      refresh();
    });

    refresh();
    const poll = setInterval(refresh, 5000);
    this._cleanup = () => clearInterval(poll);
  }

  disconnectedCallback() {
    if (this._cleanup) this._cleanup();
  }
}

customElements.define("omp-webrtc-gateway-panel", OmpWebrtcGatewayPanel);
