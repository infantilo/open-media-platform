// Package jobwire ist die gemeinsame Beschreibung des Wire-Formats zwischen Orchestrator und Host-Agent für ffmpeg-Jobs
// (docs/ENTWURF-FFMPEG-HOSTWAHL.md). Beide Seiten importieren diese Typen — es gibt keine zweite, von Hand gepflegte Kopie,
// die auseinanderlaufen könnte.
package jobwire

// Aktionen auf omp.host.<hostId>.cmd (Request.Action).
const (
	ActionExec   = "exec"
	ActionCancel = "exec-cancel"
	ActionList   = "exec-list"
	ActionPause  = "exec-pause"
	ActionResume = "exec-resume"
	ActionNice   = "exec-nice"
)

// IsAction: gehört die Aktion zu den Job-Aktionen?
func IsAction(a string) bool {
	switch a {
	case ActionExec, ActionCancel, ActionList, ActionPause, ActionResume, ActionNice:
		return true
	}
	return false
}

// Exec sind die Job-Felder eines Kommandos. Im Host-Agent ist es in commands.Request eingebettet (JSON-flach), im
// Orchestrator bildet es mit Action zusammen die Anfrage (s. Request).
type Exec struct {
	JobID    string   `json:"jobId,omitempty"`
	Tool     string   `json:"tool,omitempty"`
	Args     []string `json:"args,omitempty"`
	TimeoutS int      `json:"timeoutS,omitempty"`
	Nice     int      `json:"nice,omitempty"`
}

// Request ist die vollständige Job-Anfrage des Orchestrators.
type Request struct {
	Action string `json:"action"`
	Exec
}

// Event ist die auf EventSubject veröffentlichte Nachricht des Agents.
type Event struct {
	Type       string   `json:"type"` // started | progress | stdout | done
	JobID      string   `json:"jobId"`
	PID        int      `json:"pid,omitempty"`
	Line       string   `json:"line,omitempty"`  // progress: letzte stderr-Zeile
	Seq        int      `json:"seq,omitempty"`   // stdout: laufende Nummer des Stücks
	Data       []byte   `json:"data,omitempty"`  // stdout-Stück
	ExitCode   int      `json:"exitCode"`        // done
	Error      string   `json:"error,omitempty"` // done: Ausführungsfehler (≠ Exit-Code des Programms)
	Tail       []string `json:"tail,omitempty"`  // done: letzte stderr-Zeilen
	Chunks     int      `json:"chunks,omitempty"`
	DurationMs int64    `json:"durationMs,omitempty"`
}

// DetailRejected steht in der Antwort auf eine Anfrage, die der Agent aus grundsätzlichen Gründen ablehnt (Programm nicht freigegeben,
// Pfad außerhalb der Wurzeln, gesperrtes Protokoll): ein anderer Versuch oder Host ändert daran nichts, der Job schlägt fehl.
// Ohne dieses Detail (Job-Grenze erreicht, Prozess nicht startbar) ist der Fehler vorübergehend und wird wiederholt.
const DetailRejected = "rejected"

// Fehlertexte, an denen der Orchestrator Ereignisse unterscheidet.
const (
	ErrCancelled = "abgebrochen"
	ErrTimeout   = "Zeitlimit überschritten"
)

// EventSubject: Subject der Ereignisse eines Jobs — bewusst außerhalb von `omp.>`, damit sie nicht als SSE an Browser gehen.
func EventSubject(hostID, jobID string) string { return "omp-job." + hostID + "." + jobID }

// EventSubjectAll: alle Job-Ereignisse eines Hosts.
func EventSubjectAll(hostID string) string { return "omp-job." + hostID + ".>" }

// CommandSubject: Kommandokanal eines Host-Agents.
func CommandSubject(hostID string) string { return "omp.host." + hostID + ".cmd" }

// Info ist die Fähigkeitsmeldung des Agents (Teil der Telemetrie).
type Info struct {
	Tools       map[string]ToolInfo `json:"tools"`
	JobRoots    []string            `json:"jobRoots"`
	MaxJobs     int                 `json:"maxJobs"`
	JobsRunning int                 `json:"jobsRunning"`
	AllowNet    bool                `json:"allowNet,omitempty"`
}

// ToolInfo: Version und Fähigkeiten eines Programms (beim Agent-Start ermittelt).
type ToolInfo struct {
	Version  string   `json:"version,omitempty"`
	Encoders []string `json:"encoders,omitempty"`
	Decoders []string `json:"decoders,omitempty"`
	Hwaccels []string `json:"hwaccels,omitempty"`
}

// JobInfo beschreibt einen laufenden Job (exec-list).
type JobInfo struct {
	JobID  string `json:"jobId"`
	Tool   string `json:"tool"`
	PID    int    `json:"pid"`
	Paused bool   `json:"paused,omitempty"`
}
