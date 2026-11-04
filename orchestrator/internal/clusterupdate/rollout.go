// Package clusterupdate steuert das Cluster-Rolling-Update und den rollierenden Cluster-Neustart (Kap. 84,
// docs/ENTWURF-SYSTEM-UPDATE.md §11): Mitglieder nacheinander, der Leader zuletzt nach Führungsübergabe.
// Der Zustand liegt in Postgres; der Treiber läuft nur auf dem Leader und setzt nach einem Wechsel dort fort.
package clusterupdate

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/cluster"
)

// Kind: Art des Rollouts.
type Kind string

const (
	KindUpdate  Kind = "update"
	KindRestart Kind = "restart"
)

// Gesamtzustand.
const (
	StateRunning   = "running"
	StateFailed    = "failed" // angehalten, manuell fortsetzen
	StateDone      = "done"
	StateCancelled = "cancelled"
)

// Schrittzustand je Mitglied.
const (
	StepPending      = "pending"
	StepDistributing = "distributing"
	StepApplying     = "applying"
	StepVerifying    = "verifying"
	StepDone         = "done"
	StepFailed       = "failed"
)

// HostsStep ist der Pseudo-Schritt „Host-Agents zuerst verteilen“ (§11.5); kein Cluster-Mitglied.
const HostsStep = "@hosts"

func isMember(s Step) bool { return s.NodeID != HostsStep }

// HostDistributor verteilt das Paket an die Host-Agents und wartet auf das Ergebnis.
type HostDistributor interface {
	Distribute(ctx context.Context, packageID string) (detail string, err error)
}

// Step ist der Stand eines Mitglieds im Rollout.
type Step struct {
	NodeID    string    `json:"nodeId"`
	HTTPAddr  string    `json:"httpAddr"`
	State     string    `json:"state"`
	Version   string    `json:"version,omitempty"` // zuletzt gemeldete Version
	Detail    string    `json:"detail,omitempty"`
	AppliedAt time.Time `json:"appliedAt,omitempty"`
	Updated   time.Time `json:"updated"`
}

// Rollout ist ein Cluster-Rollout.
type Rollout struct {
	ID            string    `json:"id"`
	Kind          Kind      `json:"kind"`
	PackageID     string    `json:"packageId,omitempty"`
	TargetVersion string    `json:"targetVersion,omitempty"`
	State         string    `json:"state"`
	Error         string    `json:"error,omitempty"`
	Steps         []Step    `json:"steps"`
	CreatedBy     string    `json:"createdBy,omitempty"`
	Created       time.Time `json:"created"`
	Updated       time.Time `json:"updated"`
}

// Store hält den Rollout-Zustand (Postgres in Produktion, Speicher in Tests).
type Store interface {
	Active() (*Rollout, error) // laufend oder angehalten; nil = keiner
	Latest() (*Rollout, error)
	Create(r *Rollout) error // ErrActive, wenn bereits einer aktiv ist
	Save(r *Rollout) error
}

// ErrActive: es gibt bereits einen aktiven Rollout.
var ErrActive = errors.New("clusterupdate: es laeuft oder haengt bereits ein Rollout")

// Info ist die Sicht auf ein Mitglied.
type Info struct {
	Version   string
	StartedAt time.Time
	Status    cluster.Status
}

// Members spricht die anderen Mitglieder an (HTTP in Produktion, Fake in Tests).
type Members interface {
	Info(ctx context.Context, httpAddr string) (Info, error)
	// Fetch lässt das Mitglied das Paket vom Koordinator laden und mit seinem eigenen Vertrauensanker prüfen.
	Fetch(ctx context.Context, httpAddr, packageID string) error
	// Apply löst Update (packageID) bzw. Neustart ("") beim Mitglied aus; term ist das Fencing-Token.
	Apply(ctx context.Context, httpAddr string, kind Kind, packageID, version string, term uint64) error
}

// Local ist der lokale Raft-Knoten (cluster.Node).
type Local interface {
	Status() cluster.Status
	IsLeader() bool
	Term() uint64
	TransferLeadership(targetID string) error
}

// Driver führt Rollouts aus.
type Driver struct {
	Store   Store
	Members Members
	Local   Local
	// Hosts: optional; nötig, wenn StartParams.HostsFirst gesetzt ist.
	Hosts HostDistributor
	// Hooks, ohne die der Treiber testbar bleibt.
	MaxLag        uint64
	VerifyTimeout time.Duration // je Mitglied: Zeit bis Zielversion/Neustart sichtbar
	PollInterval  time.Duration
	Now           func() time.Time

	mu sync.Mutex // ein Schritt zugleich
}

func (d *Driver) now() time.Time {
	if d.Now != nil {
		return d.Now().UTC()
	}
	return time.Now().UTC()
}

func (d *Driver) maxLag() uint64 {
	if d.MaxLag == 0 {
		return cluster.DefaultMaxLag
	}
	return d.MaxLag
}

func (d *Driver) verifyTimeout() time.Duration {
	if d.VerifyTimeout <= 0 {
		return 3 * time.Minute
	}
	return d.VerifyTimeout
}

func (d *Driver) poll() time.Duration {
	if d.PollInterval <= 0 {
		return time.Second
	}
	return d.PollInterval
}

// StartParams beschreibt einen neuen Rollout.
type StartParams struct {
	Kind          Kind
	PackageID     string
	TargetVersion string
	RollingSafe   bool // Manifest-Merkmal; bei KindUpdate Pflicht
	HostsFirst    bool // erst Host-Agents (distribute), dann der Orchestrator-Cluster (§11.5)
	By            string
}

// Start prüft die Vorbedingungen (§11.2 Punkt 1) und legt den Rollout an. Befunde kommen als Klartext-Liste zurück;
// der Aufrufer meldet sie als 409.
func (d *Driver) Start(ctx context.Context, p StartParams) (*Rollout, []string, error) {
	if !d.Local.IsLeader() {
		return nil, nil, cluster.ErrNotLeaderForRollout
	}
	var findings []string
	if p.Kind == KindUpdate {
		if p.PackageID == "" || p.TargetVersion == "" {
			return nil, nil, errors.New("Paket und Zielversion erforderlich")
		}
		if !p.RollingSafe {
			findings = append(findings, "Paket ist nicht als rollingSafe gekennzeichnet (Migrationen/Raft-Befehle nicht mit gemischten Versionen vertraeglich) - nicht fuer den Cluster-Rollout zugelassen")
		}
	} else if p.Kind != KindRestart {
		return nil, nil, fmt.Errorf("unbekannte Art %q", p.Kind)
	}

	self := d.Local.Status()
	statuses := []cluster.Status{self}
	steps := []Step{}
	addrs := self.PeerHTTPAddrs
	for _, peer := range self.Peers {
		if peer.ID == self.NodeID {
			steps = append(steps, Step{NodeID: peer.ID, HTTPAddr: addrs[peer.ID], State: StepPending})
			continue
		}
		addr := addrs[peer.ID]
		steps = append(steps, Step{NodeID: peer.ID, HTTPAddr: addr, State: StepPending})
		if addr == "" {
			findings = append(findings, fmt.Sprintf("%s: keine HTTP-Adresse bekannt", peer.ID))
			continue
		}
		info, err := d.Members.Info(ctx, addr)
		if err != nil {
			findings = append(findings, fmt.Sprintf("%s: nicht erreichbar (%v)", peer.ID, err))
			continue
		}
		statuses = append(statuses, info.Status)
		steps[len(steps)-1].Version = info.Version
	}
	// Erreichbarkeit hat der Schleifenkörper schon einzeln gemeldet; die Zählbefunde von RolloutPrecheck
	// würden doppeln, daher nur Quorum- und Tor-Befunde übernehmen.
	for _, f := range cluster.RolloutPrecheck(statuses, d.maxLag()) {
		if len(statuses) < len(self.Peers) && strings.Contains(f, "erreichbar") {
			continue
		}
		findings = append(findings, f)
	}
	if len(findings) > 0 {
		return nil, findings, nil
	}
	sort.SliceStable(steps, func(i, j int) bool { return steps[i].NodeID < steps[j].NodeID })
	if p.HostsFirst && p.Kind == KindUpdate {
		if d.Hosts == nil {
			return nil, []string{"Host-Verteilung nicht verfuegbar"}, nil
		}
		steps = append([]Step{{NodeID: HostsStep, State: StepPending}}, steps...)
	}
	now := d.now()
	r := &Rollout{
		ID: fmt.Sprintf("ro-%d", now.UnixNano()), Kind: p.Kind, PackageID: p.PackageID, TargetVersion: p.TargetVersion,
		State: StateRunning, Steps: steps, CreatedBy: p.By, Created: now, Updated: now,
	}
	if err := d.Store.Create(r); err != nil {
		return nil, nil, err
	}
	return r, nil, nil
}

// Resume setzt einen angehaltenen Rollout fort (fehlgeschlagene Schritte werden erneut versucht).
func (d *Driver) Resume() error {
	r, err := d.Store.Active()
	if err != nil {
		return err
	}
	if r == nil || r.State != StateFailed {
		return errors.New("kein angehaltener Rollout")
	}
	for i := range r.Steps {
		if r.Steps[i].State == StepFailed {
			r.Steps[i].State, r.Steps[i].Detail = StepPending, ""
		}
	}
	r.State, r.Error = StateRunning, ""
	return d.save(r)
}

// Cancel bricht einen aktiven Rollout ab (bereits aktualisierte Mitglieder bleiben unberührt, §11.9.2).
func (d *Driver) Cancel() error {
	r, err := d.Store.Active()
	if err != nil {
		return err
	}
	if r == nil {
		return errors.New("kein aktiver Rollout")
	}
	r.State = StateCancelled
	return d.save(r)
}

func (d *Driver) save(r *Rollout) error {
	r.Updated = d.now()
	return d.Store.Save(r)
}

// Run ist der Leader-Loop (unter runWhileLeader): arbeitet den aktiven Rollout ab, bis ctx endet.
func (d *Driver) Run(ctx context.Context) {
	t := time.NewTicker(d.poll())
	defer t.Stop()
	for {
		if err := d.Step(ctx); err != nil && ctx.Err() == nil {
			_ = err // Fehler stehen im Rollout; Store-Fehler werden beim nächsten Takt erneut versucht
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Step arbeitet höchstens ein Mitglied ab. Gibt nil zurück, wenn nichts zu tun war.
func (d *Driver) Step(ctx context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.Local.IsLeader() {
		return nil
	}
	r, err := d.Store.Active()
	if err != nil || r == nil || r.State != StateRunning {
		return err
	}
	self := d.Local.Status()
	idx := d.pickNext(r, self)
	if idx < 0 {
		// Alles fertig?
		for _, s := range r.Steps {
			if s.State != StepDone {
				return nil
			}
		}
		r.State = StateDone
		return d.save(r)
	}
	st := &r.Steps[idx]
	if !isMember(*st) {
		return d.runHosts(ctx, r, st)
	}
	// Der Leader selbst kommt zuletzt: erst Führung an ein fertiges Mitglied übergeben, der neue Leader macht weiter.
	if st.NodeID == self.NodeID {
		target := ""
		for _, s := range r.Steps {
			if isMember(s) && s.NodeID != self.NodeID && s.State == StepDone {
				target = s.NodeID
				break
			}
		}
		if target == "" {
			return d.fail(r, st, "kein aktualisiertes Mitglied fuer die Fuehrungsuebergabe")
		}
		if err := d.Local.TransferLeadership(target); err != nil {
			return d.fail(r, st, "Fuehrungsuebergabe an "+target+" fehlgeschlagen: "+err.Error())
		}
		return nil
	}
	return d.runStep(ctx, r, st, self)
}

// pickNext wählt das nächste offene Mitglied: laufende Schritte zuerst (Wiederaufnahme nach Leader-Wechsel),
// dann ausstehende Nicht-Leader, der amtierende Leader zuletzt.
func (d *Driver) pickNext(r *Rollout, self cluster.Status) int {
	for i, s := range r.Steps {
		if !isMember(s) && s.State != StepDone {
			return i
		}
	}
	for i, s := range r.Steps {
		if s.State == StepDistributing || s.State == StepApplying || s.State == StepVerifying {
			return i
		}
	}
	leader := -1
	for i, s := range r.Steps {
		if s.State != StepPending {
			continue
		}
		if s.NodeID == self.NodeID {
			leader = i
			continue
		}
		return i
	}
	return leader
}

func (d *Driver) fail(r *Rollout, st *Step, msg string) error {
	st.State, st.Detail, st.Updated = StepFailed, msg, d.now()
	r.State, r.Error = StateFailed, st.NodeID+": "+msg
	return d.save(r)
}

func (d *Driver) setStep(r *Rollout, st *Step, state, detail string) error {
	st.State, st.Detail, st.Updated = state, detail, d.now()
	return d.save(r)
}

// done: ist das Ziel bei diesem Mitglied erreicht?
func (d *Driver) reached(r *Rollout, st *Step, info Info) bool {
	if r.Kind == KindUpdate {
		return info.Version == r.TargetVersion
	}
	return !st.AppliedAt.IsZero() && info.StartedAt.After(st.AppliedAt)
}

func (d *Driver) runStep(ctx context.Context, r *Rollout, st *Step, self cluster.Status) error {
	if st.HTTPAddr == "" {
		return d.fail(r, st, "keine HTTP-Adresse bekannt")
	}
	info, infoErr := d.Members.Info(ctx, st.HTTPAddr)
	if infoErr == nil {
		st.Version = info.Version
	}

	switch st.State {
	case StepPending:
		if infoErr != nil {
			return d.fail(r, st, "nicht erreichbar: "+infoErr.Error())
		}
		if r.Kind == KindUpdate && info.Version == r.TargetVersion {
			return d.setStep(r, st, StepDone, "bereits auf Zielversion")
		}
		// Tor VOR dem Eingriff: dieses Mitglied muss gesund sein und nach seinem Ausfall muss die Mehrheit stehen.
		if err := cluster.MemberGate(info.Status, d.maxLag()); err != nil {
			return d.fail(r, st, "Tor: "+err.Error())
		}
		if msg := d.othersHealthy(ctx, r, st, self); msg != "" {
			return d.fail(r, st, msg)
		}
		if r.Kind == KindUpdate {
			if err := d.setStep(r, st, StepDistributing, ""); err != nil {
				return err
			}
			return d.distribute(ctx, r, st)
		}
		return d.apply(ctx, r, st)
	case StepDistributing:
		return d.distribute(ctx, r, st)
	case StepApplying:
		// Nach Leader-Wechsel unklar, ob schon ausgelöst: nicht erneut auslösen, sondern prüfen (verify wartet auf das Ziel).
		return d.setStep(r, st, StepVerifying, "")
	case StepVerifying:
		return d.verify(ctx, r, st)
	}
	return nil
}

// othersHealthy: alle übrigen Mitglieder erreichbar und im Tor; so bleibt die Mehrheit beim Ausfall von st bestehen.
func (d *Driver) othersHealthy(ctx context.Context, r *Rollout, st *Step, self cluster.Status) string {
	voters := 0
	for _, p := range self.Peers {
		if p.Suffrage == "Voter" {
			voters++
		}
	}
	if voters-1 < voters/2+1 {
		return fmt.Sprintf("cluster-quorum: ohne %s fehlt die Mehrheit (%d stimmberechtigt)", st.NodeID, voters)
	}
	for _, o := range r.Steps {
		if !isMember(o) || o.NodeID == st.NodeID || o.NodeID == self.NodeID {
			continue
		}
		info, err := d.Members.Info(ctx, o.HTTPAddr)
		if err != nil {
			return fmt.Sprintf("%s nicht erreichbar: %v", o.NodeID, err)
		}
		if err := cluster.MemberGate(info.Status, d.maxLag()); err != nil {
			return fmt.Sprintf("%s: Tor: %v", o.NodeID, err)
		}
	}
	return ""
}

func (d *Driver) distribute(ctx context.Context, r *Rollout, st *Step) error {
	if err := d.Members.Fetch(ctx, st.HTTPAddr, r.PackageID); err != nil {
		return d.fail(r, st, "Paket laden/pruefen: "+err.Error())
	}
	return d.apply(ctx, r, st)
}

func (d *Driver) apply(ctx context.Context, r *Rollout, st *Step) error {
	st.AppliedAt = d.now()
	if err := d.setStep(r, st, StepApplying, ""); err != nil {
		return err
	}
	pkg := ""
	if r.Kind == KindUpdate {
		pkg = r.PackageID
	}
	if err := d.Members.Apply(ctx, st.HTTPAddr, r.Kind, pkg, r.TargetVersion, d.Local.Term()); err != nil {
		return d.fail(r, st, "Anwenden: "+err.Error())
	}
	return d.setStep(r, st, StepVerifying, "")
}

func (d *Driver) verify(ctx context.Context, r *Rollout, st *Step) error {
	deadline := d.now().Add(d.verifyTimeout())
	if !st.AppliedAt.IsZero() {
		if dl := st.AppliedAt.Add(d.verifyTimeout()); dl.After(deadline) {
			deadline = dl
		}
	}
	var last string
	for {
		info, err := d.Members.Info(ctx, st.HTTPAddr)
		switch {
		case err != nil:
			last = "nicht erreichbar: " + err.Error()
		case !d.reached(r, st, info):
			last = fmt.Sprintf("Version %q, Ziel noch nicht erreicht", info.Version)
		default:
			if gerr := cluster.MemberGate(info.Status, d.maxLag()); gerr != nil {
				last = "Tor: " + gerr.Error()
			} else {
				st.Version = info.Version
				return d.setStep(r, st, StepDone, "")
			}
		}
		if !d.now().Before(deadline) {
			return d.fail(r, st, "nicht bestaetigt: "+last)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(d.poll()):
		}
	}
}

// Latest liefert den zuletzt angelegten Rollout (für die Anzeige).
func (d *Driver) Latest() (*Rollout, error) { return d.Store.Latest() }

// runHosts verteilt das Paket an die Host-Agents. Fehlgeschlagene Hosts halten den Rollout an (der Cluster würde sonst
// vor den Hosts aktualisiert); offline gemeldete Hosts stehen nur im Detail (sie holen das Paket nicht ab).
func (d *Driver) runHosts(ctx context.Context, r *Rollout, st *Step) error {
	if d.Hosts == nil {
		return d.fail(r, st, "Host-Verteilung nicht verfuegbar")
	}
	if err := d.setStep(r, st, StepApplying, ""); err != nil {
		return err
	}
	detail, err := d.Hosts.Distribute(ctx, r.PackageID)
	if err != nil {
		return d.fail(r, st, "Host-Agents: "+err.Error())
	}
	return d.setStep(r, st, StepDone, detail)
}
