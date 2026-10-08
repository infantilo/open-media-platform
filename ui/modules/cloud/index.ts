// Einstieg des Cloud-Moduls (UMSETZUNG.md Kapitel 36.3): eigenständiges ESM-Bundle `ui/dist/modules/cloud.js`. Die Shell lädt es
// anhand des Manifests (GET /api/v1/modules), das Bundle meldet seine Texte an und registriert das Custom Element.
import "./register.ts"; // zuerst: Texte anmelden, bevor View/Logik laden
import "./cloud-view.ts";
