package accessrules

import "testing"

func ep(id, node, label, media, wf string, tags ...string) Endpoint {
	return Endpoint{ID: id, NodeID: node, NodeLabel: node, Label: label, MediaType: media, WorkflowID: wf, Tags: tags}
}

func rule(effect, action, kind, sel, val string) Rule {
	return Rule{SubjectType: SubjectGlobal, Kind: kind, Action: action, Effect: effect, SelectorType: sel, SelectorValue: val}
}

func TestNoRulesMeansOpen(t *testing.T) {
	var p *Policy
	if !p.Visible(KindSource, ep("a", "n", "x", "video", "")).Allowed || !p.Routable(KindSink, ep("a", "n", "x", "video", "")).Allowed {
		t.Fatal("ohne Regeln muss alles offen sein")
	}
	if !NewPolicy(nil).Empty() {
		t.Fatal("leere Policy muss Empty sein")
	}
}

func TestDenyWinsOverAllow(t *testing.T) {
	p := NewPolicy([]Rule{rule(EffectAllow, ActionSee, KindSource, SelAll, ""), rule(EffectDeny, ActionSee, KindSource, SelTag, "geheim")})
	if p.Visible(KindSource, ep("a", "n", "x", "video", "", "geheim")).Allowed {
		t.Fatal("Sperren muss Erlauben schlagen")
	}
	if !p.Visible(KindSource, ep("b", "n", "x", "video", "", "offen")).Allowed {
		t.Fatal("andere Quellen bleiben sichtbar")
	}
}

func TestAllowListSwitchesToWhitelist(t *testing.T) {
	p := NewPolicy([]Rule{rule(EffectAllow, ActionSee, KindSource, SelNode, "studio-a")})
	if !p.Visible(KindSource, ep("a", "studio-a", "x", "video", "")).Allowed {
		t.Fatal("Quelle in der Freigabeliste muss sichtbar sein")
	}
	d := p.Visible(KindSource, ep("b", "studio-b", "x", "video", ""))
	if d.Allowed || d.Reason != "nicht in der Freigabeliste" {
		t.Fatalf("Quelle außerhalb der Freigabeliste = %+v", d)
	}
	// andere Art und Handlung bleiben offen
	if !p.Visible(KindSink, ep("c", "studio-b", "x", "video", "")).Allowed {
		t.Fatal("Senken sind von einer Quellen-Liste nicht betroffen")
	}
	if !p.decide(KindSource, ActionRoute, ep("b", "studio-b", "x", "video", "")).Allowed {
		t.Fatal("Schalten ist von einer Sehen-Liste nicht betroffen")
	}
}

func TestAllowListsOfSeveralScopesUnite(t *testing.T) {
	p := NewPolicy([]Rule{
		rule(EffectAllow, ActionSee, KindSink, SelNode, "a"),
		{SubjectType: SubjectGroup, Subject: "g1", Kind: KindSink, Action: ActionSee, Effect: EffectAllow, SelectorType: SelNode, SelectorValue: "b"},
	})
	for _, n := range []string{"a", "b"} {
		if !p.Visible(KindSink, ep("x", n, "l", "video", "")).Allowed {
			t.Fatalf("Node %s muss in der vereinigten Liste sein", n)
		}
	}
	if p.Visible(KindSink, ep("x", "c", "l", "video", "")).Allowed {
		t.Fatal("Node c ist in keiner Liste")
	}
}

func TestRoutingNeedsVisibility(t *testing.T) {
	p := NewPolicy([]Rule{rule(EffectDeny, ActionSee, KindSink, SelNode, "n"), rule(EffectAllow, ActionRoute, KindSink, SelAll, "")})
	if p.Routable(KindSink, ep("x", "n", "l", "video", "")).Allowed {
		t.Fatal("was nicht sichtbar ist, wird nicht geschaltet")
	}
	q := NewPolicy([]Rule{rule(EffectDeny, ActionRoute, KindSource, SelMedia, "audio")})
	if q.Routable(KindSource, ep("x", "n", "l", "audio", "")).Allowed || !q.Visible(KindSource, ep("x", "n", "l", "audio", "")).Allowed {
		t.Fatal("Schalten gesperrt, Sehen bleibt")
	}
}

func TestSelectors(t *testing.T) {
	e := Endpoint{ID: "s1", NodeID: "n1", NodeLabel: "Kamera Studio", Label: "Video 1", MediaType: "video", WorkflowID: "w1", Tags: []string{"Role.Kamera"}}
	cases := []struct {
		sel, val string
		want     bool
	}{
		{SelAll, "", true}, {SelEndpoint, "s1", true}, {SelEndpoint, "s2", false}, {SelNode, "n1", true}, {SelNode, "n2", false},
		{SelWorkflow, "w1", true}, {SelWorkflow, "w2", false}, {SelMedia, "VIDEO", true}, {SelMedia, "audio", false},
		{SelTag, "role.kamera", true}, {SelTag, "other", false},
		{SelLabel, "video*", true}, {SelLabel, "*1", true}, {SelLabel, "kamera*/ video*", true}, {SelLabel, "*studio*", true}, {SelLabel, "audio*", false}, {SelLabel, "Video 1", true},
	}
	for _, c := range cases {
		if got := (Rule{SelectorType: c.sel, SelectorValue: c.val}).Matches(e); got != c.want {
			t.Errorf("Selektor %s %q = %v, want %v", c.sel, c.val, got, c.want)
		}
	}
}

func TestValidate(t *testing.T) {
	ok := Rule{SubjectType: SubjectUser, Subject: "anna", Kind: KindSink, Action: ActionRoute, Effect: EffectDeny, SelectorType: SelNode, SelectorValue: "n"}
	if err := ok.Validate(); err != nil {
		t.Fatalf("gültige Regel abgelehnt: %v", err)
	}
	bad := []Rule{
		{SubjectType: SubjectUser, Kind: KindSink, Action: ActionSee, Effect: EffectAllow, SelectorType: SelAll},                       // Nutzer fehlt
		{SubjectType: SubjectGlobal, Subject: "x", Kind: KindSink, Action: ActionSee, Effect: EffectAllow, SelectorType: SelAll},       // global mit Subjekt
		{SubjectType: SubjectGlobal, Kind: "x", Action: ActionSee, Effect: EffectAllow, SelectorType: SelAll},                          // Art
		{SubjectType: SubjectGlobal, Kind: KindSink, Action: "x", Effect: EffectAllow, SelectorType: SelAll},                           // Handlung
		{SubjectType: SubjectGlobal, Kind: KindSink, Action: ActionSee, Effect: "x", SelectorType: SelAll},                             // Wirkung
		{SubjectType: SubjectGlobal, Kind: KindSink, Action: ActionSee, Effect: EffectAllow, SelectorType: SelNode},                    // Wert fehlt
		{SubjectType: SubjectGlobal, Kind: KindSink, Action: ActionSee, Effect: EffectAllow, SelectorType: SelAll, SelectorValue: "x"}, // all mit Wert
		{SubjectType: SubjectGlobal, Kind: KindSink, Action: ActionSee, Effect: EffectAllow, SelectorType: "x"},                        // Selektor
	}
	for i, r := range bad {
		if r.Validate() == nil {
			t.Errorf("ungültige Regel %d wurde akzeptiert: %+v", i, r)
		}
	}
}
