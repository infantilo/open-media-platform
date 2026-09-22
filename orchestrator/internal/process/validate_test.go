package process

import (
	"errors"
	"testing"
)

func validDefinition() Definition {
	return Definition{
		StartStepID: "start",
		Steps: []Step{
			{ID: "start", Type: StepTypeTask, Next: []string{"cond"}},
			{ID: "cond", Type: StepTypeCondition, Branches: map[string]string{
				"valid":   "transcode",
				"invalid": "review",
			}},
			{ID: "transcode", Type: StepTypeMediaFunction, Next: []string{"end"}, CompensationStepID: "rollback"},
			{ID: "review", Type: StepTypeHumanTask, Next: []string{"end"}},
			{ID: "rollback", Type: StepTypeCompensation},
			{ID: "end", Type: StepTypeTask},
		},
	}
}

func TestValidateAcceptsWellFormedGraph(t *testing.T) {
	if err := validDefinition().Validate(); err != nil {
		t.Fatalf("Validate() error = %v, want nil", err)
	}
}

func TestValidateRejectsNoSteps(t *testing.T) {
	d := Definition{StartStepID: "start"}
	if err := d.Validate(); err == nil {
		t.Fatalf("Validate() error = nil, want error for empty steps")
	}
}

func TestValidateRejectsMissingStartStepID(t *testing.T) {
	d := validDefinition()
	d.StartStepID = ""
	if err := d.Validate(); err == nil {
		t.Fatalf("Validate() error = nil, want error for missing startStepId")
	}
}

func TestValidateRejectsUnknownStartStepID(t *testing.T) {
	d := validDefinition()
	d.StartStepID = "does-not-exist"
	if err := d.Validate(); err == nil {
		t.Fatalf("Validate() error = nil, want error for unknown startStepId")
	}
}

func TestValidateRejectsDuplicateStepID(t *testing.T) {
	d := validDefinition()
	d.Steps = append(d.Steps, Step{ID: "start", Type: StepTypeTask})
	if err := d.Validate(); err == nil {
		t.Fatalf("Validate() error = nil, want error for duplicate step id")
	}
}

func TestValidateRejectsEmptyStepID(t *testing.T) {
	d := Definition{StartStepID: "a", Steps: []Step{{ID: "", Type: StepTypeTask}}}
	if err := d.Validate(); err == nil {
		t.Fatalf("Validate() error = nil, want error for empty step id")
	}
}

func TestValidateRejectsMissingStepType(t *testing.T) {
	d := Definition{StartStepID: "a", Steps: []Step{{ID: "a"}}}
	if err := d.Validate(); err == nil {
		t.Fatalf("Validate() error = nil, want error for missing step type")
	}
}

func TestValidateRejectsDanglingNext(t *testing.T) {
	d := Definition{StartStepID: "a", Steps: []Step{
		{ID: "a", Type: StepTypeTask, Next: []string{"nowhere"}},
	}}
	if err := d.Validate(); err == nil {
		t.Fatalf("Validate() error = nil, want error for dangling next reference")
	}
}

func TestValidateRejectsDanglingBranch(t *testing.T) {
	d := Definition{StartStepID: "a", Steps: []Step{
		{ID: "a", Type: StepTypeCondition, Branches: map[string]string{"yes": "nowhere"}},
	}}
	if err := d.Validate(); err == nil {
		t.Fatalf("Validate() error = nil, want error for dangling branch reference")
	}
}

func TestValidateRejectsDanglingCompensation(t *testing.T) {
	d := Definition{StartStepID: "a", Steps: []Step{
		{ID: "a", Type: StepTypeTask, CompensationStepID: "nowhere"},
	}}
	if err := d.Validate(); err == nil {
		t.Fatalf("Validate() error = nil, want error for dangling compensation reference")
	}
}

func TestValidateRejectsUnreachableStep(t *testing.T) {
	d := Definition{StartStepID: "a", Steps: []Step{
		{ID: "a", Type: StepTypeTask},
		{ID: "orphan", Type: StepTypeTask}, // kein Next/Branches zeigt hierher
	}}
	if err := d.Validate(); err == nil {
		t.Fatalf("Validate() error = nil, want error for unreachable step")
	}
}

func TestValidateAllowsCompensationStepWithoutOtherPredecessor(t *testing.T) {
	d := Definition{StartStepID: "a", Steps: []Step{
		{ID: "a", Type: StepTypeTask, CompensationStepID: "rollback"},
		{ID: "rollback", Type: StepTypeCompensation},
	}}
	if err := d.Validate(); err != nil {
		t.Fatalf("Validate() error = %v, want nil (compensation steps are reachable only via CompensationStepID)", err)
	}
}

// TestValidateErrorsAreErrValidation (Phase 5 Teil 2): jeder Validate()-
// Fehler muss per errors.Is als ErrValidation erkennbar sein — die
// HTTP-API verlässt sich darauf, um 400 statt 500 zu melden.
func TestValidateErrorsAreErrValidation(t *testing.T) {
	err := (Definition{}).Validate()
	if !errors.Is(err, ErrValidation) {
		t.Fatalf("Validate() error = %v, want errors.Is(err, ErrValidation)", err)
	}
}
