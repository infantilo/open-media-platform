// Port-Kompatibilitätslogik für Drag & Drop-Verbindungen (UMSETZUNG.md
// B3). Reine Funktion ohne DOM-Zugriff, damit sie per `deno test` prüfbar
// ist. Format-Strings kommen unverändert aus dem Graph-API (IS-04-Format-
// URNs wie "urn:x-nmos:format:video") — kein eigenes Vokabular.

/** Zwei Ports sind kompatibel, wenn ihre Formate übereinstimmen, oder
 * wenn (mindestens) eines der beiden Formate (noch) unbekannt ist (leerer
 * String — z. B. ein Sender ohne aufgelösten Flow, siehe A5). Ein
 * unbekanntes Format wird nicht vorsorglich als inkompatibel behandelt,
 * damit unvollständig beschriebene Nodes den Editor nicht blockieren. */
export function portsCompatible(senderFormat: string, receiverFormat: string): boolean {
  if (senderFormat === "" || receiverFormat === "") return true;
  return senderFormat === receiverFormat;
}
