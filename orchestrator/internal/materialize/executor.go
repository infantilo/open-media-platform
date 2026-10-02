package materialize

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/process"
)

// Executor führt den Prozess-Schritt `materialize` aus: die Execution-Eingabe ist eine Spec. Der Schritt
// startet (idempotent) den Kopier-Job und meldet `ErrStepWaiting`, bis er fertig ist — die Engine pollt;
// ein Orchestrator-Neustart mittendrin nimmt die Execution wieder auf und der Job startet erneut
// (bereits vollständig vorhandene Dateien werden erkannt).
type Executor struct{ Manager *Manager }

// Execute implementiert process.StepExecutor.
func (e Executor) Execute(_ context.Context, ec process.ExecutionCtx, _ process.Step) (json.RawMessage, error) {
	var spec Spec
	if err := json.Unmarshal(ec.Execution.Input, &spec); err != nil || spec.RepresentationID == "" || spec.FileName == "" {
		return nil, fmt.Errorf("materialize: Execution-Eingabe ist keine gültige Spec: %v", err)
	}
	job := e.Manager.EnsureAttempt(spec, max(ec.StepExec.Attempt, 1))
	switch job.State {
	case "running":
		return nil, process.ErrStepWaiting
	case "failed":
		return nil, errors.New(job.Error)
	}
	out, _ := json.Marshal(map[string]any{"fileName": spec.FileName, "bytes": job.Bytes, "target": spec.Target})
	return out, nil
}

// ProcessStore ist der Ausschnitt von *process.Store, den der Starter braucht.
type ProcessStore interface {
	ListDefinitions() ([]process.ProcessDefinition, error)
	CreateDefinition(name, description, category, createdBy, ownerOrgID string) (process.ProcessDefinition, error)
	CreateVersion(processDefinitionID string, definition process.Definition, createdBy string) (process.ProcessVersion, error)
	ListVersions(processDefinitionID string) ([]process.ProcessVersion, error)
	PublishVersion(id string) (process.ProcessVersion, error)
}

// ProcessEngine startet Executions (*process.Engine).
type ProcessEngine interface {
	Start(params process.CreateExecutionParams) (process.ProcessExecution, error)
}

// DefinitionName: Name der automatisch angelegten Prozessdefinition.
const DefinitionName = "Asset materialisieren"

// Starter startet Materialisierungen als OMP-Prozess (sichtbar im Prozess-Bereich, im Audit, abbrechbar).
type Starter struct {
	Store  ProcessStore
	Engine ProcessEngine
}

// ensureVersion legt Definition + veröffentlichte Version an, falls sie fehlen.
func (s *Starter) ensureVersion() (defID, verID string, err error) {
	defs, err := s.Store.ListDefinitions()
	if err != nil {
		return "", "", err
	}
	for _, d := range defs {
		if d.Name == DefinitionName {
			defID = d.ID
			break
		}
	}
	if defID == "" {
		d, err := s.Store.CreateDefinition(DefinitionName, "Kopiert ein Asset-Medium in das Medienverzeichnis eines Players (Playout-Preflight, Kapitel 27 / P8).", "playout", "system", "")
		if err != nil {
			return "", "", err
		}
		defID = d.ID
	}
	versions, err := s.Store.ListVersions(defID)
	if err != nil {
		return "", "", err
	}
	for _, v := range versions {
		if v.Status == process.VersionStatusPublished {
			return defID, v.ID, nil
		}
	}
	v, err := s.Store.CreateVersion(defID, process.Definition{
		StartStepID: "materialize",
		Steps:       []process.Step{{ID: "materialize", Type: process.StepTypeMaterialize, Name: "Medium bereitstellen", TimeoutSeconds: 3600}},
	}, "system")
	if err != nil {
		return "", "", err
	}
	v, err = s.Store.PublishVersion(v.ID)
	if err != nil {
		return "", "", err
	}
	return defID, v.ID, nil
}

// Start startet die Execution und liefert ihre ID.
func (s *Starter) Start(spec Spec, by string) (string, error) {
	defID, verID, err := s.ensureVersion()
	if err != nil {
		return "", err
	}
	in, _ := json.Marshal(spec)
	exec, err := s.Engine.Start(process.CreateExecutionParams{
		ProcessDefinitionID: defID, ProcessVersionID: verID, CreatedBy: by,
		CorrelationID: "materialize:" + strings.ReplaceAll(spec.Key(), "|", ":"), Input: in,
	})
	if err != nil {
		return "", err
	}
	return exec.ID, nil
}

// Preflight bündelt Manager und Starter für die HTTP-Schicht.
type Preflight struct {
	*Manager
	Starter *Starter
}

// Resolve löst eine Referenz zu einer Spec auf.
func (p Preflight) Resolve(ref Ref, target Target) (Spec, error) {
	spec, _, err := Resolve(p.Manager.Assets, ref, target)
	return spec, err
}

// Start startet die Materialisierung als Prozess.
func (p Preflight) Start(spec Spec, by string) (string, error) { return p.Starter.Start(spec, by) }
