// Meldet die Texte des Moduls an der Shell an (vor View/Logik laden — s. cloud/register.ts).
import { addMessages } from "../host.ts";
import { messages } from "./messages.ts";

addMessages("de", messages.de);
addMessages("en", messages.en);
