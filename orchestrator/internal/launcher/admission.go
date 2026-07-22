package launcher

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/infantilo/openmediaplatform/tools/contract-check/checker"
)

// Admission-Check (§17 Teil 4, Nutzerentscheidung 2026-07-20:
// "Mindestprüfung" statt der von docs/END-GOAL-FEATURES.md §17.4
// eigentlich empfohlenen Variante ohne Verifikation) — ImportCatalog-
// Entry startet den Kandidaten testweise als eigenen, isolierten
// Container und lässt tools/contract-check/checker exakt denselben
// Node-Contract-Check laufen, den `make contract` gegen jeden
// projekteigenen Node fährt (UMSETZUNG.md C9). Erst bei durchweg PASS/
// SKIP (kein FAIL) wird der Eintrag persistiert — ein FAIL (z. B. keine
// IS-04-Registrierung, ungültiges descriptor.json) lehnt den Import ab.
// Der Test-Container läuft komplett unabhängig von einer später über
// `Start()` erzeugten "echten" Instanz und wird in jedem Fall (Erfolg
// wie Fehlschlag) wieder gestoppt.

const (
	admissionPollInterval   = 300 * time.Millisecond
	admissionStartupTimeout = 15 * time.Second
	admissionStopGrace      = 5 * time.Second
	admissionHTTPTimeout    = 5 * time.Second
)

var (
	admissionSchemaOnce sync.Once
	admissionSchemaVal  *jsonschema.Schema
	admissionSchemaErr  error
)

// loadAdmissionSchema kompiliert docs/descriptor-v0.schema.json genau
// einmal pro Orchestrator-Prozess (gleiche Datei, gleiches Schema wie
// `make contract`, s. checker.DefaultSchemaPath) — ein Import ist ein
// seltener, bewusster Vorgang, für den ein einmaliges Kompilieren pro
// Prozesslaufzeit unproblematisch ist; wiederholtes Neukompilieren pro
// Import wäre unnötige Arbeit ohne Nutzen (das Schema ändert sich nicht
// zur Laufzeit).
func loadAdmissionSchema() (*jsonschema.Schema, error) {
	admissionSchemaOnce.Do(func() {
		compiler := jsonschema.NewCompiler()
		admissionSchemaVal, admissionSchemaErr = compiler.Compile(checker.DefaultSchemaPath())
	})
	return admissionSchemaVal, admissionSchemaErr
}

// ErrAdmissionCheckFailed wird von ImportCatalogEntry geliefert, wenn
// der C9-Contract-Check gegen den Kandidaten-Container mindestens ein
// FAIL ergab — Results trägt den vollständigen Report (alle Zeilen, wie
// im `make contract`-Log), damit der Aufrufer (httpapi-Handler) dem
// Import-Nutzer zeigen kann, woran es lag, statt nur "abgelehnt".
type ErrAdmissionCheckFailed struct {
	Results []checker.Result
}

func (e *ErrAdmissionCheckFailed) Error() string {
	for _, r := range e.Results {
		if r.Status == checker.StatusFail {
			return fmt.Sprintf("admission check failed: %s: %s", r.Name, r.Detail)
		}
	}
	return "admission check failed"
}

// runAdmissionCheck startet entry als Wegwerf-Container (eigene
// Instanz-ID, eigener Port, komplett getrennt von jeder über Start()
// erzeugten Instanz desselben Typs), wartet bis er antwortet, lässt
// checker.Run laufen und stoppt den Container in jedem Fall wieder —
// auch bei einem Fehlschlag bleibt kein Test-Container zurück.
//
// Nur runnerPodman mit gesetztem Image wird geprüft (entry.Runner
// muss bereits vom Aufrufer validiert sein, s. ImportCatalogEntry) —
// Import ist per Nutzerentscheidung ohnehin ausschließlich für
// Container-Images vorgesehen (§17.3d), es gibt also keinen
// "Prozess-Import"-Fall, für den dieser Check etwas anderes tun müsste.
func runAdmissionCheck(entry CatalogEntry, registryURL, natsURL string) ([]checker.Result, error) {
	schema, err := loadAdmissionSchema()
	if err != nil {
		return nil, fmt.Errorf("launcher: admission check: descriptor schema not compilable: %w", err)
	}

	id, err := newInstanceID()
	if err != nil {
		return nil, fmt.Errorf("launcher: admission check: %w", err)
	}
	label := "admission-check-" + id[:8]

	// Kein LaunchSecret/OrchestratorURL: der Admission-Check-Container
	// wird sofort wieder gestoppt (s. defer unten), braucht keine
	// Service-Token-Fähigkeit (ARCHITECTURE.md §24.1).
	containerID, port, err := runPodmanEntry(entry, id, label, "", nil, registryURL, "", natsURL)
	if err != nil {
		return nil, fmt.Errorf("launcher: admission check: start candidate container: %w", err)
	}
	defer func() {
		if stopErr := stopPodmanContainer(containerID, admissionStopGrace); stopErr != nil {
			slog.Warn("launcher: admission check: failed to stop temporary container",
				"containerID", containerID, "error", stopErr)
		}
	}()

	nodeURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	client := &http.Client{Timeout: admissionHTTPTimeout}

	deadline := time.Now().Add(admissionStartupTimeout)
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	if err := waitForAdmissionCandidateReady(ctx, client, nodeURL); err != nil {
		return nil, fmt.Errorf("launcher: admission check: candidate never became reachable at %s: %w", nodeURL, err)
	}

	return runContractCheckUntilRegistered(ctx, client, nodeURL, registryURL, schema), nil
}

// runContractCheckUntilRegistered ruft checker.Run wiederholt auf, bis
// entweder IS-04-Registrierung nicht mehr FAIL ist oder ctx abläuft —
// ein einzelner, sofortiger Aufruf direkt nachdem der Kandidat auf HTTP
// reagiert (waitForAdmissionCandidateReady) fängt hier live einen
// echten zeitlichen Wettlauf: das candidate-Binary öffnet seinen
// HTTP-Port, BEVOR es sich bei der Registry registriert (zwei getrennte
// Schritte im Node-Boot, ARCHITECTURE.md §5) — ein sofortiger
// checker.Run direkt danach hat IS-04-Registrierung fast immer als
// falsches FAIL, obwohl der Node sich Millisekunden später völlig
// normal registriert (live beobachtet gegen ein reales omp-mock-Image,
// s. docs/decisions.md). checker.Run mehrfach laufen zu lassen ist
// unproblematisch: der Kandidat ist ein Wegwerf-Container, den niemand
// sonst benutzt, ein wiederholter Param-Roundtrip hat keine
// beobachtbaren Nebenwirkungen außerhalb von ihm selbst. Sobald IS-04-
// Registrierung PASS ist, zählt das Gesamtergebnis dieses Durchlaufs
// (auch wenn andere Checks dort FAIL sind — das sind dann echte
// Contract-Verstöße, keine Zeitartefakte mehr).
func runContractCheckUntilRegistered(ctx context.Context, client *http.Client, nodeURL, registryURL string, schema *jsonschema.Schema) []checker.Result {
	ticker := time.NewTicker(admissionPollInterval)
	defer ticker.Stop()

	for {
		results := checker.Run(client, nodeURL, registryURL, schema)
		registered := true
		for _, r := range results {
			if r.Name == "IS-04-Registrierung" && r.Status == checker.StatusFail {
				registered = false
			}
		}
		if registered {
			return results
		}
		select {
		case <-ctx.Done():
			return results
		case <-ticker.C:
		}
	}
}

// waitForAdmissionCandidateReady pollt GET nodeURL/descriptor.json, bis
// der Kandidat antwortet oder ctx abläuft — Container-Start + eigenes
// Boot des Fremd-Prozesses brauchen etwas Vorlauf, ein sofortiger
// checker.Run-Aufruf direkt nach `podman run -d` würde sonst fast immer
// mit "nicht erreichbar" statt einer echten Contract-Aussage
// fehlschlagen (gleiches Poll-Muster wie workflows.awaitRegistration:
// Ticker statt Sleep-Schleife, damit ctx.Done() sofort greift).
func waitForAdmissionCandidateReady(ctx context.Context, client *http.Client, nodeURL string) error {
	ticker := time.NewTicker(admissionPollInterval)
	defer ticker.Stop()

	for {
		resp, err := client.Get(nodeURL + "/descriptor.json")
		if err == nil {
			// Jede HTTP-Antwort (auch 404) zeigt: der Kandidat nimmt
			// bereits Verbindungen an. Ob /descriptor.json inhaltlich
			// stimmt, prüft checker.CheckDescriptor gleich danach formal
			// — hier geht es nur um "reagiert überhaupt schon".
			resp.Body.Close()
			return nil
		}
		select {
		case <-ctx.Done():
			return errors.New("timed out waiting for candidate container to answer")
		case <-ticker.C:
		}
	}
}
