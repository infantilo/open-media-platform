package main

import (
	"context"

	ingestmod "github.com/infantilo/openmediaplatform/orchestrator/internal/modules/ingest"
	mcrmod "github.com/infantilo/openmediaplatform/orchestrator/internal/modules/mcr"
)

// mcrRecorder legt die Aufzeichnung je Leitung als Ad-hoc-Auftrag im Ingest an (keine eigene Aufnahme-Infrastruktur).
type mcrRecorder struct{ m *ingestmod.Module }

func (r mcrRecorder) Start(ctx context.Context, in mcrmod.RecInput) (string, error) {
	start := in.Start
	return r.m.RecordAdHoc(ctx, ingestmod.AdHocInput{
		Name:      in.Name,
		Source:    ingestmod.Source{InstanceID: in.InstanceID, Label: in.LineName},
		Start:     &start,
		DurationS: in.DurationS,
		ProfileID: in.ProfileID,
		Storage:   ingestmod.Storage{Dir: in.Dir},
		Metadata:  map[string]any{"mcrEvent": in.EventID, "mcrEventName": in.EventName, "mcrLine": in.LineID, "mcrLineName": in.LineName},
		Owner:     "mcr",
	}, "mcr")
}

func (r mcrRecorder) Stop(ctx context.Context, jobID string) error {
	return r.m.AbortJob(ctx, jobID, "mcr")
}
