package mcr

import (
	"context"
	"net/http"
)

// Rechte je Event (106.14). Zwei Ebenen:
//   - **Funktionsrechte** (global): `mcr.view` sieht alle Events (nur lesen); `mcr.live` bedient alle Events (Test, Sendung, Ausgleich);
//     `mcr.manage` verwaltet alles, trägt Mitglieder ein und legt Events an. Jedes Recht schließt das darunter ein. Die Namen sind die
//     bereits vergebenen (statt neuer `operate`/`configure`), damit bestehende Gruppen-Zuweisungen weiterwirken.
//   - **Event-Rollen** (je Event, Mitglieder oder Verantwortliche): `lead` alles am Event außer Mitgliedern; `engineer` Leitungen testen,
//     Ausgleich bedienen; `viewer` nur ansehen; `commentator` hat in der Verwaltung keinen Zugriff (er nutzt nur seine Sprechstelle im Intercom).
//     Wer Verantwortliche(r) des Events ist (Person oder Gruppe), gilt als `lead`.

// FeatView: alle Events ansehen.
const FeatView = "mcr.view"

// Handlungen, die geprüft werden.
const (
	ActView    = "view"    // ansehen: Event, Zustand, Alarme, Wand
	ActTest    = "test"    // Geplant ↔ Test, Messen, Ausgleich, Alarme quittieren, Alarm-PiP, Abhören/Messgerät
	ActLive    = "live"    // auf Sendung, Abbau, Beenden, Abbrechen
	ActEdit    = "edit"    // Event, Leitungen ändern, Event löschen
	ActMembers = "members" // Mitglieder eintragen (nur Verwaltung)
)

// Actor ist die handelnde Person samt Rechten. `Open` = Bootstrap-Modus oder Test ohne Rechtespeicher: alles erlaubt.
type Actor struct {
	User   string
	Groups []string
	Open   bool
	Manage bool
	Live   bool
	View   bool
}

func (a Actor) inGroup(g string) bool {
	for _, x := range a.Groups {
		if x == g {
			return true
		}
	}
	return false
}

// RoleIn: höchste Rolle der Person im Event ("" = keine). Verantwortliche gelten als `lead`.
func RoleIn(e Event, a Actor) string {
	rank := map[string]int{RoleLead: 4, RoleEngineer: 3, RoleViewer: 2, RoleCommentator: 1}
	best := ""
	set := func(r string) {
		if rank[r] > rank[best] {
			best = r
		}
	}
	if (a.User != "" && e.Owner == a.User) || (e.OwnerGroup != "" && a.inGroup(e.OwnerGroup)) {
		set(RoleLead)
	}
	for _, m := range e.Members {
		if (m.SubjectType == "user" && m.Subject == a.User && a.User != "") || (m.SubjectType == "group" && a.inGroup(m.Subject)) {
			set(m.Role)
		}
	}
	return best
}

// Allowed: darf die Person die Handlung am Event ausführen? Rein.
func Allowed(a Actor, e Event, act string) bool {
	if a.Open || a.Manage {
		return true
	}
	switch act {
	case ActMembers:
		return false // nur Verwaltung
	case ActView:
		if a.View || a.Live {
			return true
		}
	case ActTest, ActLive:
		if a.Live {
			return true
		}
	}
	switch RoleIn(e, a) {
	case RoleLead:
		return act == ActView || act == ActTest || act == ActLive || act == ActEdit
	case RoleEngineer:
		return act == ActView || act == ActTest
	case RoleViewer:
		return act == ActView
	}
	return false
}

// TransitionAction: welche Handlung verlangt der Zustandswechsel? Test (Geplant ↔ Test) bedient auch die Technik, alles andere die Leitung.
func TransitionAction(from, to string) string {
	if (from == StatePlanned && to == StateTesting) || (from == StateTesting && to == StatePlanned) {
		return ActTest
	}
	return ActLive
}

// EventAccess sagt der Oberfläche, was die Person an einem Event darf (die Server-Prüfung gilt trotzdem).
type EventAccess struct {
	Role    string `json:"role,omitempty"`
	View    bool   `json:"view"`
	Test    bool   `json:"test"`
	Live    bool   `json:"live"`
	Edit    bool   `json:"edit"`
	Members bool   `json:"members"`
}

// AccessOf: Rechte der Person am Event.
func AccessOf(a Actor, e Event) EventAccess {
	return EventAccess{Role: RoleIn(e, a), View: Allowed(a, e, ActView), Test: Allowed(a, e, ActTest), Live: Allowed(a, e, ActLive), Edit: Allowed(a, e, ActEdit), Members: Allowed(a, e, ActMembers)}
}

// actor: die Person der Anfrage; ohne Rechtespeicher (Bootstrap, Tests) ist alles erlaubt.
func (a *api) actor(r *http.Request) Actor {
	if a.access == nil {
		return Actor{User: actorOf(r), Open: true}
	}
	id := a.access.Identity(r)
	has := func(f string) bool { return id.Has != nil && id.Has(f) }
	live := has(FeatLive) || has(FeatManage)
	return Actor{User: id.User, Groups: id.Groups, Manage: has(FeatManage), Live: live, View: has(FeatView) || live}
}

// authorize lädt das Event und prüft die Handlung. Wer das Event nicht sehen darf, bekommt 404 (es „gibt“ es für ihn nicht); wer es sieht,
// aber die Handlung nicht darf, 403.
func (a *api) authorize(w http.ResponseWriter, r *http.Request, id, act string) (Event, bool) {
	e, err := a.svc.GetEvent(r.Context(), id)
	if err != nil {
		writeErr(w, err)
		return e, false
	}
	who := a.actor(r)
	if !Allowed(who, e, ActView) {
		writeErr(w, ErrNotFound)
		return e, false
	}
	if act != ActView && !Allowed(who, e, act) {
		writeErr(w, ErrForbidden)
		return e, false
	}
	return e, true
}

// visibleTo: Filter für Listen (Wand, Eventliste, Historie).
func (a *api) visibleTo(r *http.Request) func(Event) bool {
	who := a.actor(r)
	if who.Open || who.Manage || who.View || who.Live {
		return nil // alle
	}
	return func(e Event) bool { return Allowed(who, e, ActView) }
}

// visibleEvents lädt die Events mit Mitgliedern und filtert sie nach Sichtbarkeit.
func (a *api) visibleEvents(ctx context.Context, r *http.Request, list []Event) []Event {
	who := a.actor(r)
	vis := a.visibleTo(r)
	out := []Event{}
	for _, e := range list {
		if vis != nil || !who.Open { // Mitglieder und Verantwortliche brauchen die Mitgliederliste für die Rechte
			if full, err := a.svc.St.GetEvent(ctx, e.ID); err == nil {
				e.Members = full.Members
			}
		}
		if vis != nil && !vis(e) {
			continue
		}
		acc := AccessOf(who, e)
		e.Access = &acc
		out = append(out, e)
	}
	return out
}
