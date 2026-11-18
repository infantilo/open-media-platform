# Support-Paket und Momentaufnahme auswerten

Drei Wege, alle mit derselben Auswertung (UMSETZUNG.md Kap. 73):

1. **Betrachter** – Administration → Support → „Paket auswerten“: ZIP hochladen (oder bei einer
   gespeicherten Momentaufnahme „Auswerten“). Zeigt Befunde mit nächstem Schritt, Ausfälle,
   Zeitleiste, auffällige Kurven und gruppierte Meldungen.
2. **Bericht** – dieselbe Auswertung als Text:
   `POST /api/v1/admin/support/analyze?format=md` (Body = ZIP) bzw.
   `GET /api/v1/freezes/{id}/analysis?format=md`; `lang=en` für Englisch.
3. **KI** – im Betrachter „Bericht für KI kopieren“ und in ein Gespräch einfügen. Reicht der Bericht
   nicht, die Rohdateien nach der Reihenfolge unten hinzunehmen.

## Anleitung für die KI (mit dem Bericht einfügen)

> Du wertest einen Diagnosebericht der OpenMediaPlatform (Broadcast-Plattform) aus. Gehe so vor:
> 1. Lies „Befunde“; Fehler vor Warnungen. Nenne die wahrscheinlichste Ursache zuerst.
> 2. Lies „Ausfälle“ und „Zeitleiste“ von oben: das früheste Ereignis ist meist die Ursache, spätere sind Folgen.
> 3. Prüfe „Auffällige Messreihen“ (Host-/Prozesslast, wachsender Speicher) zeitlich vor dem Ausfall.
> 4. Prüfe gruppierte Meldungen; gleiche Meldung oft wiederholt = Dauerzustand, einmalig = Auslöser.
> 5. Unterscheide **Beleg** (steht im Bericht) von **Vermutung**; nenne, welche Datei/Messung die Vermutung klären würde.
> 6. Schließe mit höchstens drei konkreten nächsten Schritten. Rate keine Werte, die nicht im Bericht stehen.

## Rohdateien (Reihenfolge, wenn mehr nötig ist)

`selftest.json`/`meta.json` → Zeitleiste (`timeline.json`) → Messreihen (`series/*.json`) →
Pipeline-Zustand (`pipelines/*.json`) → Logs → `system/*`/Host-sysinfo. Jede ZIP enthält eine `README.txt`.

## Grenzen

Flugschreiber nur im Arbeitsspeicher (Orchestrator-Neustart leert ihn), keine Absturzberichte,
kein Videomitschnitt. Passwörter, Tokens und Schlüssel sind im Paket bereits geschwärzt.
