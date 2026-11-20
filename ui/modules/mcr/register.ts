// Meldet die Texte des Moduls an der Shell an (vor dem Laden von View/Logik auswerten — s. index.ts).
import { addMessages } from "../host.ts";
import { messages } from "./messages.ts";

addMessages("de", messages.de);
addMessages("en", messages.en);
