// Reiner Seiteneffekt-Sammel-Import (ARCHITECTURE.md §22.2, K3/K4-Teil-1):
// registriert alle `ui/kit`-Bausteine einmal global, wenn die Shell
// startet (`shell.ts` importiert diese Datei) — customElements ist
// dokumentweit gültig, jedes per `import("<apiBase>/ui/bundle.js")`
// nachgeladene Node-UI-Bundle (`ui/shell/ui-bundle.ts`) kann die Tags
// danach in seinem eigenen Shadow-DOM verwenden, ohne selbst zu
// importieren (§4.5: kein Framework-Zwang, Nutzung bleibt optional).
import "./omp-button.ts";
import "./omp-fader.ts";
import "./omp-knob.ts";
import "./omp-meter.ts";
import "./omp-panel-section.ts";
