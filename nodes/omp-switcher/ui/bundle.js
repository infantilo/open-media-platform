// Node-UI-Bundle des Switchers (UMSETZUNG.md C7, ARCHITECTURE.md §4.5):
// ein Button pro entdeckter Quelle (aus dem readonly "inputs"-Parameter)
// plus ein Schwarzbild-Button, aktiver Button hervorgehoben. Nutzt
// dieselbe generische Node-Proxy-API wie das Shell-Panel
// (/api/v1/nodes/<id>/params/<name>, /api/v1/nodes/<id>/methods/<name>)
// — kein Sonderprotokoll. Pollt alle 2s, weil "inputs" sich außerhalb
// dieses Nodes ändert (neue omp-source-Instanzen erscheinen/verschwinden)
// und es dafür (anders als bei einzelnen Parametern) keinen SSE-Kanal
// gibt.
//
// Skalierungs-Review D5/Nutzerwunsch (docs/REVIEW-2026-07-17-SKALIERUNG-
// 24-7.md, "Source-Katalog-UI modernisieren", präzisiert 2026-07-22:
// analog zur bereits verbesserten AFV-Ziel-Auswahl im Audio-Mixer,
// s. dortiges `rebuildFollowOptions`/`loadFollowTargets`): Quellen
// werden nach Workflow-Zugehörigkeit gruppiert (eigener Workflow zuerst,
// sichtbare Zwischenüberschrift), sobald mehr als eine Gruppe existiert
// — bei fehlender Workflow-Nutzung (kein Workflow oder alle Quellen im
// selben) bleibt die Liste unverändert flach, wie zuvor.
class OmpSwitcherPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; font-family: sans-serif; color: #eee; }
      .buttons { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
      .group-label {
        flex-basis: 100%; font-size: 10px; text-transform: uppercase;
        color: #888; margin: 6px 0 -2px;
      }
      .group-label:first-child { margin-top: 0; }
      button {
        cursor: pointer; padding: 6px 10px; border: 1px solid #555;
        background: #222; color: #eee; border-radius: 4px;
      }
      button.active { background: #2e7d32; border-color: #4caf50; }
      p.empty { font-size: 12px; color: #888; margin: 4px 0 0; }
    `;

    const buttons = document.createElement("div");
    buttons.className = "buttons";
    shadow.append(style, buttons);

    const select = (senderId) => {
      fetch(`/api/v1/nodes/${nodeId}/methods/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senderId: senderId || "" }),
      }).then(refresh);
    };

    // Sender->Workflow-Auflösung, gleiches Muster wie omp-audio-mixer/
    // ui/bundle.js#loadFollowTargets: GET /api/v1/graph liefert
    // senderId->nodeId (node.outputs[].id), GET /api/v1/workflows liefert
    // nodeId->workflowId (wf.runtime[role].nodeId) + workflowId->Label.
    const senderWorkflowLabel = async () => {
      const [graphRes, workflowsRes] = await Promise.all([
        fetch("/api/v1/graph"),
        fetch("/api/v1/workflows"),
      ]);
      const senderNodeId = new Map();
      if (graphRes.ok) {
        const graph = await graphRes.json();
        for (const n of graph.nodes || []) {
          for (const out of n.outputs || []) senderNodeId.set(out.id, n.id);
        }
      }
      const nodeWorkflow = new Map();
      let ownWorkflowId = null;
      let workflowLabel = new Map();
      if (workflowsRes.ok) {
        const workflows = await workflowsRes.json();
        for (const wf of workflows) {
          workflowLabel.set(wf.id, wf.definition?.title || wf.name);
          for (const role of Object.values(wf.runtime || {})) {
            if (!role.nodeId) continue;
            nodeWorkflow.set(role.nodeId, wf.id);
            if (role.nodeId === nodeId) ownWorkflowId = wf.id;
          }
        }
      }
      const result = new Map();
      for (const [senderId, nId] of senderNodeId) {
        const wfId = nodeWorkflow.get(nId);
        if (wfId) result.set(senderId, { id: wfId, label: workflowLabel.get(wfId) || wfId, own: wfId === ownWorkflowId });
      }
      return result;
    };

    const refresh = async () => {
      const [inputsRes, activeRes, senderWorkflow] = await Promise.all([
        fetch(`/api/v1/nodes/${nodeId}/params/inputs`),
        fetch(`/api/v1/nodes/${nodeId}/params/activeInput`),
        senderWorkflowLabel(),
      ]);
      if (!inputsRes.ok || !activeRes.ok) return;
      const inputs = (await inputsRes.json()).value || [];
      const active = (await activeRes.json()).value || "";

      buttons.innerHTML = "";

      const blackBtn = document.createElement("button");
      blackBtn.textContent = "Schwarz";
      blackBtn.className = active === "" ? "active" : "";
      blackBtn.addEventListener("click", () => select(""));
      buttons.append(blackBtn);

      const makeInputButton = (input) => {
        const btn = document.createElement("button");
        btn.textContent = input.label;
        btn.className = input.senderId === active ? "active" : "";
        btn.addEventListener("click", () => select(input.senderId));
        return btn;
      };

      // Gruppieren nur, wenn es tatsächlich mehr als eine Gruppe gibt
      // (eigener Workflow + mindestens ein Rest) — sonst bliebe die
      // Liste bei "kein Workflow genutzt" unverändert flach, wie vor
      // diesem Feature.
      const own = inputs.filter((i) => senderWorkflow.get(i.senderId)?.own);
      const rest = inputs.filter((i) => !senderWorkflow.get(i.senderId)?.own);
      if (own.length > 0 && rest.length > 0) {
        const ownLabel = document.createElement("div");
        ownLabel.className = "group-label";
        ownLabel.textContent = "Dieser Workflow";
        buttons.append(ownLabel);
        for (const input of own) buttons.append(makeInputButton(input));

        const restLabel = document.createElement("div");
        restLabel.className = "group-label";
        restLabel.textContent = "Andere Quellen";
        buttons.append(restLabel);
        for (const input of rest) buttons.append(makeInputButton(input));
      } else {
        for (const input of inputs) buttons.append(makeInputButton(input));
      }

      if (inputs.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = "keine Quellen entdeckt";
        buttons.append(empty);
      }
    };

    refresh();
    this._interval = setInterval(refresh, 2000);
  }

  disconnectedCallback() {
    clearInterval(this._interval);
  }
}

if (!customElements.get("omp-switcher-panel")) {
  customElements.define("omp-switcher-panel", OmpSwitcherPanel);
}
