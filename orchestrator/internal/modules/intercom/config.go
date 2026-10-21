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
	// Layout: eigenes Panel-Layout; Template: ID einer Vorlage (gilt, wenn kein eigenes Layout gesetzt ist).
	Layout   *Layout `json:"layout,omitempty"`
	Template int     `json:"template,omitempty"`
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

// Key ist eine Taste im Panel-Layout. Typen: "channel" (Kanal, Stil "strip" = volle Karte oder "key" = kompakte Taste),
// "call" (Teilnehmer rufen), "all" (Alle-Ruf), "reply" (Antworten), "mute", "dnd".
type Key struct {
	Type  string `json:"type"`
	Ch    int    `json:"ch,omitempty"`
	Party int    `json:"party,omitempty"`
	Label string `json:"label,omitempty"`
	Style string `json:"style,omitempty"`
}

type Page struct {
	Name string `json:"name"`
	Keys []Key  `json:"keys"`
}

// Layout ordnet die Tasten eines Panels auf Seiten. Fehlt es, zeigt das Panel alle zugeteilten Kanäle der Reihe nach.
type Layout struct {
	Pages []Page `json:"pages"`
}

// Template ist eine benannte Vorlage für Layouts (z. B. „Kamera“, „Regie“); Teilnehmer verweisen darauf.
type Template struct {
	ID     int    `json:"id"`
	Name   string `json:"name"`
	Layout Layout `json:"layout"`
}

const (
	maxPages       = 8
	maxKeysPerPage = 48
)

type Config struct {
	Channels  []Channel  `json:"channels"`
	Parties   []Party    `json:"parties"`
	Templates []Template `json:"templates,omitempty"`
	Guests    []Guest    `json:"guests,omitempty"`
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

func validLayout(owner string, l Layout, channels, parties map[int]bool, p *[]string) {
	if len(l.Pages) == 0 {
		*p = append(*p, fmt.Sprintf("%s: Layout ohne Seite", owner))
	}
	if len(l.Pages) > maxPages {
		*p = append(*p, fmt.Sprintf("%s: mehr als %d Seiten", owner, maxPages))
	}
	for i, pg := range l.Pages {
		if len(pg.Keys) > maxKeysPerPage {
			*p = append(*p, fmt.Sprintf("%s: Seite %d hat mehr als %d Tasten", owner, i+1, maxKeysPerPage))
		}
		if len(pg.Name) > 40 {
			*p = append(*p, fmt.Sprintf("%s: Seitenname %d zu lang", owner, i+1))
		}
		for j, k := range pg.Keys {
			at := fmt.Sprintf("%s, Seite %d, Taste %d", owner, i+1, j+1)
			if len(k.Label) > 40 {
				*p = append(*p, at+": Beschriftung zu lang")
			}
			switch k.Type {
			case "channel":
				if !channels[k.Ch] {
					*p = append(*p, fmt.Sprintf("%s: unbekannter Kanal %d", at, k.Ch))
				}
				if k.Style != "" && k.Style != "strip" && k.Style != "key" {
					*p = append(*p, fmt.Sprintf("%s: Stil %q unbekannt", at, k.Style))
				}
			case "call":
				if !parties[k.Party] {
					*p = append(*p, fmt.Sprintf("%s: unbekannter Teilnehmer %d", at, k.Party))
				}
			case "all", "reply", "mute", "dnd":
			default:
				*p = append(*p, fmt.Sprintf("%s: Tastenart %q unbekannt", at, k.Type))
			}
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
	tmpl := map[int]bool{}
	for _, t := range c.Templates {
		if t.ID <= 0 || tmpl[t.ID] {
			p = append(p, fmt.Sprintf("Vorlage %q: ID %d ungültig oder doppelt", t.Name, t.ID))
		}
		tmpl[t.ID] = true
		if strings.TrimSpace(t.Name) == "" {
			p = append(p, fmt.Sprintf("Vorlage %d ohne Namen", t.ID))
		}
		validLayout(fmt.Sprintf("Vorlage %q", t.Name), t.Layout, channels, ids, &p)
	}
	for _, pt := range c.Parties {
		if pt.Template != 0 && !tmpl[pt.Template] {
			p = append(p, fmt.Sprintf("Teilnehmer %q: unbekannte Vorlage %d", pt.Name, pt.Template))
		}
		if pt.Layout != nil {
			validLayout(fmt.Sprintf("Teilnehmer %q", pt.Name), *pt.Layout, channels, ids, &p)
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
		if l := c.EffectiveLayout(p); l != nil {
			m["layout"] = l
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

// EffectiveLayout: das eigene Layout des Teilnehmers, sonst das seiner Vorlage, sonst nil (Standardansicht).
func (c Config) EffectiveLayout(p Party) *Layout {
	if p.Layout != nil && len(p.Layout.Pages) > 0 {
		return p.Layout
	}
	for _, t := range c.Templates {
		if t.ID == p.Template && len(t.Layout.Pages) > 0 {
			l := t.Layout
			return &l
		}
	}
	return nil
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
