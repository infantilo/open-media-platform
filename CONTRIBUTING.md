# Mitarbeit und Fehlermeldungen

## Fehler melden
1. Prüfe, ob es das Problem schon als Issue gibt.
2. Öffne ein Issue mit dem Formular „Fehler melden“. Sprache: Deutsch oder Englisch.
3. Hänge das **Support-Paket** an (Support-Tab → „Support-Paket erstellen“, ZIP unverändert hochladen). Beim Erstellen werden
   Passwörter, Tokens, Schlüssel und Zugangsdaten in URLs entfernt. Prüfe trotzdem, was du öffentlich hochlädst.
4. Sicherheitslücken nie öffentlich, siehe `SECURITY.md`.

## Was nach dem Absenden automatisch passiert
- Das Issue bekommt Labels (Bereich, Auswirkung, Zustand des Pakets).
- Ein Bot wertet das Support-Paket aus und hängt den Bericht als Kommentar an. Fehlen Angaben oder das Paket, fragt er einmal nach.
- Antwortet niemand 14 Tage auf eine Nachfrage (`needs-info`), wird das Issue geschlossen. Es kann jederzeit wieder geöffnet werden.
- Ein Mensch prüft jede Meldung. Der Bericht ist eine Hilfe, kein Urteil.

## Code
Regeln für Änderungen stehen in `UMSETZUNG.md` (§0) und `ARCHITECTURE.md`. Tests: `make test`.
