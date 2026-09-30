package updates

// Verteilung eines Pakets an Remote-Hosts (docs/ENTWURF-SYSTEM-UPDATE.md,
// §6 „Host-Agents“): der Orchestrator schickt jedem online gemeldeten
// Host-Agent per NATS ein `update`-Kommando mit einem Einmal-Token-Pfad.
// Der Agent lädt das Paket über GET /api/v1/host-updates/<id>?token=…,
// prüft es mit seinem EIGENEN Vertrauensanker und ersetzt Agent-Binary/
// Node-Binaries seines lokalen Katalogs — ein Agent-Neustart und der
// Neustart seiner Instanzen bleiben Sache des Betreibers.

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"time"
)

// downloadTTL: so lange gilt ein Download-Token.
const downloadTTL = 30 * time.Minute

// requestTimeout je Host (Download + Prüfung + Tausch).
const hostRequestTimeout = 10 * time.Minute

// Downloads verwaltet Einmal-Tokens (im Speicher) für den Paket-Download
// durch Host-Agents, die keine eigenen Orchestrator-Zugangsdaten haben.
type Downloads struct {
	mu     sync.Mutex
	tokens map[string]dlToken
}

type dlToken struct {
	id      string
	expires time.Time
}

// NewDownloads erzeugt einen leeren Token-Speicher.
func NewDownloads() *Downloads { return &Downloads{tokens: map[string]dlToken{}} }

// Issue erzeugt ein Token für das Paket id.
func (d *Downloads) Issue(id string) string {
	var b [24]byte
	_, _ = rand.Read(b[:])
	tok := hex.EncodeToString(b[:])
	d.mu.Lock()
	defer d.mu.Unlock()
	now := time.Now()
	for k, v := range d.tokens {
		if now.After(v.expires) {
			delete(d.tokens, k)
		}
	}
	d.tokens[tok] = dlToken{id: id, expires: now.Add(downloadTTL)}
	return tok
}

// Check prüft Token und Paket-ID (konstante Zeit über alle Kandidaten).
func (d *Downloads) Check(id, token string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	ok := false
	for k, v := range d.tokens {
		match := subtle.ConstantTimeCompare([]byte(k), []byte(token)) == 1
		if match && v.id == id && time.Now().Before(v.expires) {
			ok = true
		}
	}
	return ok
}

// HostRef identifiziert einen Host.
type HostRef struct {
	ID    string
	Label string
}

// HostResult ist das Ergebnis pro Host.
type HostResult struct {
	HostID  string    `json:"hostId"`
	Label   string    `json:"label"`
	State   string    `json:"state"` // "pending" | "ok" | "failed" | "offline"
	Detail  string    `json:"detail,omitempty"`
	Updated time.Time `json:"updated"`
}

// Distribution ist der Stand einer Verteilung.
type Distribution struct {
	PackageID string       `json:"packageId"`
	Version   string       `json:"version"`
	Started   time.Time    `json:"started"`
	Running   bool         `json:"running"`
	Hosts     []HostResult `json:"hosts"`
}

// Distributor verteilt Pakete. Die Funktionsfelder halten ihn frei von
// Abhängigkeiten auf hosts/NATS (in main.go verdrahtet, in Tests ersetzt).
type Distributor struct {
	Downloads *Downloads
	// Hosts liefert alle registrierten Hosts.
	Hosts func() ([]HostRef, error)
	// Online meldet, ob ein Host gerade Telemetrie sendet.
	Online func(hostID string) bool
	// Request sendet ein NATS-Request und liefert die Antwort.
	Request func(subject string, data []byte, timeout time.Duration) ([]byte, error)

	mu   sync.Mutex
	last *Distribution
}

// CheckToken prüft ein Download-Token (für GET /api/v1/host-updates/<id>).
func (d *Distributor) CheckToken(id, token string) bool {
	return d.Downloads != nil && d.Downloads.Check(id, token)
}

// Last liefert den Stand der letzten Verteilung (nil = noch keine).
func (d *Distributor) Last() *Distribution {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.last == nil {
		return nil
	}
	cp := *d.last
	cp.Hosts = append([]HostResult(nil), d.last.Hosts...)
	return &cp
}

// Start verteilt e an alle Hosts (asynchron, ein Host nach dem anderen)
// und liefert sofort den Anfangsstand. ErrBusy, wenn noch eine läuft.
func (d *Distributor) Start(e Entry) (Distribution, error) {
	hosts, err := d.Hosts()
	if err != nil {
		return Distribution{}, err
	}
	sort.Slice(hosts, func(i, j int) bool { return hosts[i].Label < hosts[j].Label })

	d.mu.Lock()
	if d.last != nil && d.last.Running {
		d.mu.Unlock()
		return Distribution{}, ErrBusy
	}
	dist := &Distribution{PackageID: e.ID, Version: e.Version, Started: time.Now().UTC(), Running: true}
	for _, h := range hosts {
		dist.Hosts = append(dist.Hosts, HostResult{HostID: h.ID, Label: h.Label, State: "pending", Updated: time.Now().UTC()})
	}
	d.last = dist
	snapshot := *dist
	snapshot.Hosts = append([]HostResult(nil), dist.Hosts...)
	d.mu.Unlock()

	go d.run(e, hosts)
	return snapshot, nil
}

// ErrBusy: es läuft bereits eine Verteilung.
var ErrBusy = fmt.Errorf("es läuft bereits eine Verteilung")

func (d *Distributor) set(i int, state, detail string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.last == nil || i >= len(d.last.Hosts) {
		return
	}
	d.last.Hosts[i].State, d.last.Hosts[i].Detail, d.last.Hosts[i].Updated = state, detail, time.Now().UTC()
}

func (d *Distributor) run(e Entry, hosts []HostRef) {
	token := d.Downloads.Issue(e.ID)
	path := fmt.Sprintf("/api/v1/host-updates/%s?token=%s", e.ID, token)
	payload, _ := json.Marshal(map[string]string{
		"action": "update", "updatePath": path, "updateVersion": e.Version, "updateSha256": e.SHA256,
	})
	for i, h := range hosts {
		if !d.Online(h.ID) {
			d.set(i, "offline", "Host meldet keine Telemetrie — nicht aktualisiert")
			continue
		}
		raw, err := d.Request(fmt.Sprintf("omp.host.%s.cmd", h.ID), payload, hostRequestTimeout)
		if err != nil {
			d.set(i, "failed", "keine Antwort: "+err.Error())
			continue
		}
		var resp struct {
			OK     bool   `json:"ok"`
			Error  string `json:"error"`
			Detail string `json:"detail"`
		}
		if err := json.Unmarshal(raw, &resp); err != nil {
			d.set(i, "failed", "ungültige Antwort: "+err.Error())
			continue
		}
		if resp.OK {
			d.set(i, "ok", resp.Detail)
		} else {
			d.set(i, "failed", resp.Error)
		}
	}
	d.mu.Lock()
	if d.last != nil && d.last.PackageID == e.ID {
		d.last.Running = false
	}
	d.mu.Unlock()
}
