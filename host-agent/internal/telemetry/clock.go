package telemetry

import (
	"syscall"

	"github.com/infantilo/openmediaplatform/jobwire/clocksync"
)

// ClockSample ist der Zustand der Systemuhr (Audit 2026-10-23 M1: Zeitbasis wurde nicht geprüft). MXL und die Schaltzeitpunkte
// (takeAt) rechnen in TAI; ohne gesetzten TAI-Versatz fällt CLOCK_TAI mit der UTC-Uhr zusammen (derzeit 37 s daneben), und ohne
// Synchronisation (NTP/PTP) laufen die Uhren verschiedener Hosts auseinander.
type ClockSample struct {
	// Synced: der Kernel meldet die Uhr als synchronisiert (kein STA_UNSYNC).
	Synced bool `json:"synced"`
	// MaxErrorUs/EstErrorUs: obere Grenze und Schätzung des Zeitfehlers in µs (Kernel adjtimex).
	MaxErrorUs int64 `json:"maxErrorUs"`
	EstErrorUs int64 `json:"estErrorUs"`
	// TAIOffsetS: Versatz TAI − UTC in Sekunden; 0 = nicht gesetzt (CLOCK_TAI ist dann falsch).
	TAIOffsetS int `json:"taiOffsetS"`
	// Fix: was der Agent selbst an der Uhr getan hat oder warum nicht (jobwire/clocksync.Fix): "tai-set", "stepped", "slewed",
	// "no-permission", "no-server", "off" oder leer.
	Fix string `json:"fix,omitempty"`
}

const (
	staUnsync = 0x0040 // STA_UNSYNC
	timeError = 5      // TIME_ERROR
)

// TakeClock liest den Uhrzustand über adjtimex(2) ohne die Uhr zu verändern (modes = 0). ok=false, wenn der Aufruf scheitert.
func TakeClock() (ClockSample, bool) {
	var tx syscall.Timex
	state, err := syscall.Adjtimex(&tx)
	if err != nil {
		return ClockSample{}, false
	}
	c := clockFrom(state, int(tx.Status), int64(tx.Maxerror), int64(tx.Esterror), int(tx.Tai))
	c.Fix = clocksync.Fix()
	return c, true
}

func clockFrom(state, status int, maxErr, estErr int64, tai int) ClockSample {
	return ClockSample{
		Synced:     state != timeError && status&staUnsync == 0,
		MaxErrorUs: maxErr,
		EstErrorUs: estErr,
		TAIOffsetS: tai,
	}
}
