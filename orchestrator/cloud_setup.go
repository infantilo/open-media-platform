package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/cloud"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/cluster"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/httpapi"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
)

// cloudDeps sind die Bausteine des Orchestrators, an die der Cloud-Teil angebunden wird.
type cloudDeps struct {
	Node      *cluster.Node
	DB        *sql.DB
	Audit     httpapi.DomainAuditLogger
	Hosts     *hosts.Store
	Metrics   *hosts.Tracker
	Launcher  *launcher.Launcher
	Placement *placement.Engine
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

// launcherCounter zählt die vom Launcher geführten Instanzen eines Hosts.
type launcherCounter struct{ l *launcher.Launcher }

func (c launcherCounter) CountOnHost(hostID string) int {
	n := 0
	for _, in := range c.l.List() {
		if in.HostID == hostID {
			n++
		}
	}
	return n
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

// cloudOptions schaltet die Cloud-Funktionen frei (ARCHITECTURE.md §27) und startet den Pool-Controller (nur auf dem
// Raft-Leader). Ohne `OMP_CLOUD_PROVIDER` bleibt der Kern ohne Anbieter lauffähig (`configured:false`).
//
//	OMP_CLOUD_PROVIDER   mock (Simulation, schreibt nichts in die Host-Tabelle) | aws
//	OMP_CLOUD_DEPLOYMENT Markierung dieses Orchestrators an allen Ressourcen (Standard „omp“)
//	OMP_CLOUD_POOLS      JSON-Liste der Pools (Pflicht bei aws; Standard bei mock: ein Pool „burst“)
//	OMP_CLOUD_USERDATA_FILE  Bootstrap-Vorlage ({{token}}, {{host}}); Pflicht bei aws
//	aws: OMP_CLOUD_AWS_REGION, AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (oder OMP_CLOUD_AWS_*), OMP_CLOUD_AWS_AMI,
//	     OMP_CLOUD_AWS_SUBNET, OMP_CLOUD_AWS_SECURITY_GROUPS, OMP_CLOUD_AWS_KEY_NAME,
//	     OMP_CLOUD_AWS_ALLOW_LAUNCH=1 (ohne: nur Trockenlauf, es startet und kostet nichts)
func cloudOptions(ctx context.Context, d cloudDeps) []httpapi.HandlerOption {
	off := []httpapi.HandlerOption{httpapi.WithCloud(nil, "", ""), httpapi.WithCloudControl(nil)}
	name := os.Getenv("OMP_CLOUD_PROVIDER")
	if name == "" {
		return off
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
			return off
		}
		userData = string(b)
	}
	var cfgs []poolConfig
	if raw := os.Getenv("OMP_CLOUD_POOLS"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &cfgs); err != nil {
			slog.Error("cloud: OMP_CLOUD_POOLS invalid, cloud features off", "error", err)
			return off
		}
	}

	var provider cloud.Provider
	var env cloud.Env
	region := ""
	switch name {
	case "mock":
		if len(cfgs) == 0 {
			cfgs = []poolConfig{{Name: "burst", Region: "mock-region", InstanceType: "m.medium", Max: 3, IdleAfterSec: 120, MaxLifetimeSec: 12 * 3600}}
		}
		region = "mock-region"
		provider = cloud.NewMockProvider()
		env = cloud.NewSimEnv(time.Now, 20*time.Second)
	case "aws":
		if len(cfgs) == 0 || os.Getenv("OMP_CLOUD_USERDATA_FILE") == "" {
			slog.Error("cloud: provider aws needs OMP_CLOUD_POOLS and OMP_CLOUD_USERDATA_FILE, cloud features off")
			return off
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
			return off
		}
		if os.Getenv("OMP_CLOUD_AWS_ALLOW_LAUNCH") != "1" {
			slog.Warn("cloud: AWS launching is DISABLED (dry run only) — set OMP_CLOUD_AWS_ALLOW_LAUNCH=1 to start instances")
		}
		provider = aws
		env = cloud.HostsEnv{Tokens: d.Hosts, Hosts: d.Hosts, Instances: launcherCounter{d.Launcher}, Placement: d.Placement}
	default:
		slog.Warn("unknown OMP_CLOUD_PROVIDER, cloud features off", "value", name)
		return off
	}

	var pools []cloud.Pool
	for _, c := range cfgs {
		pools = append(pools, c.pool(userData))
	}
	costs := &cloud.CostService{Provider: provider, Region: region, MinBilled: time.Minute, Lead: 5 * time.Minute, Teardown: 5 * time.Minute}
	mgr := cloud.NewManager(provider, deployment, pools, env, time.Now)
	if err := mgr.SetStore(cloud.NewSQLHosts(d.DB)); err != nil {
		slog.Warn("cloud: restoring hosts failed", "error", err)
	}
	store := cloud.NewSQLReservations(d.DB)
	policies := cloud.NewSQLPolicies(d.DB)
	ctrl := &cloud.PoolController{Manager: mgr, Reservations: store, Lead: 5 * time.Minute, Teardown: 5 * time.Minute,
		Policies: policies, Load: clusterLoad(d.Hosts, d.Metrics, d.Launcher),
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
	go runWhileLeader(ctx, d.Node, func(ctx context.Context) { ctrl.Run(ctx, 5*time.Second) })
	svc := &cloud.Service{Manager: mgr, Controller: ctrl, Reservations: store, Policies: policies}
	return []httpapi.HandlerOption{httpapi.WithCloud(costs, name, region), httpapi.WithCloudControl(svc)}
}

// clusterLoad liefert die durchschnittliche Auslastung der erreichbaren Hosts (Host-Agents mit frischer Telemetrie
// plus der lokale Orchestrator-Rechner) als Eingang des Cloud-Autoscalings. ok=false, solange nichts gemessen wird —
// dann skaliert nichts (kein Raten).
func clusterLoad(hostStore *hosts.Store, tracker *hosts.Tracker, launcherSvc *launcher.Launcher) func() (cloud.LoadSample, bool) {
	return func() (cloud.LoadSample, bool) {
		var cpu, mem float64
		n := 0
		if list, err := hostStore.ListHosts(); err == nil {
			for _, h := range list {
				m, ok := tracker.Get(h.ID)
				if !ok || time.Since(m.ReceivedAt) >= placement.HostOnlineThreshold || m.Goodbye || m.MemTotalBytes == 0 {
					continue
				}
				cpu += m.CPUPercent
				mem += float64(m.MemUsedBytes) / float64(m.MemTotalBytes) * 100
				n++
			}
		}
		if lh := launcherSvc.LocalHost(); lh != nil {
			cpu += lh.CPUPercent
			mem += lh.MemPercent
			n++
		}
		if n == 0 {
			return cloud.LoadSample{}, false
		}
		return cloud.LoadSample{CPUPercent: cpu / float64(n), MemPercent: mem / float64(n), Hosts: n}, true
	}
}
