package authz

import (
	"os"
	"strconv"
	"sync"
	"time"
)

// Entscheidungs-Cache (Audit 2026-10-23 H7): Check/CheckWorkflow liefen bei jeder proxierten Aktion als Datenbankabfrage.
//
// Entzug darf nie verzögert wirken, deshalb: (1) jede Änderung an Rollenbindungen/Funktionsrechten über diesen Store und jede
// Änderung der Gruppenmitgliedschaft (groups.Store.OnChange → Invalidate) verwirft den ganzen Cache sofort; (2) Einträge leben
// nur kurz (Standard 2 s) — damit ist auch eine Änderung, die ein anderer Orchestrator des Clusters in der Datenbank gemacht hat,
// nach spätestens dieser Zeit sichtbar. OMP_AUTHZ_CACHE_TTL_MS=0 schaltet den Cache ab. Gecacht werden nur erfolgreiche Antworten.
const (
	defaultCacheTTL = 2 * time.Second
	maxCacheEntries = 20000
)

type decisionKey struct {
	kind                  byte // 'g' global/Node, 'w' Workflow/Rolle
	subject, workflow, id string
	verb                  Verb
}

type decisionCache struct {
	mu  sync.Mutex
	ttl time.Duration
	m   map[decisionKey]decisionEntry
	now func() time.Time
}

type decisionEntry struct {
	allowed bool
	until   time.Time
}

func newDecisionCache() *decisionCache {
	ttl := defaultCacheTTL
	if v, err := strconv.Atoi(os.Getenv("OMP_AUTHZ_CACHE_TTL_MS")); err == nil && v >= 0 {
		ttl = time.Duration(v) * time.Millisecond
	}
	return &decisionCache{ttl: ttl, m: map[decisionKey]decisionEntry{}, now: time.Now}
}

func (c *decisionCache) get(k decisionKey) (allowed, ok bool) {
	if c.ttl <= 0 {
		return false, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e, found := c.m[k]
	if !found || !c.now().Before(e.until) {
		if found {
			delete(c.m, k)
		}
		return false, false
	}
	return e.allowed, true
}

func (c *decisionCache) put(k decisionKey, allowed bool) {
	if c.ttl <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.m) >= maxCacheEntries {
		c.m = map[decisionKey]decisionEntry{}
	}
	c.m[k] = decisionEntry{allowed: allowed, until: c.now().Add(c.ttl)}
}

func (c *decisionCache) clear() {
	c.mu.Lock()
	c.m = map[decisionKey]decisionEntry{}
	c.mu.Unlock()
}

// Invalidate verwirft alle gemerkten Entscheidungen — nach jeder Änderung von Bindungen, Funktionsrechten oder Gruppenmitgliedschaft.
func (s *Store) Invalidate() { s.cache.clear() }
