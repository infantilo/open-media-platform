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
class OmpWebrtcGatewayPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; font-family: sans-serif; color: #eee; font-size: 13px; }
      label { display: block; margin-bottom: 8px; }
      input[type="text"] {
        width: 100%; box-sizing: border-box; padding: 4px 6px; margin-top: 2px;
        background: #222; color: #eee; border: 1px solid #555; border-radius: 4px;
      }
      button {
        cursor: pointer; padding: 5px 10px; border: 1px solid #555;
        background: #222; color: #eee; border-radius: 4px; font-size: 12px;
      }
      button:hover { background: #333; }
      button.danger:hover { background: #5c1a1a; border-color: #a33; }
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
      .actions { display: flex; gap: 4px; flex: none; }
      p.empty { color: #888; margin: 8px 0; }
      p.error { color: #e57373; margin: 6px 0; }
    `;

    const root = document.createElement("div");
    root.innerHTML = `
      <label>Basis-URL fürs Handy
        <input type="text" id="base-url" placeholder="https://192.168.1.5:9441">
      </label>
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

    const api = (path, opts) => fetch(`/api/v1/nodes/${nodeId}${path}`, opts);

    const showError = (msg) => {
      errorEl.textContent = msg || "";
      errorEl.className = msg ? "error" : "";
    };

    // Basis-URL genau EINMAL aus `api_base_url` vorbefüllen, danach nie
    // wieder überschreiben — sonst würde jeder Poll eine Bediener-
    // Korrektur (NAT-Adresse) stillschweigend zurücksetzen.
    let baseUrlSeeded = false;
    const seedBaseUrl = async () => {
      if (baseUrlSeeded) return;
      try {
        const res = await fetch("/api/v1/nodes");
        if (!res.ok) return;
        const nodes = await res.json();
        const self = nodes.find((n) => n.id === nodeId);
        if (self && self.api_base_url) {
          baseUrlInput.value = self.api_base_url;
          baseUrlSeeded = true;
        }
      } catch {
        // Netzwerkfehler beim Vorbefüllen ist kein Grund, die
        // Bedienoberfläche zu blockieren — Feld bleibt leer/editierbar.
      }
    };

    const inviteLink = (token) => {
      const base = baseUrlInput.value.trim().replace(/\/+$/, "");
      return `${base}/?token=${encodeURIComponent(token)}`;
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
        const li = document.createElement("li");

        const qr = document.createElement("div");
        qr.className = "qr";
        const img = document.createElement("img");
        img.src = `/api/v1/nodes/${nodeId}/invites/qr?data=${encodeURIComponent(link)}`;
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
        const res = await api("/invites");
        if (!res.ok) {
          showError(`Einladungen laden fehlgeschlagen (${res.status})`);
          return;
        }
        showError("");
        render(await res.json());
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
      newLabelInput.value = "";
      await refresh();
    };

    const revoke = async (token) => {
      const res = await api(`/invites?token=${encodeURIComponent(token)}`, { method: "DELETE" });
      if (!res.ok) {
        showError(`Widerrufen fehlgeschlagen (${res.status})`);
        return;
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

    seedBaseUrl().then(refresh);
    const poll = setInterval(refresh, 5000);
    this._cleanup = () => clearInterval(poll);
  }

  disconnectedCallback() {
    if (this._cleanup) this._cleanup();
  }
}

customElements.define("omp-webrtc-gateway-panel", OmpWebrtcGatewayPanel);
