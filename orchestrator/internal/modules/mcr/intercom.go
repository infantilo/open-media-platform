package mcr

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// Intercom-Verknüpfung (UMSETZUNG 106.12, ARCHITECTURE §33.2 M9): je Leitung ein Rückweg mit automatischem Mix-minus.
//
// Leitungs-JSON `intercom`:
//
//	{"return": {"mode": "mix"|"guest", "ttlMinutes": 1440,
//	            "source": {"type": "line", "lineId": "…"}                                   // Quelle ohne Kommentar
//	                    | {"type": "mixer", "role": "<Rolle>", "auxId": "1", "commentChannel": "3", "sender": "<Senderbezeichnung>"},
//	            "transport": {"uri": "srt://…", "mode": "caller", …}}}                      // nur bei mode=mix: SRT-Rückleitung
//
// **Regel für Mix-minus (keine stille Ersatzlösung):**
//   - Quelle ohne Kommentar (z. B. internationaler Ton einer Leitung) → IFB direkt: Ton der Quelle geht in den Programmeingang.
//   - Quelle mit Kommentar (Programmton des Heim-Mischers) → N-1-Bus am Audiomischer (`aux.<id>.setN1`, `exclude` = Kommentarkanal),
//     dessen Ausgang ist die Quelle.
//   - Nichts davon verfügbar → **Warnung am Event**, kein Rückweg-Eingang.

// ReturnPlan ist das Ergebnis der Regel für eine Leitung.
type ReturnPlan struct {
	Wanted     bool   `json:"wanted"`
	Mode       string `json:"mode"` // mix | guest
	TTLMinutes int    `json:"ttlMinutes"`
	// Action: "direct" (IFB direkt aus einer Leitung), "n1" (N-1-Bus am Mischer), "warn" (keine brauchbare Quelle).
	Action         string `json:"action"`
	SourceLine     string `json:"sourceLine,omitempty"`
	MixerRole      string `json:"mixerRole,omitempty"`
	AuxID          string `json:"auxId,omitempty"`
	CommentChannel string `json:"commentChannel,omitempty"`
	SenderLabel    string `json:"senderLabel,omitempty"`
	Warn           string `json:"warn,omitempty"`
	// Rückleitung (nur mode=mix): Ziel der SRT-/RIST-Rückleitung als Transport-JSON.
	Transport json.RawMessage `json:"transport,omitempty"`
}

type returnCfg struct {
	Mode       string `json:"mode"`
	TTLMinutes int    `json:"ttlMinutes"`
	Source     struct {
		Type           string `json:"type"`
		LineID         string `json:"lineId"`
		Role           string `json:"role"`
		AuxID          string `json:"auxId"`
		CommentChannel string `json:"commentChannel"`
		Sender         string `json:"sender"`
	} `json:"source"`
	Transport json.RawMessage `json:"transport"`
}

func returnOf(l Line) (returnCfg, bool) {
	var w struct {
		Return *returnCfg `json:"return"`
	}
	if len(l.Intercom) == 0 || json.Unmarshal(l.Intercom, &w) != nil || w.Return == nil {
		return returnCfg{}, false
	}
	return *w.Return, true
}

// PlanReturn wendet die Regel auf eine Leitung an. `lines` dient der Prüfung, ob die Quelllinie existiert.
func PlanReturn(l Line, lines []Line) ReturnPlan {
	rc, ok := returnOf(l)
	if !ok {
		return ReturnPlan{}
	}
	p := ReturnPlan{Wanted: true, Mode: rc.Mode, TTLMinutes: rc.TTLMinutes, Transport: rc.Transport}
	if p.Mode == "" {
		p.Mode = "mix"
	}
	if p.TTLMinutes <= 0 {
		p.TTLMinutes = 24 * 60
	}
	switch rc.Source.Type {
	case "line":
		found := false
		for _, o := range lines {
			if o.ID == rc.Source.LineID && o.ID != l.ID {
				found = true
			}
		}
		if !found {
			p.Action, p.Warn = "warn", fmt.Sprintf("Rückweg „%s“: Quellleitung %q nicht gefunden", l.Name, rc.Source.LineID)
			return p
		}
		p.Action, p.SourceLine = "direct", rc.Source.LineID
	case "mixer":
		switch {
		case rc.Source.Role == "" || rc.Source.AuxID == "":
			p.Action, p.Warn = "warn", fmt.Sprintf("Rückweg „%s“: Mischer-Quelle ohne Rolle oder Aux-Bus", l.Name)
		case rc.Source.CommentChannel == "":
			// Programmton ohne Angabe des Kommentarkanals: ein N-1 ist nicht möglich — ohne ihn würde der Kommentator sich hören.
			p.Action, p.Warn = "warn", fmt.Sprintf("Rückweg „%s“: Mischer-Quelle ohne Kommentarkanal — der Kommentator würde sich selbst hören, kein Rückweg", l.Name)
		default:
			p.Action, p.MixerRole, p.AuxID, p.CommentChannel, p.SenderLabel = "n1", rc.Source.Role, rc.Source.AuxID, rc.Source.CommentChannel, rc.Source.Sender
		}
	default:
		p.Action, p.Warn = "warn", fmt.Sprintf("Rückweg „%s“: keine Quelle eingetragen", l.Name)
	}
	return p
}

// IntercomAPI ruft den Intercom-Dienst über seinen Vertrag auf (*extsvc.Module).
type IntercomAPI interface {
	CallRole(ctx context.Context, kind, role string, params []string, body any, actor string) (int, []byte, error)
}

// Fabric verbindet Sender und Empfänger (Kern-Graph, IS-05) und findet sie über die Registry.
type Fabric interface {
	// AudioSender: Tonsender einer Instanz (Label-Hinweis optional, leer = erster Ton-Sender).
	AudioSender(instanceID, labelHint string) (string, bool)
	// AudioReceiver: Tonempfänger einer Instanz (der erste, der Ton nimmt).
	AudioReceiver(instanceID string) (string, bool)
	// IntercomReceiver: Programmeingang „Programm <slot>“ des Intercom-Nodes.
	IntercomReceiver(slot int) (string, bool)
	// IntercomSender: Mix-Ausgang „Intercom Mix <slot>“.
	IntercomSender(slot int) (string, bool)
	Connect(ctx context.Context, fromSender, toReceiver string) error
}

// Intercom führt Rückwege aus. nil im Runtime = keine Verknüpfung.
type Intercom struct {
	Svc    IntercomAPI
	Fabric Fabric
}

type returnReply struct {
	Return struct {
		Key        string `json:"key"`
		RetChannel int    `json:"ret_channel"`
		RetIn      int    `json:"ret_in"`
		RetOut     int    `json:"ret_out"`
		MicOut     int    `json:"mic_out"`
	} `json:"return"`
	Guest map[string]any `json:"guest"`
}

// ReturnKey: Schlüssel eines Rückwegs (stabil je Event und Leitung).
func ReturnKey(e Event, l Line) string { return e.ID + "/" + l.ID }

// Ensure legt für alle Leitungen mit Rückweg die Rückwege an und verbindet sie (idempotent). Rückgabe: Warnungen.
func (ic *Intercom) Ensure(ctx context.Context, rt *Runtime, s *Service, e Event, instances func(role string) string, roles map[string]LineRoles) []string {
	warns := []string{}
	for _, l := range e.Lines {
		p := PlanReturn(l, e.Lines)
		if !p.Wanted {
			continue
		}
		if p.Action == "warn" {
			warns = append(warns, p.Warn)
			continue
		}
		code, body, err := ic.Svc.CallRole(ctx, "intercom", "event.return.create", nil, map[string]any{
			"key": ReturnKey(e, l), "event": e.ID, "name": l.Name, "mode": p.Mode, "ttl_minutes": p.TTLMinutes}, "mcr")
		if err != nil || code >= 300 {
			warns = append(warns, fmt.Sprintf("Rückweg „%s“: Intercom nicht erreichbar oder lehnt ab (%v %d %s)", l.Name, err, code, strings.TrimSpace(string(body))))
			continue
		}
		var rr returnReply
		_ = json.Unmarshal(body, &rr)
		// Quelle bestimmen und verbinden
		var srcSender string
		switch p.Action {
		case "direct":
			src := roles[p.SourceLine]
			inst := instances(src.AudioOut())
			if inst == "" {
				warns = append(warns, fmt.Sprintf("Rückweg „%s“: Quellleitung läuft noch nicht", l.Name))
				continue
			}
			id, ok := ic.Fabric.AudioSender(inst, "")
			if !ok {
				warns = append(warns, fmt.Sprintf("Rückweg „%s“: Quellleitung hat keinen Tonsender", l.Name))
				continue
			}
			srcSender = id
		case "n1":
			inst := instances(p.MixerRole)
			if inst == "" {
				warns = append(warns, fmt.Sprintf("Rückweg „%s“: Mischer %q läuft nicht — kein N-1, kein Rückweg", l.Name, p.MixerRole))
				continue
			}
			if err := rt.CallMethod(ctx, inst, "aux."+p.AuxID+".setN1", map[string]any{"exclude": p.CommentChannel}); err != nil {
				warns = append(warns, fmt.Sprintf("Rückweg „%s“: N-1-Bus am Mischer nicht anlegbar (%v)", l.Name, err))
				continue
			}
			id, ok := ic.Fabric.AudioSender(inst, p.SenderLabel)
			if !ok {
				warns = append(warns, fmt.Sprintf("Rückweg „%s“: Mischer hat keinen Sender für den N-1-Bus", l.Name))
				continue
			}
			srcSender = id
		}
		slotIn := rr.Return.RetIn
		recv, ok := ic.Fabric.IntercomReceiver(slotIn)
		if !ok {
			warns = append(warns, fmt.Sprintf("Rückweg „%s“: Programmeingang %d am Intercom nicht gefunden", l.Name, slotIn))
			continue
		}
		if err := ic.Fabric.Connect(ctx, srcSender, recv); err != nil {
			warns = append(warns, fmt.Sprintf("Rückweg „%s“: Quelle nicht verbindbar (%v)", l.Name, err))
			continue
		}
		// Rückleitung: Mix-Ausgang des Intercoms → Rückleitungs-Node der Leitung
		if p.Mode == "mix" && roles[l.ID].Return != "" {
			rinst := instances(roles[l.ID].Return)
			if rinst == "" {
				warns = append(warns, fmt.Sprintf("Rückweg „%s“: Rückleitungs-Node läuft noch nicht", l.Name))
				continue
			}
			snd, ok1 := ic.Fabric.IntercomSender(rr.Return.RetOut)
			rcv, ok2 := ic.Fabric.AudioReceiver(rinst)
			if !ok1 || !ok2 {
				warns = append(warns, fmt.Sprintf("Rückweg „%s“: Mix-Ausgang oder Rückleitungs-Empfänger nicht gefunden", l.Name))
				continue
			}
			if err := ic.Fabric.Connect(ctx, snd, rcv); err != nil {
				warns = append(warns, fmt.Sprintf("Rückweg „%s“: Rückleitung nicht verbindbar (%v)", l.Name, err))
			}
		}
	}
	return warns
}

// Teardown räumt alle Rückwege des Events beim Intercom ab (idempotent).
func (ic *Intercom) Teardown(ctx context.Context, e Event) error {
	if ic == nil || ic.Svc == nil {
		return nil
	}
	wanted := false
	for _, l := range e.Lines {
		if PlanReturn(l, e.Lines).Wanted {
			wanted = true
		}
	}
	if !wanted {
		return nil
	}
	code, body, err := ic.Svc.CallRole(ctx, "intercom", "event.return.delete", []string{e.ID}, nil, "mcr")
	if err != nil {
		return fmt.Errorf("Rückwege abbauen: %w", err)
	}
	if code >= 300 {
		return fmt.Errorf("Rückwege abbauen: HTTP %d %s", code, strings.TrimSpace(string(body)))
	}
	return nil
}

var _ = strconv.Itoa
