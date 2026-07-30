// Node-UI-Bundle des Audio-Monitors (Nutzerwunsch 2026-07-29): spielt
// den MP3-Abhörstrom als <audio controls>. Exaktes Muster von
// omp-viewer/ui/bundle.js (<img src> dort, <audio src> hier) — derselbe
// Grund für den generischen Orchestrator-Stream-Proxy (Auth, kein
// direkter Node-Host-Zugriff des Browsers) und denselben
// ?access_token=-Fallback (<audio src> kann wie <img src> keinen
// Authorization-Header setzen).
class OmpAudioMonitorPanel extends HTMLElement {
  connectedCallback() {
    const nodeId = this.getAttribute("node-id");
    const shadow = this.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; font-family: sans-serif; color: #eee; }
      audio { display: block; width: 100%; }
      p { font-size: 12px; color: #888; }
    `;

    const audio = document.createElement("audio");
    audio.controls = true;
    // Kein autoplay: Browser blockieren Ton-Autoplay ohne Nutzergeste
    // ohnehin, und ein Abhörweg soll sich nicht von selbst einschalten.

    const status = document.createElement("p");
    status.textContent = "Wiedergabe starten zum Abhören.";

    shadow.append(style, audio, status);

    audio.addEventListener("playing", () => {
      status.textContent = "";
    });
    audio.addEventListener("error", () => {
      status.textContent = "kein Audiostrom verfügbar";
    });

    const token = localStorage.getItem("omp-auth-token");
    audio.src = token
      ? `/api/v1/nodes/${nodeId}/stream/audioStreamUrl?access_token=${encodeURIComponent(token)}`
      : `/api/v1/nodes/${nodeId}/stream/audioStreamUrl`;
  }
}

if (!customElements.get("omp-audio-monitor-panel")) {
  customElements.define("omp-audio-monitor-panel", OmpAudioMonitorPanel);
}
