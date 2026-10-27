// Kit-Elemente für isolierte Node-Oberflächen (Audit H1, internal/uiorigin): die Bundles erwarten <omp-confirm>/<omp-prompt>/<omp-toast> "global registriert" (sie laufen sonst in der
// Shell). Im iframe auf dem zweiten Ursprung gibt es die Shell nicht — diese Datei registriert dieselben Elemente dort. Ohne sie lehnen die Bundles jede Bestätigung stillschweigend ab.
// Alle Kit-Bausteine (omp-button, -fader, -knob, -meter, -panel-section, -confirm, -prompt, -toast, -source-selector) wie in der Shell.
import "../kit/index.ts";
