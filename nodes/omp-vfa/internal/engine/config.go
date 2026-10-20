// Package engine entscheidet, welche Kamera in den Bildmischer geschaltet
// wird („Video folgt Audio“). Reine Logik ohne Netzwerk, damit sie mit
// simulierten Pegeln und Gesichtern testbar bleibt.
package engine

// Shot ist eine bestätigte Einstellung: Person erscheint in dieser Kamera
// an dieser Stelle. Die Reihenfolge in Person.Shots ist die Vorliebe.
type Shot struct {
	CameraID    string  `json:"cameraId"`
	CenterX     float64 `json:"centerX"`
	SizePercent float64 `json:"sizePercent"`
}

type Person struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Mic   string `json:"mic"` // Kanal-ID im Tonmischer
	Shots []Shot `json:"shots"`
}

// Camera verbindet die Vision-ID („cam-1“) mit dem Kamera-Node im Workflow.
type Camera struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	NodeID string `json:"nodeId"`
}

type Config struct {
	Enabled    bool     `json:"enabled"`
	VideoMixer string   `json:"videoMixer"` // Node-ID des Bildmischers
	AudioMixer string   `json:"audioMixer"` // Node-ID des Tonmischers
	Cameras    []Camera `json:"cameras"`
	People     []Person `json:"people"`
	// WideCamera ist die Totale; leer = bei Stille bleibt das Bild stehen.
	WideCamera string `json:"wideCamera"`

	SpeakDb       float64 `json:"speakDb"`       // Sprechschwelle (dBFS)
	SpeakHoldMs   int     `json:"speakHoldMs"`   // so lange muss jemand sprechen, bevor geschnitten wird
	MinShotMs     int     `json:"minShotMs"`     // Mindestdauer einer Einstellung
	WideAfterSec  int     `json:"wideAfterSec"`  // Stille bis zur Totalen
	FaceTolerance float64 `json:"faceTolerance"` // erlaubte Abweichung der Gesichtsposition (0..1)
}

func DefaultConfig() Config {
	return Config{SpeakDb: -45, SpeakHoldMs: 700, MinShotMs: 2500, WideAfterSec: 8, FaceTolerance: 0.15}
}

// Face entspricht der Nachricht von omp-vfa-vision.
type Face struct {
	CenterX     float64 `json:"center_x"`
	CenterY     float64 `json:"center_y"`
	SizePercent float64 `json:"size_percent"`
}
