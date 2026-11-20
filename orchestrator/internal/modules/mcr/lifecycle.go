package mcr

import "github.com/infantilo/openmediaplatform/orchestrator/internal/statemachine"

// Lebenszyklus (ARCHITECTURE §33.2 M8): planned → testing → live → teardown → done; außerdem cancelled aus planned/testing;
// testing → planned ist erlaubt (Umbau), sonst nur vorwärts.
var lifecycle = statemachine.New([][2]string{
	{StatePlanned, StateTesting},
	{StateTesting, StatePlanned},
	{StateTesting, StateLive},
	{StateLive, StateTeardown},
	{StateTeardown, StateDone},
	{StatePlanned, StateCancelled},
	{StateTesting, StateCancelled},
})

// Graph liefert die erlaubten Übergänge (für die Oberfläche, damit sie sie nicht kopiert).
func Graph() map[string][]string { return lifecycle.Graph() }

// deletable: Löschen nur in planned, done, cancelled.
func deletable(state string) bool {
	return state == StatePlanned || state == StateDone || state == StateCancelled
}

// structureLocked: ab `teardown` ändert sich nichts mehr; in `live` dürfen nur Einstellungen (nicht die Leitungsstruktur) geändert werden.
func editable(state string) bool {
	return state == StatePlanned || state == StateTesting || state == StateLive
}
