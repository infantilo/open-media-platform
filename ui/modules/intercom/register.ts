// Meldet die Texte des Moduls an der Shell an (muss vor View/Logik ausgewertet werden, s. Cloud-Modul).
import { addMessages } from "../host.ts";
import { messages } from "./messages.ts";

addMessages("de", messages.de);
addMessages("en", messages.en);
