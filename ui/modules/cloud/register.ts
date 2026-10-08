// Meldet die Texte des Moduls an der Shell an. Muss VOR dem Laden von View/Logik ausgewertet werden (ES-Module werden in
// Importreihenfolge ausgewertet): manche Logik übersetzt schon beim Laden (Konstanten) — `index.ts` importiert dieses Modul deshalb zuerst.
import { addMessages } from "../host.ts";
import { messages } from "./messages.ts";

addMessages("de", messages.de);
addMessages("en", messages.en);
