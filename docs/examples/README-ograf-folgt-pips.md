# Demo: OGraf folgt den PIPs

Vorlage: `workflow-ograf-folgt-pips.json` (Import: `POST /api/v1/workflows`).
Rollen: Quelle 1–3, Bildmischer, Grafik (OGraf), Viewer; Verbindung Mischer-PGM → Viewer.

Einrichtung nach dem Start (steckt im gespeicherten Zustand des Demo-Workflows, bei einem neuen Import von Hand):

1. **Bildmischer:** Quellen 1–3 auf PIP-Slot 1–3 legen und einschalten, Posen setzen
   (Leinwand 1280×720: Slot 1 `0,467 427×240`, Slot 2 `438,275`, Slot 3 `847,453`).
2. **Keyer:** Quelle „Grafik“ (Fill) wählen und einschalten (liegt über den PIPs).
3. **Grafik:** Vorlage „PIP-Wand“ auf Ebene `pip-wall` einblenden.
4. **Layout-Kopplung** im Grafik-Panel: je Fenster *Fenster folgt PIP-Slot*, Mischer „Bildmischer“, Slot 1–3.
5. Im Flow-Editor **Im Workflow speichern**, damit der Zustand beim nächsten Start zurückkommt.

Vorführen: im PGM-Monitor ein PIP anklicken – es vergrößert sich, Rahmen/Beschriftung fahren mit, die anderen Fenster blenden aus; zweiter Klick fährt zurück. Slot-Posen ändern → die Grafik folgt.
