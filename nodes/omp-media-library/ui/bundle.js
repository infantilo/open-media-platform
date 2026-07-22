// Node-UI-Bundle der Media Library (UMSETZUNG.md C17, ARCHITECTURE.md §4.5):
// Katalog-Übersicht mit Scan/Rescan/Cleanup-Aktionen und Segment-Editor.
// Nutzt die gleiche generische Node-Proxy-API wie alle anderen Nodes.

class OmpMediaLibraryPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; font-family: sans-serif; color: #eee; font-size: 12px; }
      .controls { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
      button { cursor: pointer; padding: 8px 14px; border: 1px solid #4caf50;
               background: #2e7d32; color: #eee; border-radius: 4px; }
      button:hover { background: #388e3c; }
      button:disabled { opacity: 0.4; cursor: default; }
      .status { font-size: 11px; color: #aaa; margin: 4px 0; }
      .entries { max-height: 600px; overflow-y: auto; }
      .entry { border: 1px solid #444; border-radius: 4px; padding: 8px;
               margin-bottom: 6px; background: #1a1a1a; }
      .entry-title { font-weight: bold; color: #fff; margin-bottom: 4px; }
      .entry-meta { font-size: 11px; color: #bbb; margin-bottom: 4px; }
      .entry-meta-row { margin: 2px 0; padding-left: 12px; }
      .entry-video { color: #4caf50; }
      .entry-audio { color: #2196f3; }
      .segments { margin-top: 8px; font-size: 11px; }
      .segment { background: #222; padding: 4px 6px; margin: 2px 0; border-radius: 2px; }
      .empty { color: #666; font-style: italic; }
    `;

    const controls = document.createElement("div");
    controls.className = "controls";

    const scanBtn = document.createElement("button");
    scanBtn.textContent = "Full Scan";
    scanBtn.addEventListener("click", () => call("scan", {}).then(() => poll(nodeId)));

    const cleanupBtn = document.createElement("button");
    cleanupBtn.textContent = "Cleanup";
    cleanupBtn.addEventListener("click", () => call("cleanup", {}).then(() => poll(nodeId)));

    const statusEl = document.createElement("div");
    statusEl.className = "status";

    controls.append(scanBtn, cleanupBtn, statusEl);

    const entriesContainer = document.createElement("div");
    entriesContainer.className = "entries";

    shadow.append(style, controls, entriesContainer);

    // Initial poll
    poll(nodeId);

    const pollInterval = setInterval(() => poll(nodeId), 5000);
    this.addEventListener("disconnect", () => clearInterval(pollInterval));

    async function call(methodName, args) {
      const resp = await fetch(`/api/v1/nodes/${nodeId}/methods/${methodName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
      if (!resp.ok) {
        statusEl.textContent = `Error: ${methodName} failed`;
      } else {
        statusEl.textContent = `${methodName} completed`;
      }
    }

    async function poll(nid) {
      const resp = await fetch(`/api/v1/nodes/${nid}/params/entries`);
      if (!resp.ok) return;
      const data = await resp.json();
      const entries = data.value || [];

      entriesContainer.innerHTML = "";
      if (entries.length === 0) {
        entriesContainer.innerHTML = '<div class="empty">No media files found</div>';
        return;
      }

      entries.forEach((entry) => {
        const entryEl = document.createElement("div");
        entryEl.className = "entry";

        const title = document.createElement("div");
        title.className = "entry-title";
        title.textContent = entry.fileName;

        const meta = document.createElement("div");
        meta.className = "entry-meta";

        const durationSec = (entry.durationMs / 1000).toFixed(1);
        const durationRow = document.createElement("div");
        durationRow.className = "entry-meta-row";
        durationRow.textContent = `Duration: ${durationSec}s`;
        meta.append(durationRow);

        if (entry.video) {
          const videoRow = document.createElement("div");
          videoRow.className = "entry-meta-row entry-video";
          videoRow.textContent = `Video: ${entry.video.codec} ${entry.video.width}×${entry.video.height} @${entry.video.fps.toFixed(1)}fps`;
          meta.append(videoRow);
        }

        if (entry.audio.length > 0) {
          entry.audio.forEach((track, idx) => {
            const audioRow = document.createElement("div");
            audioRow.className = "entry-meta-row entry-audio";
            audioRow.textContent = `Audio ${idx + 1}: ${track.codec} ${track.channels}ch @${track.sample_rate}Hz`;
            meta.append(audioRow);
          });
        }

        let segmentContent = "";
        if (entry.segments.length > 0) {
          segmentContent = entry.segments
            .map((s) => {
              const startSec = (s.start / 1000).toFixed(1);
              const endSec = (s.end / 1000).toFixed(1);
              return `${s.label}: ${startSec}s-${endSec}s`;
            })
            .join(", ");
        } else {
          segmentContent = "No segments";
        }
        const segmentsEl = document.createElement("div");
        segmentsEl.className = "segments";
        segmentsEl.innerHTML = `<strong>Segments:</strong> <div class="segment">${segmentContent}</div>`;

        entryEl.append(title, meta, segmentsEl);
        entriesContainer.append(entryEl);
      });
    }
  }
}

customElements.define("omp-media-library-panel", OmpMediaLibraryPanel);
