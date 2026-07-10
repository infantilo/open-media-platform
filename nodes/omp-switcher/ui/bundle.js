// Node-UI-Bundle des Switchers (UMSETZUNG.md C7, ARCHITECTURE.md §4.5):
// ein Button pro entdeckter Quelle (aus dem readonly "inputs"-Parameter)
// plus ein Schwarzbild-Button, aktiver Button hervorgehoben. Nutzt
// dieselbe generische Node-Proxy-API wie das Shell-Panel
// (/api/v1/nodes/<id>/params/<name>, /api/v1/nodes/<id>/methods/<name>)
// — kein Sonderprotokoll. Pollt alle 2s, weil "inputs" sich außerhalb
// dieses Nodes ändert (neue omp-source-Instanzen erscheinen/verschwinden)
// und es dafür (anders als bei einzelnen Parametern) keinen SSE-Kanal
// gibt.
class OmpSwitcherPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; font-family: sans-serif; color: #eee; }
      .buttons { display: flex; flex-wrap: wrap; gap: 6px; }
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

    const refresh = async () => {
      const [inputsRes, activeRes] = await Promise.all([
        fetch(`/api/v1/nodes/${nodeId}/params/inputs`),
        fetch(`/api/v1/nodes/${nodeId}/params/activeInput`),
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

      for (const input of inputs) {
        const btn = document.createElement("button");
        btn.textContent = input.label;
        btn.className = input.senderId === active ? "active" : "";
        btn.addEventListener("click", () => select(input.senderId));
        buttons.append(btn);
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
