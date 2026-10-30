package workflows

// ioPortAssignment ist das Ergebnis eines erfolgreichen I/O-Port-Claims
// für eine Rolle (ARCHITECTURE.md §6.1 Erweiterung 2026-07-10,
// UMSETZUNG.md D13) — anders als der bisherige `map[string]string`
// (nur HostID) wird PortID jetzt mitgeführt, damit runStart/
// executeMigration den tatsächlich geclaimten physischen Port an die
// gestartete Instanz weiterreichen können (s. ioPortExtraEnv-Doku:
// live gefundener Bug, der Claim entschied bislang nur über den
// Ziel-Host, PortID wurde danach verworfen).
type ioPortAssignment struct {
	HostID string
	PortID string
}

// IoPortExtraEnv übersetzt einen erfolgreich geclaimten I/O-Port in die
// vom jeweiligen Node-Typ gelesenen Umgebungsvariablen. Exportiert
// (Nutzerfund 2026-08-20, "deklink node crasht immer noch beim start"):
// `httpapi.handlePostInstance` (direkter Katalog-Start OHNE Workflow-
// Kontext) braucht dieselbe Übersetzung — das war die verbleibende
// Lücke, nachdem der Workflow-Start-Pfad bereits gefixt war (s.
// ioPortAssignment-Doku): ein per Node-Katalog/Instanzen-Tab direkt
// gestarteter `omp-capture-card-decklink` durchlief NIE `workflows.Service.Start()`,
// bekam also nie einen Port zugewiesen, unabhängig vom Workflow-Fix.
//
// Live gefundener Bug (2026-08-20): claimIOPortsForStart/executeMigration
// claimten bereits korrekt einen freien, zum Host passenden Port — der
// PortID-Rückgabewert wurde danach aber verworfen, nie an die gestartete
// Instanz weitergereicht. Jede omp-capture-card-decklink-Instanz startete deshalb
// IMMER mit ihrem eingebauten Default (`OMP_CARD_DEVICE_NUMBER=0`,
// `OMP_CARD_DIRECTION=ingest`, s. nodes/omp-capture-card/src/main.rs),
// unabhängig davon, welcher Port tatsächlich geclaimt wurde — auf einem
// Host mit mehr als einem Port/einer Karte, oder wo Port 0 keine echte
// Hardware ist, scheiterte `set_state(Playing)` ("Karte/Treiber
// prüfen") und der Launcher-Crash-Loop-Brake griff.
//
// PortID-Konvention für CardType="decklink": der vom Host-Agent
// gemeldete `portId` (s. host-agent `OMP_HOST_AGENT_IO_PORTS_PATH`-
// Inventar-Datei) IST die DeckLink-`device-number` als String — exakt
// der Wert, den `decklinkvideosrc`/`decklinkaudiosrc`s `device-number`-
// Property erwartet.
func IoPortExtraEnv(req *IOPortRequirement, portID string) map[string]string {
	if req == nil {
		return nil
	}
	switch req.CardType {
	case "decklink", "aja", "matrox":
		// AJA/Matrox laufen im selben Node (omp-capture-card-decklink-Binary, Kap. 76) und lesen dieselben Variablen.
		direction := "ingest"
		if req.Direction == "out" {
			direction = "output"
		}
		return map[string]string{
			"OMP_CARD_DEVICE_NUMBER": portID,
			"OMP_CARD_DIRECTION":     direction,
		}
	default:
		return nil
	}
}
