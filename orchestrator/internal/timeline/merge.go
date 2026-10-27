package timeline

import (
	"encoding/json"
	"sort"
	"strconv"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/audit"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/domainaudit"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/logbus"
)

// Quellen, die beim Lesen hinzugemischt werden (je optional).
type AuditLister interface {
	ListFiltered(audit.Filter) ([]audit.Entry, error)
}
type DomainLister interface {
	List(before int64, limit int) ([]domainaudit.Entry, error)
}
type LogLister interface {
	Query(logbus.Filter) ([]logbus.Entry, error)
}

// Sources führt Betriebsereignisse, Bedienungen, Domänen-Audit und Fehler-Logs auf einer Zeitachse zusammen.
type Sources struct {
	Store  *Store
	Audit  AuditLister
	Domain DomainLister
	Logs   LogLister
}

// Item ist eine Zeile der Zeitleiste.
type Item struct {
	ID       string          `json:"id"`
	At       time.Time       `json:"at"`
	Source   string          `json:"source"` // event | audit | domain | log
	Kind     string          `json:"kind"`
	Severity string          `json:"severity"`
	Subject  string          `json:"subject,omitempty"`
	Actor    string          `json:"actor,omitempty"`
	Data     json.RawMessage `json:"data,omitempty"`
}

// Pfade, die nie auf die Zeitleiste kommen (automatisches Speichern; der Marker steht schon als eigene Zeile da); Bedienung (Regler, Schnitte) nur auf Wunsch:
// tausende Zeilen würden die wichtigen Ereignisse verdrängen.
var (
	alwaysExclude  = []string{"/api/v1/layouts/%", "/api/v1/me/%", "/api/v1/timeline/%"}
	operateExclude = []string{"/api/v1/nodes/%/methods/%", "/api/v1/nodes/%/params/%", "/api/v1/nodes/%/state", "/api/v1/nodes/%/plugins/%"}
)

// maxLogs begrenzt die Fehler-Logs, damit sie die übrigen Ereignisse nicht verdrängen.
const maxLogs = 200

// Query liefert die neuesten limit Zeilen im Fenster [since, until), neueste zuerst.
func (s Sources) Query(since, until time.Time, limit int, includeOperate bool) ([]Item, error) {
	var out []Item
	if s.Store != nil {
		rows, err := s.Store.Query(since, until, limit)
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			out = append(out, Item{ID: "e" + strconv.FormatInt(r.ID, 10), At: r.At, Source: "event", Kind: r.Kind, Severity: r.Severity, Subject: r.Subject, Actor: r.Actor, Data: r.Data})
		}
	}
	if s.Audit != nil {
		f := audit.Filter{Since: since, Until: until, Limit: limit, ExcludeLike: append([]string(nil), alwaysExclude...)}
		if !includeOperate {
			f.ExcludeLike = append(f.ExcludeLike, operateExclude...)
		}
		entries, err := s.Audit.ListFiltered(f)
		if err != nil {
			return nil, err
		}
		for _, e := range entries {
			sev := SevInfo
			if e.Status >= 400 {
				sev = SevWarn
			}
			data, _ := json.Marshal(map[string]any{"method": e.Method, "path": e.Path, "status": e.Status, "nodeId": e.NodeID})
			out = append(out, Item{ID: "a" + strconv.FormatInt(e.ID, 10), At: e.OccurredAt, Source: "audit", Kind: "audit", Severity: sev, Subject: e.NodeID, Actor: e.Username, Data: data})
		}
	}
	if s.Domain != nil {
		entries, err := s.Domain.List(0, limit)
		if err != nil {
			return nil, err
		}
		for _, e := range entries {
			if e.OccurredAt.Before(since) || !e.OccurredAt.Before(until) {
				continue
			}
			data, _ := json.Marshal(map[string]any{"objectType": e.ObjectType, "objectId": e.ObjectID, "action": e.Action, "details": e.Details})
			out = append(out, Item{ID: "d" + strconv.FormatInt(e.ID, 10), At: e.OccurredAt, Source: "domain", Kind: "domain", Severity: SevInfo, Subject: e.ObjectID, Actor: e.Actor, Data: data})
		}
	}
	if s.Logs != nil {
		entries, err := s.Logs.Query(logbus.Filter{Level: "error", Since: since, Until: until, Limit: min(limit, maxLogs)})
		if err != nil {
			return nil, err
		}
		for _, e := range entries {
			subject := e.NodeID
			if subject == "" {
				subject = e.HostID
			}
			data, _ := json.Marshal(map[string]any{"message": e.Message, "source": e.Source, "nodeId": e.NodeID, "hostId": e.HostID, "traceId": e.TraceID})
			out = append(out, Item{ID: "l" + strconv.FormatInt(e.ID, 10), At: e.OccurredAt, Source: "log", Kind: "log", Severity: SevError, Subject: subject, Data: data})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].At.After(out[j].At) })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}
