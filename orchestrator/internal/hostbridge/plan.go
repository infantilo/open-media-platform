// Package hostbridge (Kapitel 108): Brücken über Hostgrenzen für den Umzug von Instanzen, die über MXL (host-lokal)
// mit Nodes auf anderen Hosts verbunden sind. Dieser Teil ist die reine Planung: aus den Kanten, die nach dem Umzug
// eine Hostgrenze überqueren, und den Fähigkeiten der Hosts wird je Kante und Medium ein Transport gewählt
// (Nutzerentscheidung T1: Fabrics/RDMA, sonst ST 2110/AES67, zuletzt SRT).
package hostbridge

import (
	"errors"
	"fmt"
	"strings"
)

// Transport einer Brücke.
type Transport string

const (
	Fabrics Transport = "fabrics" // omp-fabrics-gateway (nur Bild)
	ST2110  Transport = "st2110"  // omp-2110-gateway (Bild)
	AES67   Transport = "aes67"   // omp-aes67-gateway (Ton)
	SRT     Transport = "srt"     // omp-srt-gateway (Bild)
)

// Medium einer Kante.
type Medium string

const (
	Video Medium = "video"
	Audio Medium = "audio"
	Data  Medium = "data"
)

// MediumOfFormat bildet das IS-04-Format (urn:x-nmos:format:video|audio|data) ab; "" bei unbekanntem Format.
func MediumOfFormat(format string) Medium {
	switch {
	case strings.HasSuffix(format, ":video"):
		return Video
	case strings.HasSuffix(format, ":audio"):
		return Audio
	case strings.HasSuffix(format, ":data"):
		return Data
	}
	return ""
}

// Format beschreibt, was die Brücke tragen muss (die Gateways haben ein festes Format, s. Kapitel 108).
type Format struct {
	Width, Height    int
	RateNum, RateDen int
	SampleRate       int
	Channels         int
}

// Caps: was ein Host kann. nil = unbekannt (wird angenommen; scheitert der Start, folgt der nächste Transport),
// false = ausdrücklich nicht.
type Caps struct {
	Fabrics, ST2110, AES67, SRT *bool
}

func (c Caps) has(t Transport) bool {
	var p *bool
	switch t {
	case Fabrics:
		p = c.Fabrics
	case ST2110:
		p = c.ST2110
	case AES67:
		p = c.AES67
	case SRT:
		p = c.SRT
	}
	return p == nil || *p
}

// Edge: eine Verbindung, die nach dem Umzug eine Hostgrenze überquert.
type Edge struct {
	Medium Medium
	Format Format
	// SenderHost sendet, ReceiverHost empfängt (Host-IDs, "" = Orchestrator-Rechner).
	SenderHost, ReceiverHost string
	// FromSender/ToReceiver: IS-05-IDs der Enden; ein Ende, das erst durch den Umzug entsteht, ist "" (wird später gesetzt).
	FromSender, ToReceiver string
	// Peer: Beschriftung der Gegenstelle für Meldungen.
	Peer string
}

// Bridge: eine zu bauende Strecke. Mehrere Kanten desselben Senders zum selben Empfangshost teilen sich eine Brücke.
type Bridge struct {
	Medium       Medium
	Format       Format
	SenderHost   string
	ReceiverHost string
	FromSender   string
	Receivers    []string
	// Candidates: mögliche Transporte in Vorzugsreihenfolge; Candidates[0] wird zuerst versucht.
	Candidates []Transport
	Peers      []string
	// Owner: Instanz-ID des umgezogenen Nodes, zu dem die Brücke gehört (Marke OMP_BRIDGE_OWNER an allen Gliedern).
	Owner string
}

// Marken an den Brücken-Gliedern (Startumgebung): Besitzer, Brücken-ID, Rolle in der Kette.
const (
	EnvOwner = "OMP_BRIDGE_OWNER"
	EnvID    = "OMP_BRIDGE_ID"
	EnvRole  = "OMP_BRIDGE_ROLE"
)

// ErrNoPath: für eine Kante gibt es keinen Transport.
var ErrNoPath = errors.New("hostbridge: no transport available for the connection across hosts")

// preference: Vorzugsreihenfolge je Medium (Nutzerentscheidung T1). Ton und Daten haben nur einen Weg.
func preference(m Medium) []Transport {
	switch m {
	case Video:
		return []Transport{Fabrics, ST2110, SRT}
	case Audio:
		return []Transport{AES67}
	}
	return nil
}

// Plan wählt je Kante die Transporte. capsOf liefert die Fähigkeiten eines Hosts. Gibt es für eine Kante keinen Weg,
// scheitert die ganze Planung mit ErrNoPath und Klartext (der Umzug darf dann nicht beginnen).
func Plan(edges []Edge, capsOf func(host string) Caps) ([]Bridge, error) {
	type key struct {
		from, sh, rh string
		m            Medium
	}
	index := map[key]int{}
	var out []Bridge
	for _, e := range edges {
		if e.SenderHost == e.ReceiverHost {
			continue
		}
		var cands []Transport
		for _, t := range preference(e.Medium) {
			if capsOf(e.SenderHost).has(t) && capsOf(e.ReceiverHost).has(t) {
				cands = append(cands, t)
			}
		}
		if len(cands) == 0 {
			what := string(e.Medium)
			if what == "" {
				what = "unknown format"
			}
			return nil, fmt.Errorf("%w: %s to %q (%s)", ErrNoPath, what, e.Peer, noPathReason(e.Medium))
		}
		k := key{e.FromSender, e.SenderHost, e.ReceiverHost, e.Medium}
		if e.FromSender != "" {
			if i, ok := index[k]; ok {
				out[i].Receivers = append(out[i].Receivers, e.ToReceiver)
				out[i].Peers = append(out[i].Peers, e.Peer)
				continue
			}
			index[k] = len(out)
		}
		out = append(out, Bridge{Medium: e.Medium, Format: e.Format, SenderHost: e.SenderHost, ReceiverHost: e.ReceiverHost,
			FromSender: e.FromSender, Receivers: []string{e.ToReceiver}, Candidates: cands, Peers: []string{e.Peer}})
	}
	return out, nil
}

func noPathReason(m Medium) string {
	switch m {
	case Video:
		return "no video gateway is available on both hosts"
	case Audio:
		return "audio needs the AES67 gateway on both hosts"
	case Data:
		return "data tracks (ANC) have no network path yet"
	}
	return "format not recognised"
}
