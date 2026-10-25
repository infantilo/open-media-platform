package workflows

import (
	"sync/atomic"
	"time"
)

// durVar ist eine nebenläufig les- und schreibbare Dauer. registrationTimeout/registrationPollInterval werden von Hintergrund-
// Goroutinen (runStart, executeMigration, …) gelesen, während Tests sie umsetzen und danach zurücksetzen — als einfache
// Package-Variablen war das ein Data Race (`go test -race`).
type durVar struct{ v atomic.Int64 }

func newDurVar(d time.Duration) *durVar {
	x := &durVar{}
	x.v.Store(int64(d))
	return x
}

func (d *durVar) Load() time.Duration   { return time.Duration(d.v.Load()) }
func (d *durVar) Store(x time.Duration) { d.v.Store(int64(x)) }
