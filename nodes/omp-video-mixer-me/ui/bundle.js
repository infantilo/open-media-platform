// Node-UI-Bundle des Bildmischers (UMSETZUNG.md C10, ARCHITECTURE.md §4.5):
// Preset-Bus-Buttons (Klick = crosspoint.select), Cut/AutoTrans-Buttons,
// Keyer- und DVE(PIP)-Toggle. Gleiche generische Node-Proxy-API wie
// omp-switcher (C7): /api/v1/nodes/<id>/params/<name>,
// /api/v1/nodes/<id>/methods/<name>. Pollt alle 2s wie das Switcher-Panel
// (inputs/programInput/presetInput ändern sich außerhalb dieses Nodes).
const WIDTH = 640;
const HEIGHT = 480;
// Feste Picture-in-Picture-Box fürs DVE-Toggle (unten rechts, 1/3 Größe) —
// "ein DVE-Kanal vorführbar" (C10) braucht keine freie Positionierung,
// volle DVE-Tiefe ist Community-Scope (ARCHITECTURE.md §13.1).
const PIP_BOX = { width: Math.round(WIDTH / 3), height: Math.round(HEIGHT / 3) };
PIP_BOX.x = WIDTH - PIP_BOX.width - 16;
PIP_BOX.y = HEIGHT - PIP_BOX.height - 16;

class OmpVideoMixerMePanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; font-family: sans-serif; color: #eee; }
      section { margin-bottom: 10px; }
      h4 { margin: 0 0 4px; font-size: 11px; text-transform: uppercase; color: #999; }
      .buttons { display: flex; flex-wrap: wrap; gap: 6px; }
      button {
        cursor: pointer; padding: 6px 10px; border: 1px solid #555;
        background: #222; color: #eee; border-radius: 4px;
      }
      button.on-air { border-color: #ff3b3b; box-shadow: 0 0 0 2px #ff3b3b inset; }
      button.preset-active { background: #2e7d32; border-color: #4caf50; }
      button.toggle-on { background: #1565c0; border-color: #42a5f5; }
      button.take { background: #444; font-weight: bold; }
      p.empty { font-size: 12px; color: #888; margin: 4px 0 0; }
    `;

    const presetRow = document.createElement("div");
    presetRow.className = "buttons";
    const takeRow = document.createElement("div");
    takeRow.className = "buttons";
    const fxRow = document.createElement("div");
    fxRow.className = "buttons";

    const section = (title, row) => {
      const s = document.createElement("section");
      const h = document.createElement("h4");
      h.textContent = title;
      s.append(h, row);
      return s;
    };

    shadow.append(
      style,
      section("Preset (Auswahl)", presetRow),
      section("Take", takeRow),
      section("Keyer / DVE", fxRow),
    );

    const call = (method, body) =>
      fetch(`/api/v1/nodes/${nodeId}/methods/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      }).then(refresh);

    const cutBtn = document.createElement("button");
    cutBtn.textContent = "Cut";
    cutBtn.className = "take";
    cutBtn.addEventListener("click", () => call("crosspoint.cut"));

    const autoTransBtn = document.createElement("button");
    autoTransBtn.textContent = "Auto Trans";
    autoTransBtn.className = "take";
    autoTransBtn.addEventListener("click", () => call("crosspoint.autoTrans"));

    takeRow.append(cutBtn, autoTransBtn);

    const keyerBtn = document.createElement("button");
    keyerBtn.textContent = "Keyer (Farbfläche)";
    let keyerEnabled = false;
    keyerBtn.addEventListener("click", () =>
      call("keyer.setEnabled", { enabled: !keyerEnabled }),
    );

    const dveBtn = document.createElement("button");
    dveBtn.textContent = "DVE PIP";
    let dvePipActive = false;
    dveBtn.addEventListener("click", () =>
      dvePipActive ? call("dve.reset") : call("dve.setBox", PIP_BOX),
    );

    fxRow.append(keyerBtn, dveBtn);

    const refresh = async () => {
      const [inputsRes, programRes, presetRes, keyerRes, dveRes] = await Promise.all([
        fetch(`/api/v1/nodes/${nodeId}/params/crosspoint.inputs`),
        fetch(`/api/v1/nodes/${nodeId}/params/crosspoint.programInput`),
        fetch(`/api/v1/nodes/${nodeId}/params/crosspoint.presetInput`),
        fetch(`/api/v1/nodes/${nodeId}/params/keyer.enabled`),
        fetch(`/api/v1/nodes/${nodeId}/params/dve.box`),
      ]);
      if (!inputsRes.ok || !programRes.ok || !presetRes.ok) return;
      const inputs = (await inputsRes.json()).value || [];
      const program = (await programRes.json()).value || "";
      const preset = (await presetRes.json()).value || "";
      keyerEnabled = keyerRes.ok ? (await keyerRes.json()).value === true : false;
      const dveBox = dveRes.ok ? (await dveRes.json()).value : null;
      dvePipActive = !!dveBox && dveBox.width < WIDTH;

      presetRow.innerHTML = "";

      const blackBtn = document.createElement("button");
      blackBtn.textContent = "Schwarz";
      blackBtn.className = [preset === "" ? "preset-active" : "", program === "" ? "on-air" : ""]
        .filter(Boolean)
        .join(" ");
      blackBtn.addEventListener("click", () => call("crosspoint.select", { senderId: "" }));
      presetRow.append(blackBtn);

      for (const input of inputs) {
        const btn = document.createElement("button");
        btn.textContent = input.label;
        btn.className = [
          input.senderId === preset ? "preset-active" : "",
          input.senderId === program ? "on-air" : "",
        ]
          .filter(Boolean)
          .join(" ");
        btn.addEventListener("click", () => call("crosspoint.select", { senderId: input.senderId }));
        presetRow.append(btn);
      }

      if (inputs.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = "keine Quellen entdeckt";
        presetRow.append(empty);
      }

      keyerBtn.className = keyerEnabled ? "toggle-on" : "";
      dveBtn.className = dvePipActive ? "toggle-on" : "";
    };

    refresh();
    this._interval = setInterval(refresh, 2000);
  }

  disconnectedCallback() {
    clearInterval(this._interval);
  }
}

if (!customElements.get("omp-video-mixer-me-panel")) {
  customElements.define("omp-video-mixer-me-panel", OmpVideoMixerMePanel);
}
