package workflows

import (
	"database/sql"
	"encoding/json"
	"errors"
	"sync"
	"time"
)

// ErrNotFound wird geliefert, wenn kein Workflow mit dieser ID existiert.
var ErrNotFound = errors.New("workflows: not found")

// Store liest/schreibt Workflows in der `workflows`-Tabelle
// (internal/db/migrations/0004_workflows.sql) — ein Blob pro Workflow,
// gleiches Muster wie internal/snapshots.Store.
type Store struct {
	db *sql.DB

	idxMu sync.Mutex
	idx   *roleIndex

	listMu    sync.Mutex
	listCache []Workflow
	listAt    time.Time
}

// listCacheTTL begrenzt die Gültigkeit der geteilten Nur-Lese-Liste (ListShared);
// eigene Schreibzugriffe verwerfen sie sofort, die TTL fängt andere Orchestratoren ab.
const listCacheTTL = time.Second

// roleIndexTTL begrenzt, wie lange der Rollen-Index ohne eigenen Schreibzugriff
// gilt (Schreibzugriffe dieses Prozesses verwerfen ihn sofort; die TTL fängt
// nur Änderungen durch andere Orchestrator-Instanzen ab).
const roleIndexTTL = 3 * time.Second

type roleRef struct {
	workflowID, label, role, instanceID string
}

// roleIndex bildet Node-ID und Instanz-ID auf (Workflow, Rolle) ab — ersetzt
// den früheren Voll-Scan aller Workflows pro Berechtigungsprüfung.
type roleIndex struct {
	byNode     map[string]roleRef
	byInstance map[string]roleRef
	builtAt    time.Time
}

func (s *Store) buildRoleIndex(wfs []Workflow) *roleIndex {
	idx := &roleIndex{byNode: map[string]roleRef{}, byInstance: map[string]roleRef{}, builtAt: time.Now()}
	for _, wf := range wfs {
		label := wf.Definition.Title
		if label == "" {
			label = wf.Name
		}
		for r, rt := range wf.Runtime {
			ref := roleRef{workflowID: wf.ID, label: label, role: r, instanceID: rt.InstanceID}
			if rt.NodeID != "" {
				idx.byNode[rt.NodeID] = ref
			}
			if rt.InstanceID != "" {
				idx.byInstance[rt.InstanceID] = ref
			}
		}
	}
	return idx
}

func (s *Store) invalidateRoleIndex() {
	s.idxMu.Lock()
	s.idx = nil
	s.idxMu.Unlock()
	s.listMu.Lock()
	s.listCache = nil
	s.listMu.Unlock()
}

// ListShared liefert wie List alle Workflows, aber aus einem kurzlebigen
// gemeinsamen Cache (Lastfund 2026-11-12: GET /workflows dekodierte pro Aufruf
// alle Blobs = 43 % der Orchestrator-CPU bei 100 Clients). Das Ergebnis darf
// NICHT verändert werden — nur zum Lesen/Serialisieren; wer ändert, nimmt List.
func (s *Store) ListShared() ([]Workflow, error) {
	s.listMu.Lock()
	defer s.listMu.Unlock()
	if s.listCache != nil && time.Since(s.listAt) < listCacheTTL {
		return s.listCache, nil
	}
	l, err := s.List()
	if err != nil {
		return nil, err
	}
	s.listCache, s.listAt = l, time.Now()
	return l, nil
}

// roleIndex liefert den (ggf. neu aufgebauten) Index. Der Index wird unter
// idxMu gebaut, damit parallele Aufrufer nicht alle gleichzeitig List() lesen.
func (s *Store) roleIndex() (*roleIndex, error) {
	s.idxMu.Lock()
	defer s.idxMu.Unlock()
	if s.idx != nil && time.Since(s.idx.builtAt) < roleIndexTTL {
		return s.idx, nil
	}
	wfs, err := s.List()
	if err != nil {
		return nil, err
	}
	idx := s.buildRoleIndex(wfs)
	s.idx = idx
	return idx, nil
}

// NewStore erstellt einen Store auf der gegebenen, bereits migrierten
// Datenbankverbindung.
func NewStore(database *sql.DB) *Store {
	return &Store{db: database}
}

// Put speichert (oder überschreibt) einen Workflow.
func (s *Store) Put(wf Workflow) error {
	defer s.invalidateRoleIndex()
	data, err := json.Marshal(wf)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`
		INSERT INTO workflows (id, status, updated_at, data, owner_org_id) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at, data = EXCLUDED.data, owner_org_id = EXCLUDED.owner_org_id
	`, wf.ID, wf.Status, wf.UpdatedAt, data, ownerOrgIDOrDefault(wf.OwnerOrgID))
	return err
}

// ownerOrgIDOrDefault spiegelt organizations.DefaultOrgID (bewusst
// dupliziert statt importiert, gleiches Muster wie auth.Service.
// DefaultOrgID — vermeidet einen Paket-Zyklus für eine einzelne
// Konstante). Ein leerer Wert entsteht bei jedem Workflow, der vor
// Kapitel 21 B14 angelegt wurde bzw. dessen Aufrufer (noch) kein OrgID
// mitgibt.
func ownerOrgIDOrDefault(id string) string {
	if id == "" {
		return "default"
	}
	return id
}

// Get liest einen einzelnen Workflow.
func (s *Store) Get(id string) (Workflow, error) {
	var data []byte
	err := s.db.QueryRow(`SELECT data FROM workflows WHERE id = $1`, id).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return Workflow{}, ErrNotFound
	}
	if err != nil {
		return Workflow{}, err
	}
	var wf Workflow
	if err := json.Unmarshal(data, &wf); err != nil {
		return Workflow{}, err
	}
	return wf, nil
}

// List liefert alle gespeicherten Workflows, älteste zuerst.
func (s *Store) List() ([]Workflow, error) {
	rows, err := s.db.Query(`SELECT data FROM workflows ORDER BY id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Workflow{}
	for rows.Next() {
		var data []byte
		if err := rows.Scan(&data); err != nil {
			return nil, err
		}
		var wf Workflow
		if err := json.Unmarshal(data, &wf); err != nil {
			continue
		}
		out = append(out, wf)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// Delete entfernt einen Workflow. Kein Fehler, wenn er nicht existiert
// (idempotent, gleiches Muster wie launcher.Stop bei unbekannter ID).
func (s *Store) Delete(id string) error {
	defer s.invalidateRoleIndex()
	_, err := s.db.Exec(`DELETE FROM workflows WHERE id = $1`, id)
	return err
}

// UpdateRuntime speichert wf wie Put(), bewahrt aber den aktuell in der
// DB stehenden definition.schedules-Pfad (statt ihn mit wf's ggf.
// veraltetem Stand zu überschreiben). Für alle Lifecycle-Schreibzugriffe
// gedacht, die nur Status/Error/Runtime ändern wollen — Start(),
// runStart(), fail(), Stop(), runStop(), rewireAfterRestart(): diese
// laufen teils als Hintergrund-Goroutine über mehrere Sekunden und
// halten dabei nur einen zu ihrem eigenen Start erfassten wf-Stand; ein
// normales Put() würde eine zwischenzeitliche Scheduler-Änderung an
// schedules (Store.UpdateSchedules) unbemerkt rückgängig machen (live
// gefunden 2026-07-18, docs/decisions.md: ein "once"-Schedule feuerte
// dadurch wiederholt). Create()/Update() bleiben bei Put() — dort *ist*
// eine neue Definition (inkl. schedules) die gewollte, vom Nutzer
// stammende Änderung.
func (s *Store) UpdateRuntime(wf Workflow) error {
	defer s.invalidateRoleIndex()
	data, err := json.Marshal(wf)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`
		UPDATE workflows SET
			status = $2,
			updated_at = $3,
			data = jsonb_set($4::jsonb, '{definition,schedules}', COALESCE(data #> '{definition,schedules}', '[]'::jsonb))
		WHERE id = $1
	`, wf.ID, wf.Status, wf.UpdatedAt, data)
	return err
}

// UpdateSchedules schreibt ausschließlich den definition.schedules-Pfad
// des JSONB-Blobs (D7 Teil 2, Scheduler.persistSchedule) — bewusst kein
// Get()+Put() des ganzen Workflows: runStart/runStop/rewireAfterRestart
// laufen als Hintergrund-Goroutinen und schreiben über mehrere Sekunden
// hinweg wiederholt den *gesamten* zu ihrem eigenen Start erfassten
// wf-Stand zurück (Status/Runtime) — ein zwischenzeitliches Get()+Put()
// des Schedulers würde von einem SPÄTEREN dieser Blind-Overwrite-Puts
// wieder verworfen (live gefunden 2026-07-18, docs/decisions.md: ein
// "once"-Schedule feuerte dreimal, weil LastFiredAt exakt so verloren
// ging). jsonb_set ändert nur den einen Unterpfad und kollidiert daher
// nie mit einem parallelen Put(), das status/runtime/error schreibt.
func (s *Store) UpdateSchedules(id string, schedules []Schedule) error {
	defer s.invalidateRoleIndex()
	if schedules == nil {
		schedules = []Schedule{}
	}
	data, err := json.Marshal(schedules)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`
		UPDATE workflows SET data = jsonb_set(data, '{definition,schedules}', $2::jsonb) WHERE id = $1
	`, id, data)
	return err
}

// SetRoleState speichert (überschreibt) den zuletzt erfassten
// Bedienzustand genau einer Rolle (Migration 0011) — gezielter
// jsonb_set auf den einen Rollen-Schlüssel statt Get()+Put() des ganzen
// Workflows, gleicher Rennlauf-Grund wie UpdateSchedules (s. dort):
// runStop() erfasst den Zustand mehrerer Rollen nacheinander, während
// parallel eine andere Lifecycle-Operation den Rest des Objekts
// schreiben könnte.
func (s *Store) SetRoleState(id, role string, state json.RawMessage) error {
	_, err := s.db.Exec(`
		UPDATE workflows SET
			role_state_backup = CASE
				WHEN role_state ? $2 AND length(($3::jsonb)::text) < length((role_state -> $2)::text)
				THEN jsonb_set(role_state_backup, ARRAY[$2], role_state -> $2)
				ELSE role_state_backup END,
			role_state = jsonb_set(role_state, ARRAY[$2], $3::jsonb)
		WHERE id = $1
	`, id, role, []byte(state))
	return err
}

// ClearRoleState verwirft alle erfassten Bedienzustände eines Workflows
// (Bugfix 2026-07-26: "Mixer merkt sich nach Stop/Start immer noch die
// Sources" — bei jedem Update() aufgerufen). Ein gespeicherter Zustand
// referenziert Rollen/Positionen der Topologie, für die er erfasst
// wurde (role:<name>:sender:<index>-Aliase, s. state.go); ändert sich
// diese Topologie (Rolle entfernt/umbenannt, Verkabelung geändert), ist
// der alte Zustand nicht mehr gültig — ein blindes Weiter-Restaurieren
// hätte sonst z. B. den Mixer nach dem nächsten Start wieder auf eine
// inzwischen entfernte oder anders verkabelte Quelle gesetzt.
func (s *Store) ClearRoleState(id string) error {
	// Vorher je Rolle sichern (role_state_backup): ein Loeschen darf nie der einzige Stand sein.
	_, err := s.db.Exec(`UPDATE workflows SET role_state_backup = coalesce((
		SELECT jsonb_object_agg(k, v) FROM (
			SELECT DISTINCT ON (k) k, v FROM (
				SELECT key AS k, value AS v FROM jsonb_each(role_state_backup)
				UNION ALL SELECT key, value FROM jsonb_each(role_state)
			) u ORDER BY k, length(v::text) DESC
		) m), '{}'::jsonb), role_state = '{}'::jsonb WHERE id = $1`, id)
	return err
}

// RestoreRoleStateBackup kopiert die Sicherungskopie zurueck in den aktiven Rollen-Zustand (Rollen, die dort schon
// einen Eintrag haben, werden ueberschrieben). Rueckgabe: Anzahl wiederhergestellter Rollen.
func (s *Store) RestoreRoleStateBackup(id string) (int, error) {
	var n int
	err := s.db.QueryRow(`
		WITH u AS (
			UPDATE workflows SET role_state = role_state || role_state_backup WHERE id = $1
			RETURNING (SELECT count(*) FROM jsonb_object_keys(role_state_backup)) AS n
		) SELECT coalesce(max(n), 0) FROM u`, id).Scan(&n)
	return n, err
}

// GetRoleState liefert die zuletzt erfassten Bedienzustände aller
// Rollen (roleName -> opaker Zustands-Blob). Leere Map, kein Fehler,
// wenn noch nie einer erfasst wurde oder der Workflow nicht existiert
// — Start() versucht dann für keine Rolle eine Wiederherstellung,
// identisches Verhalten zu "vor diesem Feature".
func (s *Store) GetRoleState(id string) (map[string]json.RawMessage, error) {
	var raw []byte
	err := s.db.QueryRow(`SELECT role_state FROM workflows WHERE id = $1`, id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) || raw == nil {
		return map[string]json.RawMessage{}, nil
	}
	if err != nil {
		return nil, err
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}
