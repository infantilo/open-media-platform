package intercom

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Kanal-IDs ab diesem Wert belegt der Node für Rufe; Gäste bekommen Teilnehmer-IDs ab GuestBase.
const (
	maxChannelID = 999_999
	GuestBase    = 100_000
)

// Route: ein Teilnehmer ↔ Kanal (Sprechen/Hören erlaubt, Startpegel und -lage).
type Route struct {
	Ch     int     `json:"ch"`
	Talk   bool    `json:"talk"`
	Listen bool    `json:"listen"`
	Level  float64 `json:"level,omitempty"`
	Pan    float64 `json:"pan,omitempty"`
	Vox    bool    `json:"vox,omitempty"`
}

type Channel struct {
	ID    int    `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color,omitempty"`
	// Kind: "party" (Partyline) oder "ifb" (Programm + Unterbrechung).
	Kind string `json:"kind,omitempty"`
	// DuckDB: Dämpfung der Programmquellen, solange jemand in den Kanal spricht (IFB).
	DuckDB float64 `json:"duck_db,omitempty"`
}

type Vox struct {
	ThresholdDB float64 `json:"threshold_db"`
	HoldMS      int     `json:"hold_ms"`
}

type Party struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
	// Kind: "human" (Panel), "seat" (Rollenplatz), "program" (Programmquelle), "port" (Hardware-/MXL-Anbindung).
	Kind     string `json:"kind,omitempty"`
	Priority int    `json:"priority,omitempty"`
	// Force: darf andere zwangs-stumm schalten und Alle-Ruf auslösen.
	Force bool `json:"force,omitempty"`
	// OnAirLock: Mikrofon gesperrt, solange On Air gemeldet wird.
	OnAirLock bool `json:"onair_lock,omitempty"`
	// Users/Groups: wer dieses Panel öffnen darf. Open: jede Person mit Recht „intercom.use“ (Rollenplatz zum Anmelden).
	Users   []string `json:"users,omitempty"`
	Groups  []string `json:"groups,omitempty"`
	Open    bool     `json:"open,omitempty"`
	Routes  []Route  `json:"routes"`
	Vox     *Vox     `json:"vox,omitempty"`
	MicGain *float64 `json:"mic_gain,omitempty"`
	// MxlIn/MxlOut: Programmeingang bzw. Mix-Ausgang des Nodes (1-basiert, 0 = keiner), für Arten „program“ und „port“.
	MxlIn  int `json:"mxl_in,omitempty"`
	MxlOut int `json:"mxl_out,omitempty"`
	// Token wird nur serverseitig vergeben und nie über die Konfigurations-API ausgeliefert.
	Token string `json:"token,omitempty"`
}

// Guest ist ein befristeter Zugang per Link (Telefon/Browser ohne Konto).
type Guest struct {
	ID        int       `json:"id"`
	Name      string    `json:"name"`
	Token     string    `json:"token,omitempty"`
	Expires   time.Time `json:"expires"`
	Routes    []Route   `json:"routes"`
	CreatedBy string    `json:"created_by,omitempty"`
}

type Config struct {
	Channels []Channel `json:"channels"`
	Parties  []Party   `json:"parties"`
	Guests   []Guest   `json:"guests,omitempty"`
}

// ValidationError sammelt alle Probleme auf einmal (die Oberfläche zeigt sie gemeinsam).
type ValidationError struct{ Problems []string }

func (e *ValidationError) Error() string { return strings.Join(e.Problems, "; ") }

func newToken() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func ParseConfig(raw []byte) (Config, error) {
	var c Config
	if len(raw) == 0 {
		return Config{Channels: []Channel{}, Parties: []Party{}}, nil
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return Config{}, err
	}
	if c.Channels == nil {
		c.Channels = []Channel{}
	}
	if c.Parties == nil {
		c.Parties = []Party{}
	}
	return c, nil
}

func validRoutes(owner string, routes []Route, channels map[int]bool, p *[]string) {
	seen := map[int]bool{}
	for _, r := range routes {
		if !channels[r.Ch] {
			*p = append(*p, fmt.Sprintf("%s: Route auf unbekannten Kanal %d", owner, r.Ch))
		}
		if seen[r.Ch] {
			*p = append(*p, fmt.Sprintf("%s: Kanal %d doppelt", owner, r.Ch))
		}
		seen[r.Ch] = true
		if r.Pan < -1 || r.Pan > 1 {
			*p = append(*p, fmt.Sprintf("%s: Lage bei Kanal %d außerhalb −1…1", owner, r.Ch))
		}
		if r.Level < 0 || r.Level > 2 {
			*p = append(*p, fmt.Sprintf("%s: Pegel bei Kanal %d außerhalb 0…2", owner, r.Ch))
		}
	}
}

// Validate prüft die gesamte Konfiguration.
func (c Config) Validate() error {
	var p []string
	channels := map[int]bool{}
	names := map[string]bool{}
	for _, ch := range c.Channels {
		switch {
		case ch.ID <= 0 || ch.ID > maxChannelID:
			p = append(p, fmt.Sprintf("Kanal %q: ID %d ungültig (1…%d)", ch.Name, ch.ID, maxChannelID))
		case channels[ch.ID]:
			p = append(p, fmt.Sprintf("Kanal-ID %d doppelt", ch.ID))
		}
		if strings.TrimSpace(ch.Name) == "" {
			p = append(p, fmt.Sprintf("Kanal %d ohne Namen", ch.ID))
		}
		if names[strings.ToLower(ch.Name)] {
			p = append(p, fmt.Sprintf("Kanalname %q doppelt", ch.Name))
		}
		names[strings.ToLower(ch.Name)] = true
		if ch.Kind != "" && ch.Kind != "party" && ch.Kind != "ifb" {
			p = append(p, fmt.Sprintf("Kanal %q: Art %q unbekannt", ch.Name, ch.Kind))
		}
		if ch.DuckDB < 0 || ch.DuckDB > 60 {
			p = append(p, fmt.Sprintf("Kanal %q: Dämpfung außerhalb 0…60 dB", ch.Name))
		}
		channels[ch.ID] = true
	}
	ids := map[int]bool{}
	pnames := map[string]bool{}
	usedIn, usedOut := map[int]string{}, map[int]string{}
	for _, pt := range c.Parties {
		if pt.ID <= 0 || pt.ID >= GuestBase {
			p = append(p, fmt.Sprintf("Teilnehmer %q: ID %d ungültig (1…%d)", pt.Name, pt.ID, GuestBase-1))
		}
		if ids[pt.ID] {
			p = append(p, fmt.Sprintf("Teilnehmer-ID %d doppelt", pt.ID))
		}
		ids[pt.ID] = true
		if strings.TrimSpace(pt.Name) == "" {
			p = append(p, fmt.Sprintf("Teilnehmer %d ohne Namen", pt.ID))
		}
		if pnames[strings.ToLower(pt.Name)] {
			p = append(p, fmt.Sprintf("Teilnehmername %q doppelt", pt.Name))
		}
		pnames[strings.ToLower(pt.Name)] = true
		switch pt.Kind {
		case "", "human", "seat", "program", "port":
		default:
			p = append(p, fmt.Sprintf("Teilnehmer %q: Art %q unbekannt", pt.Name, pt.Kind))
		}
		if pt.Priority < 0 || pt.Priority > 9 {
			p = append(p, fmt.Sprintf("Teilnehmer %q: Priorität außerhalb 0…9", pt.Name))
		}
		if pt.Vox != nil && (pt.Vox.ThresholdDB > 0 || pt.Vox.ThresholdDB < -80 || pt.Vox.HoldMS < 0 || pt.Vox.HoldMS > 5000) {
			p = append(p, fmt.Sprintf("Teilnehmer %q: Sprachaktivierung außerhalb des Bereichs", pt.Name))
		}
		validRoutes(fmt.Sprintf("Teilnehmer %q", pt.Name), pt.Routes, channels, &p)
		if pt.MxlIn < 0 || pt.MxlIn > 16 || pt.MxlOut < 0 || pt.MxlOut > 16 {
			p = append(p, fmt.Sprintf("Teilnehmer %q: MXL-Anschluss außerhalb 0…16", pt.Name))
		}
		if (pt.MxlIn > 0 || pt.MxlOut > 0) && pt.Kind != "program" && pt.Kind != "port" {
			p = append(p, fmt.Sprintf("Teilnehmer %q: MXL-Anschluss nur bei Art „Programmquelle“ oder „Anbindung“", pt.Name))
		}
		for _, d := range []struct {
			n    int
			used map[int]string
			what string
		}{{pt.MxlIn, usedIn, "Programmeingang"}, {pt.MxlOut, usedOut, "Mix-Ausgang"}} {
			if d.n == 0 {
				continue
			}
			if other, dup := d.used[d.n]; dup {
				p = append(p, fmt.Sprintf("%s %d doppelt belegt (%q und %q)", d.what, d.n, other, pt.Name))
			}
			d.used[d.n] = pt.Name
		}
	}
	for _, g := range c.Guests {
		if g.ID < GuestBase {
			p = append(p, fmt.Sprintf("Gast %q: ID %d ungültig", g.Name, g.ID))
		}
		validRoutes(fmt.Sprintf("Gast %q", g.Name), g.Routes, channels, &p)
	}
	if len(p) > 0 {
		return &ValidationError{Problems: p}
	}
	return nil
}

// WithTokens übernimmt die Token der bisherigen Konfiguration (gleiche ID) und vergibt neue für neue Teilnehmer.
// Clients dürfen Token nie setzen.
func (c Config) WithTokens(old Config) Config {
	tokens := map[int]string{}
	for _, p := range old.Parties {
		tokens[p.ID] = p.Token
	}
	for i := range c.Parties {
		if t := tokens[c.Parties[i].ID]; t != "" {
			c.Parties[i].Token = t
		} else {
			c.Parties[i].Token = newToken()
		}
	}
	// Gäste kommen nur über die Gast-Endpunkte: bestehende bleiben unverändert.
	c.Guests = old.Guests
	return c
}

// Redacted entfernt alle Token (für die Auslieferung an die Oberfläche).
func (c Config) Redacted() Config {
	out := Config{Channels: c.Channels, Parties: make([]Party, len(c.Parties)), Guests: make([]Guest, len(c.Guests))}
	copy(out.Parties, c.Parties)
	for i := range out.Parties {
		out.Parties[i].Token = ""
	}
	copy(out.Guests, c.Guests)
	for i := range out.Guests {
		out.Guests[i].Token = ""
	}
	return out
}

// ActiveGuests: die noch nicht abgelaufenen Gäste.
func (c Config) ActiveGuests(now time.Time) []Guest {
	var out []Guest
	for _, g := range c.Guests {
		if g.Expires.After(now) {
			out = append(out, g)
		}
	}
	return out
}

// NodeConfig ist das Dokument, das der Node unter `PUT /config` erwartet.
func (c Config) NodeConfig(now time.Time) map[string]any {
	route := func(r Route) map[string]any {
		m := map[string]any{"ch": r.Ch, "talk": r.Talk, "listen": r.Listen}
		if r.Level > 0 {
			m["level"] = r.Level
		}
		if r.Pan != 0 {
			m["pan"] = r.Pan
		}
		if r.Vox {
			m["vox"] = true
		}
		return m
	}
	routes := func(rs []Route) []map[string]any {
		out := make([]map[string]any, 0, len(rs))
		for _, r := range rs {
			out = append(out, route(r))
		}
		return out
	}
	channels := make([]map[string]any, 0, len(c.Channels))
	for _, ch := range c.Channels {
		kind := ch.Kind
		if kind == "" {
			kind = "party"
		}
		channels = append(channels, map[string]any{"id": ch.ID, "name": ch.Name, "color": ch.Color, "kind": kind, "duck_db": ch.DuckDB})
	}
	parties := make([]map[string]any, 0, len(c.Parties))
	for _, p := range c.Parties {
		kind := p.Kind
		if kind == "" || kind == "seat" {
			kind = "human"
		}
		m := map[string]any{"id": p.ID, "name": p.Name, "kind": kind, "token": p.Token, "priority": p.Priority,
			"force": p.Force, "onair_lock": p.OnAirLock, "routes": routes(p.Routes)}
		if p.Vox != nil {
			m["vox"] = map[string]any{"threshold_db": p.Vox.ThresholdDB, "hold_ms": p.Vox.HoldMS}
		}
		if p.MicGain != nil {
			m["mic_gain"] = *p.MicGain
		}
		if p.MxlIn > 0 {
			m["mxl_in"] = p.MxlIn
		}
		if p.MxlOut > 0 {
			m["mxl_out"] = p.MxlOut
		}
		parties = append(parties, m)
	}
	for _, g := range c.ActiveGuests(now) {
		parties = append(parties, map[string]any{"id": g.ID, "name": g.Name, "kind": "human", "token": g.Token, "routes": routes(g.Routes)})
	}
	return map[string]any{"channels": channels, "parties": parties}
}

// PartiesFor liefert die Teilnehmer, deren Panel die Person öffnen darf.
func (c Config) PartiesFor(user string, groups []string) []Party {
	var out []Party
	for _, p := range c.Parties {
		if p.Kind == "program" || p.Kind == "port" {
			continue
		}
		ok := p.Open
		for _, u := range p.Users {
			if strings.EqualFold(u, user) {
				ok = true
			}
		}
		for _, g := range p.Groups {
			for _, mine := range groups {
				if g == mine {
					ok = true
				}
			}
		}
		if ok {
			out = append(out, p)
		}
	}
	return out
}
