// Einstieg des Moduls „Audio-Ausgabe“ (UMSETZUNG.md Kapitel 36.7): eigenständiges ESM-Bundle `ui/dist/modules/audio-rules.js`. Die Shell
// lädt es anhand des Manifests (GET /api/v1/modules) und zeigt den Editor als Admin-Untertab der Gruppe „Playout“.
import "./register.ts"; // zuerst: Texte anmelden, bevor View/Logik laden
import "./audio-rules-view.ts";
