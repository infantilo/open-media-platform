// Kapitel 109 Stufe C — Befehls-Spiegelung für Live-Standby (Role.StandbyLive): Bedienbefehle an die Primärrolle gehen
// zusätzlich an den Standby (httpapi.commandMirrorTap), damit dessen Zustand der Primärrolle laufend folgt und bei der
// Übernahme nichts zurückgedreht werden muss. Fehlt ein Befehl (Standby nicht erreichbar), wird der Standby beim nächsten
// failoverTick mit dem vollständigen Zustand der Primärrolle nachgezogen (resyncLiveStandby).
//
// Grenze: Die Befehle kommen nacheinander, nicht mit gemeinsamem Zeitstempel („wirksam ab Grain-Index N“, Stufe D) —
// ein Schnitt kann beim Standby ein Bild früher oder später wirken; Auto-Übergänge laufen im Standby ggf. um Bruchteile
// einer Sekunde versetzt.
package workflows

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"
)

// mirrorCacheTTL: so lange gilt eine Auskunft „Node X hat (keinen) Live-Standby“ — hält die Workflow-Liste aus der Datenbank
// aus dem Bedienpfad (Fader erzeugen viele Aufrufe je Sekunde).
const mirrorCacheTTL = time.Second

type mirrorEntry struct {
	url        string // leer = kein Standby
	workflowID string
	role       string
	until      time.Time
}

func (s *Service) mirrorLookup(nodeID string) mirrorEntry {
	s.mirrorMu.Lock()
	if e, ok := s.mirrorCache[nodeID]; ok && time.Now().Before(e.until) {
		s.mirrorMu.Unlock()
		return e
	}
	s.mirrorMu.Unlock()

	e := mirrorEntry{until: time.Now().Add(mirrorCacheTTL)}
	if wfs, err := s.store.List(); err == nil {
	search:
		for _, wf := range wfs {
			if wf.Status != StatusStarted {
				continue
			}
			for _, r := range wf.Definition.Roles {
				if !r.StandbyLive || r.StandbyFor == "" {
					continue
				}
				prt := wf.Runtime[r.StandbyFor]
				if prt.NodeID != nodeID || prt.StandbyActive {
					continue
				}
				if n, ok := s.nodeForRole(wf, r.Name); ok && n.APIBaseURL != "" {
					e.url, e.workflowID, e.role = n.APIBaseURL, wf.ID, r.StandbyFor
				}
				break search
			}
		}
	}
	s.mirrorMu.Lock()
	if s.mirrorCache == nil {
		s.mirrorCache = map[string]mirrorEntry{}
	}
	s.mirrorCache[nodeID] = e
	s.mirrorMu.Unlock()
	return e
}

// MirrorTarget implementiert httpapi.CommandMirror.
func (s *Service) MirrorTarget(nodeID string) (string, bool) {
	e := s.mirrorLookup(nodeID)
	return e.url, e.url != ""
}

// MirrorFailed implementiert httpapi.CommandMirror: ein Befehl kam beim Standby nicht an — beim nächsten Takt nachziehen.
func (s *Service) MirrorFailed(nodeID string) {
	if e := s.mirrorLookup(nodeID); e.workflowID != "" {
		s.resyncPending.Store(e.workflowID+"|"+e.role, struct{}{})
	}
}

// resyncLiveStandby zieht den Live-Standby von primaryRole mit dem aktuellen Bedienzustand der Primärrolle nach: Zustand der
// Primärrolle frisch erfassen und auf den Standby-Node einspielen. Best effort, nur mit Live-Standby und solange nicht übernommen.
func (s *Service) resyncLiveStandby(wf Workflow, primaryRole string) {
	standbyRole := liveStandbyOf(wf, primaryRole)
	if standbyRole == "" || wf.Runtime[primaryRole].StandbyActive {
		return
	}
	if s.isUnrestored(wf.ID, primaryRole) {
		// Die Primärrolle hat ihren gesicherten Zustand noch nicht zurück (die Wiederherstellung läuft am Spiegel vorbei): später noch einmal
		s.resyncPending.Store(wf.ID+"|"+primaryRole, struct{}{})
		return
	}
	// Zustand der Primärrolle direkt vom Node lesen, NICHT über die gespeicherte Sicherung (sie ist bis zu 5 s alt, kann gepinnt oder
	// als „unrestored“ gehalten sein; Schreiben in den Speicher ist hier auch nicht gewollt).
	node, ok := s.nodeForRole(wf, primaryRole)
	if !ok || node.APIBaseURL == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), roleStateTimeout)
	defer cancel()
	var env roleStateEnvelope
	if blob, err := s.getNodeStateRetry(ctx, node.APIBaseURL); err == nil {
		env = roleStateEnvelope{Kind: roleStateKindNode, Blob: blob}
	} else if params, perr := captureGenericParams(ctx, s.httpClient, node.APIBaseURL); perr == nil && len(params) > 0 {
		env = roleStateEnvelope{Kind: roleStateKindParams, Params: params}
	} else {
		return // kein übertragbarer Zustand
	}
	rawEnv, err := json.Marshal(env)
	if err != nil {
		return
	}
	raw, err := aliasSenderIDs(rawEnv, s.buildSenderAliasIndex(wf))
	if err != nil {
		slog.Warn("workflows: resyncLiveStandby: alias failed", "workflow", wf.ID, "role", primaryRole, "error", err)
		return
	}
	// Frisch einspielen, nie nur prüfen (wasPosted würde es zur Prüfung machen).
	s.unrestoredMu.Lock()
	delete(s.posted, unrestoredKey(wf.ID, standbyRole))
	s.unrestoredMu.Unlock()
	if err := s.restoreOneRoleStateTry(wf, standbyRole, raw, 3); err != nil {
		slog.Warn("workflows: resyncLiveStandby: restore failed", "workflow", wf.ID, "role", primaryRole, "standbyRole", standbyRole, "error", err)
		s.resyncPending.Store(wf.ID+"|"+primaryRole, struct{}{}) // beim nächsten Takt erneut
		return
	}
	slog.Info("workflows: live standby resynced", "workflow", wf.ID, "role", primaryRole, "standbyRole", standbyRole)
}
