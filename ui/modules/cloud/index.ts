// Einstieg des Cloud-Moduls (UMSETZUNG.md Kapitel 36.3): eigenständiges ESM-Bundle `ui/dist/modules/cloud.js`. Die Shell lädt es
// anhand des Manifests (GET /api/v1/modules), das Bundle meldet seine Texte an und registriert das Custom Element.
import { addMessages } from "../host.ts";
import { messages } from "./messages.ts";
import "./cloud-view.ts";

addMessages("de", messages.de);
addMessages("en", messages.en);
