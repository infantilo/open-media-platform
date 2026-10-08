// Package cloud ist das Cloud-Modul des Orchestrators (ARCHITECTURE.md §27/§28, UMSETZUNG.md Kapitel 36.6): Routen,
// Controller (Pool-Abgleich, Reservierungen, Autoscaling, Budgetdeckel) und Oberfläche. Die Fachlogik liegt im Paket
// `internal/cloud` (Anbieter-Adapter, Kosten, Lebenszyklus); dieses Paket ist die Anbindung an den Orchestrator-Kern.
//
// Konfiguration über die Umgebung (docs/CLOUD-AWS.md): ohne `OMP_CLOUD_PROVIDER` bleibt das Modul gemountet, antwortet aber
// mit `configured:false` (die Oberfläche zeigt einen Hinweis) — der Kern ist ohne Anbieter voll lauffähig.
package cloud

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/cloud"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

// Module ist das Cloud-Modul.
type Module struct {
	ctrl *cloud.PoolController
}

// New legt das Modul an.
func New() *Module { return &Module{} }

func (*Module) Name() string { return "cloud" }

// UI: der Tab „Cloud“ hinter „Hosts“; das Bundle liefert der Dateiserver der Shell (`make ui` baut ui/dist/modules/cloud.js).
func (*Module) UI() []module.UITab {
	return []module.UITab{{
		ID: "cloud", Placement: "main", After: "hosts",
		Label:   map[string]string{"de": "Cloud", "en": "Cloud"},
		Element: "omp-cloud-view", Bundle: "/dist/modules/cloud.js",
	}}
}

// api bündelt, was die Handler brauchen.
type api struct {
	costs    CloudCosts
	control  CloudControl
	provider string
	region   string
	audit    module.DomainAudit
	actorFn  func(*http.Request) string
}

func (a *api) actor(r *http.Request) string {
	if a.actorFn == nil {
		return ""
	}
	return a.actorFn(r)
}

func (a *api) log(actor, objectType, objectID, action string, details map[string]any) {
	if a.audit != nil {
		a.audit.Log(actor, objectType, objectID, action, details)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// poolConfig ist die JSON-Konfiguration eines Pools (`OMP_CLOUD_POOLS`).
type poolConfig struct {
	Name           string `json:"name"`
	Region         string `json:"region"`
	InstanceType   string `json:"instanceType"`
	Min            int    `json:"min"`
	Max            int    `json:"max"`
	IdleAfterSec   int    `json:"idleAfterSec"`
	MaxLifetimeSec int    `json:"maxLifetimeSec"`
}

func (c poolConfig) pool(userData string) cloud.Pool {
	idle := time.Duration(c.IdleAfterSec) * time.Second
	if idle == 0 {
		idle = 5 * time.Minute
	}
	return cloud.Pool{Name: c.Name, Region: c.Region, InstanceType: c.InstanceType, Min: c.Min, Max: c.Max,
		UserDataTemplate: userData, IdleAfter: idle, MaxLifetime: time.Duration(c.MaxLifetimeSec) * time.Second}
}

func envFirst(keys ...string) string {
	for _, k := range keys {
		if v := os.Getenv(k); v != "" {
			return v
		}
	}
	return ""
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// setup liest die Umgebung und baut Anbieter, Manager und Controller. Gibt (nil, nil, …) zurück, wenn kein Anbieter
// konfiguriert ist oder die Konfiguration unbrauchbar war (dann ist die Ursache geloggt und die Cloud aus).
//
//	OMP_CLOUD_PROVIDER   mock (Simulation, schreibt nichts in die Host-Tabelle) | aws
//	OMP_CLOUD_DEPLOYMENT Markierung dieses Orchestrators an allen Ressourcen (Standard „omp“)
//	OMP_CLOUD_POOLS      JSON-Liste der Pools (Pflicht bei aws; Standard bei mock: ein Pool „burst“)
//	OMP_CLOUD_USERDATA_FILE  Bootstrap-Vorlage ({{token}}, {{host}}); Pflicht bei aws
//	aws: OMP_CLOUD_AWS_REGION, AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (oder OMP_CLOUD_AWS_*), OMP_CLOUD_AWS_AMI,
//	     OMP_CLOUD_AWS_SUBNET, OMP_CLOUD_AWS_SECURITY_GROUPS, OMP_CLOUD_AWS_KEY_NAME,
//	     OMP_CLOUD_AWS_ALLOW_LAUNCH=1 (ohne: nur Trockenlauf, es startet und kostet nichts)
func (m *Module) setup(d module.Deps) (costs *cloud.CostService, svc *cloud.Service, provider, region string) {
	name := os.Getenv("OMP_CLOUD_PROVIDER")
	if name == "" {
		return nil, nil, "", ""
	}
	deployment := envFirst("OMP_CLOUD_DEPLOYMENT")
	if deployment == "" {
		deployment = "omp"
	}
	userData := "OMP_HOST_AGENT_LABEL={{host}}\nOMP_HOST_AGENT_BOOTSTRAP_TOKEN={{token}}\n"
	if f := os.Getenv("OMP_CLOUD_USERDATA_FILE"); f != "" {
		b, err := os.ReadFile(f)
		if err != nil {
			slog.Error("cloud: user data file unreadable, cloud features off", "file", f, "error", err)
			return nil, nil, "", ""
		}
		userData = string(b)
	}
	var cfgs []poolConfig
	if raw := os.Getenv("OMP_CLOUD_POOLS"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &cfgs); err != nil {
			slog.Error("cloud: OMP_CLOUD_POOLS invalid, cloud features off", "error", err)
			return nil, nil, "", ""
		}
	}

	var prov cloud.Provider
	var env cloud.Env
	switch name {
	case "mock":
		if len(cfgs) == 0 {
			cfgs = []poolConfig{{Name: "burst", Region: "mock-region", InstanceType: "m.medium", Max: 3, IdleAfterSec: 120, MaxLifetimeSec: 12 * 3600}}
		}
		region = "mock-region"
		prov = cloud.NewMockProvider()
		env = cloud.NewSimEnv(time.Now, 20*time.Second)
	case "aws":
		if len(cfgs) == 0 || os.Getenv("OMP_CLOUD_USERDATA_FILE") == "" {
			slog.Error("cloud: provider aws needs OMP_CLOUD_POOLS and OMP_CLOUD_USERDATA_FILE, cloud features off")
			return nil, nil, "", ""
		}
		region = envFirst("OMP_CLOUD_AWS_REGION", "AWS_REGION")
		var types []string
		for _, c := range cfgs {
			types = append(types, c.InstanceType)
		}
		aws, err := cloud.NewAWS(cloud.AWSConfig{
			Region:           region,
			AccessKeyID:      envFirst("OMP_CLOUD_AWS_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"),
			SecretAccessKey:  envFirst("OMP_CLOUD_AWS_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"),
			SessionToken:     envFirst("OMP_CLOUD_AWS_SESSION_TOKEN", "AWS_SESSION_TOKEN"),
			ImageID:          os.Getenv("OMP_CLOUD_AWS_AMI"),
			SubnetID:         os.Getenv("OMP_CLOUD_AWS_SUBNET"),
			SecurityGroupIDs: splitList(os.Getenv("OMP_CLOUD_AWS_SECURITY_GROUPS")),
			KeyName:          os.Getenv("OMP_CLOUD_AWS_KEY_NAME"),
			InstanceTypes:    types,
			AllowLaunch:      os.Getenv("OMP_CLOUD_AWS_ALLOW_LAUNCH") == "1",
		})
		if err != nil {
			slog.Error("cloud: aws adapter not usable, cloud features off", "error", err)
			return nil, nil, "", ""
		}
		if os.Getenv("OMP_CLOUD_AWS_ALLOW_LAUNCH") != "1" {
			slog.Warn("cloud: AWS launching is DISABLED (dry run only) — set OMP_CLOUD_AWS_ALLOW_LAUNCH=1 to start instances")
		}
		prov = aws
		env = cloud.HostsEnv{Tokens: d.Hosts, Hosts: d.Hosts, Instances: d.Instances, Placement: d.Placement}
	default:
		slog.Warn("unknown OMP_CLOUD_PROVIDER, cloud features off", "value", name)
		return nil, nil, "", ""
	}

	var pools []cloud.Pool
	for _, c := range cfgs {
		pools = append(pools, c.pool(userData))
	}
	costs = &cloud.CostService{Provider: prov, Region: region, MinBilled: time.Minute, Lead: 5 * time.Minute, Teardown: 5 * time.Minute}
	mgr := cloud.NewManager(prov, deployment, pools, env, time.Now)
	if err := mgr.SetStore(cloud.NewSQLHosts(d.DB)); err != nil {
		slog.Warn("cloud: restoring hosts failed", "error", err)
	}
	store := cloud.NewSQLReservations(d.DB)
	policies := cloud.NewSQLPolicies(d.DB)
	m.ctrl = &cloud.PoolController{Manager: mgr, Reservations: store, Lead: 5 * time.Minute, Teardown: 5 * time.Minute,
		Policies: policies, Load: clusterLoad(d),
		Prices: func(ctx context.Context) (cloud.PriceBook, error) {
			types, err := costs.Types(ctx)
			if err != nil {
				return cloud.PriceBook{}, err
			}
			return cloud.NewPriceBook(types, time.Minute), nil
		},
		OnAction: func(a cloud.Action) {
			slog.Info("cloud action", "pool", a.Pool, "kind", a.Kind, "host", a.HostID, "reason", a.Reason)
			if d.Audit != nil && a.Kind != "error" {
				d.Audit.Log("cloud-controller", "cloud_host", a.HostID, a.Kind, map[string]any{"pool": a.Pool, "reason": a.Reason})
			}
		}}
	svc = &cloud.Service{Manager: mgr, Controller: m.ctrl, Reservations: store, Policies: policies}
	return costs, svc, name, region
}

// clusterLoad liefert die durchschnittliche Auslastung der erreichbaren Hosts (Host-Agents mit frischer Telemetrie plus der
// lokale Orchestrator-Rechner) als Eingang des Autoscalings. ok=false, solange nichts gemessen wird — dann skaliert nichts.
func clusterLoad(d module.Deps) func() (cloud.LoadSample, bool) {
	const onlineThreshold = 15 * time.Second // wie placement.HostOnlineThreshold
	return func() (cloud.LoadSample, bool) {
		var cpu, mem float64
		n := 0
		if list, err := d.Hosts.ListHosts(); err == nil {
			for _, h := range list {
				m, ok := d.HostMetrics.Get(h.ID)
				if !ok || time.Since(m.ReceivedAt) >= onlineThreshold || m.Goodbye || m.MemTotalBytes == 0 {
					continue
				}
				cpu += m.CPUPercent
				mem += float64(m.MemUsedBytes) / float64(m.MemTotalBytes) * 100
				n++
			}
		}
		if c, mm, ok := d.Instances.LocalLoad(); ok {
			cpu += c
			mem += mm
			n++
		}
		if n == 0 {
			return cloud.LoadSample{}, false
		}
		return cloud.LoadSample{CPUPercent: cpu / float64(n), MemPercent: mem / float64(n), Hosts: n}, true
	}
}

// Mount meldet die 13 Routen an. Ohne Anbieter antworten sie mit `configured:false` bzw. 503 (unverändertes Verhalten).
func (m *Module) Mount(r module.Routes, d module.Deps) error {
	costs, svc, provider, region := m.setup(d)
	a := &api{provider: provider, region: region, audit: d.Audit, actorFn: d.Actor}
	// Nil-Zeiger in einem Interface wären „nicht nil“ — deshalb nur bei vorhandenem Anbieter setzen.
	if costs != nil {
		a.costs = costs
	}
	if svc != nil {
		a.control = svc
	}
	// Rechtepflicht je Route ausgeschrieben (nicht über eine Variable): so liest sie auch das Routentabellen-Werkzeug.
	r.Handle("GET /api/v1/cloud/pricing", module.Authenticated(), a.handleCloudPricing())
	r.Handle("POST /api/v1/cloud/estimate", module.Authenticated(), a.handleCloudEstimate())
	r.Handle("GET /api/v1/cloud/hosts", module.Authenticated(), a.handleCloudHosts())
	r.Handle("POST /api/v1/cloud/hosts/{id}/release", module.Verb(authz.VerbAdmin), a.handleReleaseHost())
	r.Handle("GET /api/v1/cloud/reservations", module.Authenticated(), a.handleListReservations())
	r.Handle("POST /api/v1/cloud/reservations", module.Verb(authz.VerbAdmin), a.handleCreateReservation())
	r.Handle("DELETE /api/v1/cloud/reservations/{id}", module.Verb(authz.VerbAdmin), a.handleDeleteReservation())
	r.Handle("GET /api/v1/cloud/policies", module.Authenticated(), a.handleListPolicies())
	r.Handle("PUT /api/v1/cloud/policies/{pool}", module.Verb(authz.VerbAdmin), a.handlePutPolicy())
	r.Handle("GET /api/v1/cloud/suggestions", module.Authenticated(), a.handleListSuggestions())
	r.Handle("POST /api/v1/cloud/suggestions/{id}/accept", module.Verb(authz.VerbAdmin), a.handleAcceptSuggestion())
	r.Handle("DELETE /api/v1/cloud/suggestions/{id}", module.Verb(authz.VerbAdmin), a.handleDismissSuggestion())
	r.Handle("GET /api/v1/cloud/costs", module.Authenticated(), a.handleCloudCosts())
	return nil
}

// Start: der Pool-Controller läuft nur, wenn ein Anbieter konfiguriert ist; der Kern ruft Start nur auf dem Raft-Leader.
func (m *Module) Start(ctx context.Context, _ module.Deps) error {
	if m.ctrl == nil {
		return nil
	}
	m.ctrl.Run(ctx, 5*time.Second)
	return nil
}
