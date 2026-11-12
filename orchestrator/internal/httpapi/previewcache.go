package httpapi

import (
	"sync"
	"sync/atomic"
	"time"
)

// Lastfund 2026-11-12 (tools/loadtest/media.py): 100 Clients x 4 Vorschau-Kacheln = 400 Poller (je 2 Bilder/s) liessen
// den Orchestrator-Stream-Proxy pro Bild zwei Node-Requests (Parameter + Bild) absetzen; Node und Orchestrator lagen
// bei ~100 % CPU, p95 421 ms. Das Vorschaubild ist fuer alle Betrachter dasselbe, daher:
//   - die Stream-URL eines Nodes (Parameterwert) wird kurz gemerkt,
//   - Einzelbilder (image/*) werden pro Node+Stream fuer wenige Zehntelsekunden geteilt; gleichzeitige Anfragen
//     warten auf EINEN Abruf. Die Last auf dem Node haengt damit nicht mehr von der Zahl der Betrachter ab.
//
// Dauerstroeme (alles ausser image/*) sind nie betroffen.
const (
	streamURLTTL   = 10 * time.Second
	frameShareTTL  = 150 * time.Millisecond
	frameMaxBytes  = 4 << 20
	cacheSweepSize = 256
)

type urlEntry struct {
	val string
	at  time.Time
}

type frameEntry struct {
	mu      sync.Mutex
	isImage atomic.Bool // gelernt: dieser Stream liefert Einzelbilder
	at      time.Time
	ct      string
	body    []byte
}

type streamCache struct {
	mu     sync.Mutex
	urls   map[string]urlEntry
	frames map[string]*frameEntry
}

func newStreamCache() *streamCache {
	return &streamCache{urls: map[string]urlEntry{}, frames: map[string]*frameEntry{}}
}

func (c *streamCache) url(key string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.urls[key]
	if !ok || time.Since(e.at) > streamURLTTL {
		return "", false
	}
	return e.val, true
}

func (c *streamCache) setURL(key, val string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.urls) > cacheSweepSize {
		for k, e := range c.urls {
			if time.Since(e.at) > streamURLTTL {
				delete(c.urls, k)
			}
		}
	}
	c.urls[key] = urlEntry{val: val, at: time.Now()}
}

func (c *streamCache) dropURL(key string) {
	c.mu.Lock()
	delete(c.urls, key)
	c.mu.Unlock()
}

func (c *streamCache) frame(key string) *frameEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.frames) > cacheSweepSize {
		for k, f := range c.frames {
			if f.mu.TryLock() {
				stale := time.Since(f.at) > time.Minute
				f.mu.Unlock()
				if stale {
					delete(c.frames, k)
				}
			}
		}
	}
	f, ok := c.frames[key]
	if !ok {
		f = &frameEntry{}
		c.frames[key] = f
	}
	return f
}
