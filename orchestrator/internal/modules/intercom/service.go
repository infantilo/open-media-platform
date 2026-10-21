package intercom

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

const (
	settingsKey = "intercom.config"
	nodeType    = "omp-intercom"
	pushEvery   = 10 * time.Second
)

// NodeLister und InstanceLister sind die schmalen Sichten auf Registry und Launcher.
type NodeLister interface{ List() []registry.NodeView }
type InstanceLister interface{ List() []launcher.Instance }

// Services: die vom Kern bereitgestellten Bausteine (main.go füllt sie, nachdem alle Dienste existieren).
type Services struct {
	Nodes     NodeLister
	Instances InstanceLister
	HTTP      *http.Client
	Now       func() time.Time
}

type Module struct {
	S Services

	mu  sync.Mutex
	svc *Service
}

func New(s Services) *Module { return &Module{S: s} }

func (*Module) Name() string { return "intercom" }

// Service hält die Konfiguration (ein Dokument im Einstellungsspeicher) und gleicht sie mit den Intercom-Nodes ab.
type Service struct {
	settings module.NodeSettings
	audit    module.DomainAudit
	nodes    NodeLister
	insts    InstanceLister
	http     *http.Client
	now      func() time.Time

	mu       sync.Mutex // schützt Lesen-Ändern-Schreiben der Konfiguration
	lastPush map[string]string
}

func (m *Module) service(d module.Deps) *Service {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.svc != nil {
		return m.svc
	}
	hc := m.S.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 5 * time.Second}
	}
	now := m.S.Now
	if now == nil {
		now = time.Now
	}
	m.svc = &Service{settings: d.Settings, audit: d.Audit, nodes: m.S.Nodes, insts: m.S.Instances, http: hc, now: now, lastPush: map[string]string{}}
	return m.svc
}

func (s *Service) load() (Config, error) {
	if s.settings == nil {
		return Config{Channels: []Channel{}, Parties: []Party{}}, nil
	}
	raw, err := s.settings.Get(settingsKey)
	if err == module.ErrNotFound {
		return Config{Channels: []Channel{}, Parties: []Party{}}, nil
	}
	if err != nil {
		return Config{}, err
	}
	return ParseConfig(raw)
}

func (s *Service) save(c Config) error {
	b, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return s.settings.Put(settingsKey, b)
}

// Update ersetzt Kanäle und Teilnehmer (Token und Gäste bleiben beim Server) und gibt die Änderung sofort an die Nodes weiter.
func (s *Service) Update(ctx context.Context, actor string, in Config) (Config, error) {
	if err := in.Validate(); err != nil {
		return Config{}, err
	}
	s.mu.Lock()
	old, err := s.load()
	if err != nil {
		s.mu.Unlock()
		return Config{}, err
	}
	next := in.WithTokens(old)
	if err := s.save(next); err != nil {
		s.mu.Unlock()
		return Config{}, err
	}
	s.mu.Unlock()
	s.log(actor, "config", "update", map[string]any{"channels": len(next.Channels), "parties": len(next.Parties)})
	go s.Push(context.Background())
	return next, nil
}

func (s *Service) log(actor, id, action string, details map[string]any) {
	if s.audit != nil {
		s.audit.Log(actor, "intercom", id, action, details)
	}
}

// RotateToken vergibt einem Teilnehmer einen neuen Zugangstoken (alter Link wird ungültig, offene Sitzung bleibt bis zum Abbruch).
func (s *Service) RotateToken(ctx context.Context, actor string, partyID int) error {
	s.mu.Lock()
	c, err := s.load()
	if err != nil {
		s.mu.Unlock()
		return err
	}
	found := false
	for i := range c.Parties {
		if c.Parties[i].ID == partyID {
			c.Parties[i].Token, found = newToken(), true
		}
	}
	if !found {
		s.mu.Unlock()
		return errNotFound
	}
	err = s.save(c)
	s.mu.Unlock()
	if err == nil {
		s.log(actor, fmt.Sprint(partyID), "rotate-token", nil)
		go s.Push(context.Background())
	}
	return err
}

var errNotFound = fmt.Errorf("nicht gefunden")

// CreateGuest legt einen befristeten Gastzugang an.
func (s *Service) CreateGuest(ctx context.Context, actor, name string, routes []Route, ttl time.Duration) (Guest, error) {
	if strings.TrimSpace(name) == "" {
		return Guest{}, &ValidationError{Problems: []string{"Gast ohne Namen"}}
	}
	if ttl <= 0 || ttl > 7*24*time.Hour {
		return Guest{}, &ValidationError{Problems: []string{"Gültigkeit muss zwischen 1 Minute und 7 Tagen liegen"}}
	}
	s.mu.Lock()
	c, err := s.load()
	if err != nil {
		s.mu.Unlock()
		return Guest{}, err
	}
	next := GuestBase
	var keep []Guest
	for _, g := range c.Guests {
		if g.Expires.After(s.now()) {
			keep = append(keep, g)
		}
		if g.ID >= next {
			next = g.ID + 1
		}
	}
	g := Guest{ID: next, Name: name, Token: newToken(), Expires: s.now().Add(ttl), Routes: routes, CreatedBy: actor}
	c.Guests = append(keep, g)
	if err := c.Validate(); err != nil {
		s.mu.Unlock()
		return Guest{}, err
	}
	err = s.save(c)
	s.mu.Unlock()
	if err != nil {
		return Guest{}, err
	}
	s.log(actor, fmt.Sprint(g.ID), "guest-create", map[string]any{"name": name, "expires": g.Expires})
	go s.Push(context.Background())
	return g, nil
}

func (s *Service) DeleteGuest(ctx context.Context, actor string, id int) error {
	s.mu.Lock()
	c, err := s.load()
	if err != nil {
		s.mu.Unlock()
		return err
	}
	var keep []Guest
	found := false
	for _, g := range c.Guests {
		if g.ID == id {
			found = true
			continue
		}
		keep = append(keep, g)
	}
	if !found {
		s.mu.Unlock()
		return errNotFound
	}
	c.Guests = keep
	err = s.save(c)
	s.mu.Unlock()
	if err == nil {
		s.log(actor, fmt.Sprint(id), "guest-delete", nil)
		go s.Push(context.Background())
	}
	return err
}

// IntercomNodes liefert die erreichbaren Intercom-Nodes: vom Launcher gestartete Instanzen des Typs und von Hand
// gestartete Nodes mit dem Namen „Intercom…“ (Entwicklung).
func (s *Service) IntercomNodes() []registry.NodeView {
	if s.nodes == nil {
		return nil
	}
	byInstance := map[string]bool{}
	if s.insts != nil {
		for _, in := range s.insts.List() {
			if in.Type == nodeType && !in.Crashed {
				byInstance[in.ID] = true
			}
		}
	}
	var out []registry.NodeView
	for _, n := range s.nodes.List() {
		if !n.Online || n.APIBaseURL == "" {
			continue
		}
		if (n.InstanceID != "" && byInstance[n.InstanceID]) || (n.InstanceID == "" && strings.HasPrefix(n.Label, "Intercom")) {
			out = append(out, n)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Push gibt die aktuelle Konfiguration an alle Intercom-Nodes. Wiederholt sich regelmäßig: ein neu gestarteter Node
// hat keinen eigenen Dauerzustand und bekommt seine Konfiguration so zurück.
func (s *Service) Push(ctx context.Context) {
	c, err := s.load()
	if err != nil {
		slog.Warn("intercom: Konfiguration nicht lesbar", "error", err)
		return
	}
	doc, _ := json.Marshal(c.NodeConfig(s.now()))
	for _, n := range s.IntercomNodes() {
		req, err := http.NewRequestWithContext(ctx, http.MethodPut, strings.TrimRight(n.APIBaseURL, "/")+"/config", bytes.NewReader(doc))
		if err != nil {
			continue
		}
		resp, err := s.http.Do(req)
		if err != nil {
			slog.Warn("intercom: Node nicht erreichbar", "node", n.ID, "error", err)
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		if resp.StatusCode/100 != 2 {
			slog.Warn("intercom: Node lehnt Konfiguration ab", "node", n.ID, "status", resp.StatusCode, "body", string(body))
		}
	}
}

// Run: periodischer Abgleich (nur auf dem Raft-Leader).
func (s *Service) Run(ctx context.Context) {
	s.Push(ctx)
	t := time.NewTicker(pushEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.Push(ctx)
		}
	}
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

// PanelURL baut den Link zum Panel eines Teilnehmers auf dem ersten erreichbaren Intercom-Node. `requestHost` ist der Name,
// unter dem die anfragende Person den Orchestrator erreicht (für Nodes, die nur auf localhost lauschen).
func (s *Service) PanelURL(ctx context.Context, requestHost, token string) (string, error) {
	nodes := s.IntercomNodes()
	if len(nodes) == 0 {
		return "", fmt.Errorf("kein Intercom-Node läuft")
	}
	base, err := url.Parse(nodes[0].APIBaseURL)
	if err != nil {
		return "", err
	}
	host := base.Hostname()
	nodeLoopback := isLoopback(host)
	reqHost := requestHost
	if h, _, err := net.SplitHostPort(requestHost); err == nil {
		reqHost = h
	}
	// Browser und Node auf demselben Rechner (Anfrage über localhost): einfaches HTTP über den normalen Node-Port. `localhost`
	// gilt für das Mikrofon als sicherer Kontext, die Zertifikats-Rückfrage des selbst signierten HTTPS entfällt.
	if nodeLoopback && isLoopback(reqHost) {
		u := url.URL{Scheme: "http", Host: net.JoinHostPort(reqHost, base.Port()), Path: "/panel", RawQuery: "token=" + url.QueryEscape(token)}
		return u.String(), nil
	}
	if nodeLoopback && reqHost != "" {
		host = reqHost
	}
	scheme, port := "http", base.Port()
	if req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(nodes[0].APIBaseURL, "/")+"/https-info", nil); err == nil {
		if resp, err := s.http.Do(req); err == nil {
			var info struct {
				Enabled bool `json:"enabled"`
				Port    int  `json:"port"`
			}
			_ = json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&info)
			resp.Body.Close()
			if info.Enabled && info.Port > 0 {
				scheme, port = "https", fmt.Sprint(info.Port)
			}
		}
	}
	u := url.URL{Scheme: scheme, Host: net.JoinHostPort(host, port), Path: "/panel", RawQuery: "token=" + url.QueryEscape(token)}
	return u.String(), nil
}

// Status liefert den Laufzeitstatus des ersten Intercom-Nodes (Teilnehmer online, Takt).
func (s *Service) Status(ctx context.Context) (json.RawMessage, error) {
	nodes := s.IntercomNodes()
	if len(nodes) == 0 {
		return nil, fmt.Errorf("kein Intercom-Node läuft")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(nodes[0].APIBaseURL, "/")+"/status", nil)
	if err != nil {
		return nil, err
	}
	resp, err := s.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return b, err
}
