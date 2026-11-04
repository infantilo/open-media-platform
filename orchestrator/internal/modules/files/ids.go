package files

import "github.com/infantilo/openmediaplatform/orchestrator/internal/tracing"

func newID() string { return tracing.NewID() }
