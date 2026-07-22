// Node-UI-Bundle des Jingle-/Cart-Players (UMSETZUNG.md C12,
// ARCHITECTURE.md §13.3): Cart-Wall-Grid statt Cue/Take-Liste — ein Klick
// auf eine Kachel ruft `cue(itemId)` gefolgt von `take()` auf ("heißer"
// Trigger, wie ein klassisches Jingle-Pult). Beide Aufrufe landen in
// derselben Reihenfolge in der Pipeline-Kommandowarteschlange
// (`pipeline.rs`s `std::sync::mpsc`-Kanal, FIFO — gleiche Verlässlichkeit
// wie omp-audio-mixers `setSource`-gefolgt-von-`setGain`, C11), das
// sequentielle Await hier ist also sicher, kein Sonderprotokoll nötig.
// Gleiche generische Node-Proxy-API wie alle anderen Node-Panels.
class OmpPlayerJinglePanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; font-family: sans-serif; color: #eee; font-size: 12px; }
      .add-row { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; }
      .add-row input[type="text"] { width: 120px; }
      .add-row button {
        cursor: pointer; padding: 6px 10px; border: 1px solid #4caf50;
        background: #2e7d32; color: #eee; border-radius: 4px;
      }
      .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; }
      .cart {
        position: relative; padding: 14px 8px; border: 1px solid #555; border-radius: 6px;
        background: #222; color: #eee; cursor: pointer; text-align: center; font-weight: bold;
      }
      .cart.onair { background: #2e7d32; border-color: #4caf50; }
      .cart .remove {
        position: absolute; top: 2px; right: 4px; font-size: 10px; font-weight: normal;
        color: #a33; cursor: pointer;
      }
      p.empty { font-size: 12px; color: #888; }
    `;

    const addRow = document.createElement("div");
    addRow.className = "add-row";
    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.placeholder = "Titel";
    // C21 (ARCHITECTURE.md §24.6): Live-MXL-Audioquelle als Cart —
    // gleiches Auswahl-Prinzip wie im Videoplayer-Panel, hier auf
    // Audio-Sender beschränkt (Jingle-Profil discovert nur Audio, s.
    // main.rs).
    const liveSourceSelect = document.createElement("select");
    const liveSourcePlaceholder = document.createElement("option");
    liveSourcePlaceholder.value = "";
    liveSourcePlaceholder.textContent = "Live-Quelle …";
    liveSourceSelect.append(liveSourcePlaceholder);
    const addBtn = document.createElement("button");
    addBtn.textContent = "+ Jingle";
    addBtn.addEventListener("click", () => {
      const senderId = liveSourceSelect.value;
      const body = { label: labelInput.value.trim() || "Jingle", toneFrequency: 0, durationMs: 3000 };
      if (senderId) {
        body.senderId = senderId;
      }
      call("append", body).then(() => {
        labelInput.value = "";
        liveSourceSelect.value = "";
        poll();
      });
    });
    addRow.append(labelInput, liveSourceSelect, addBtn);

    const grid = document.createElement("div");
    grid.className = "grid";
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = '"+ Jingle" zum Anlegen der Cart-Wall';
    shadow.append(style, addRow, grid, empty);

    const call = (method, body) =>
      fetch(`/api/v1/nodes/${nodeId}/methods/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });

    const getParam = async (name) => {
      const res = await fetch(`/api/v1/nodes/${nodeId}/params/${encodeURIComponent(name)}`);
      if (!res.ok) return undefined;
      return (await res.json()).value;
    };

    const trigger = (itemId) =>
      call("cue", { itemId }).then(() => call("take", {})).then(poll);

    // itemId -> { el, removeBtn }
    const cartEls = new Map();

    const createCart = (item) => {
      const el = document.createElement("div");
      el.className = "cart";
      el.addEventListener("click", (ev) => {
        if (ev.target.classList.contains("remove")) return;
        trigger(item.id);
      });
      const labelEl = document.createElement("span");
      const removeBtn = document.createElement("span");
      removeBtn.className = "remove";
      removeBtn.textContent = "x";
      removeBtn.addEventListener("click", () => call("remove", { itemId: item.id }).then(poll));
      el.append(labelEl, removeBtn);
      return { el, labelEl, removeBtn };
    };

    const poll = async () => {
      const [itemsValue, currentItemId, availableSources] = await Promise.all([
        getParam("items"),
        getParam("currentItemId"),
        getParam("availableSources"),
      ]);
      const items = itemsValue || [];
      const sources = availableSources || [];

      const previousSelection = liveSourceSelect.value;
      liveSourceSelect.replaceChildren(liveSourcePlaceholder);
      for (const s of sources) {
        const opt = document.createElement("option");
        opt.value = s.senderId;
        opt.textContent = s.label;
        liveSourceSelect.append(opt);
      }
      if (sources.some((s) => s.senderId === previousSelection)) {
        liveSourceSelect.value = previousSelection;
      }

      const currentIds = new Set(items.map((it) => it.id));

      for (const [id, refs] of cartEls) {
        if (!currentIds.has(id)) {
          refs.el.remove();
          cartEls.delete(id);
        }
      }

      empty.style.display = items.length === 0 ? "" : "none";

      for (const item of items) {
        let refs = cartEls.get(item.id);
        if (!refs) {
          refs = createCart(item);
          cartEls.set(item.id, refs);
          grid.append(refs.el);
        }
        refs.el.classList.toggle("onair", item.id === currentItemId);
        refs.labelEl.textContent = item.label;
      }
    };

    poll();
    this._interval = setInterval(poll, 2000);
  }

  disconnectedCallback() {
    clearInterval(this._interval);
  }
}

if (!customElements.get("omp-player-jingle-panel")) {
  customElements.define("omp-player-jingle-panel", OmpPlayerJinglePanel);
}
