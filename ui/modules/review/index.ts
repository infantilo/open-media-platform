// Einstieg des Moduls „Eingang / Review“ (UMSETZUNG.md Kapitel 43): eigenständiges ESM-Bundle `ui/dist/modules/review.js`. Die Shell lädt es
// anhand des Manifests (GET /api/v1/modules) und zeigt den Tab „Eingang“ in der Hauptleiste.
import "./register.ts"; // zuerst: Texte anmelden, bevor View/Logik laden
import "./review-view.ts";
