// Beispiel-Node-UI-Bundle des Mock-Nodes (UMSETZUNG.md B6,
// ARCHITECTURE.md §4.5): ein eigenes Custom Element mit Shadow DOM statt
// des generischen, aus dem Descriptor erzeugten Parameter-Panels. Nutzt
// dieselbe generische Node-Proxy-API wie das Shell-Panel
// (/api/v1/nodes/<id>/params/<name>) — kein Sonderprotokoll.
class OmpMockPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; font-family: sans-serif; color: #eee; }
      .badge {
        display: inline-block; background: #9b59b6; color: #fff;
        padding: 2px 8px; border-radius: 10px; font-size: 11px;
      }
      .gain { font-size: 20px; margin: 8px 0; }
      button { cursor: pointer; margin-right: 6px; }
    `;

    const root = document.createElement("div");
    root.innerHTML = `
      <span class="badge">Eigenes UI-Bundle</span>
      <p class="gain">Gain: <span data-role="gain">…</span> dB</p>
      <button data-role="down">-1 dB</button>
      <button data-role="up">+1 dB</button>
    `;
    shadow.append(style, root);

    const gainEl = root.querySelector('[data-role="gain"]');

    const refresh = async () => {
      const res = await fetch(`/api/v1/nodes/${nodeId}/params/gain`);
      if (res.ok) {
        const body = await res.json();
        gainEl.textContent = body.value;
      }
    };

    const step = async (delta) => {
      const res = await fetch(`/api/v1/nodes/${nodeId}/params/gain`);
      if (!res.ok) return;
      const current = (await res.json()).value;
      await fetch(`/api/v1/nodes/${nodeId}/params/gain`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: current + delta }),
      });
      await refresh();
    };

    root.querySelector('[data-role="down"]').addEventListener("click", () => step(-1));
    root.querySelector('[data-role="up"]').addEventListener("click", () => step(1));

    refresh();
  }
}

if (!customElements.get("omp-mock-panel")) {
  customElements.define("omp-mock-panel", OmpMockPanel);
}
