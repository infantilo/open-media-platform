// Einstieg des Playout-Moduls (UMSETZUNG.md Kapitel 36.8): eigenständiges ESM-Bundle `ui/dist/modules/playout.js`. Die Shell lädt es
// anhand des Manifests (GET /api/v1/modules) und zeigt „Channels & Trigger“ als Admin-Untertab der Gruppe „Playout“.
import "./register.ts"; // zuerst: Texte anmelden, bevor View/Logik laden
import "./playout-admin-view.ts";
