package workflows

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func renameDef() Definition {
	return Definition{
		Roles: []Role{
			{Name: "Bildmischer", NodeType: "omp-video-mixer-me"},
			{Name: "Tonmischer", NodeType: "omp-audio-mixer"},
			{Name: "Recorder", NodeType: "omp-recorder"},
			{Name: "Radio-Automation", NodeType: "omp-radio-automation", Env: map[string]string{"OMP_RADIO_TARGET_LABEL": "Tonmischer"}},
		},
		Connections: []Connection{
			{FromRole: "Bildmischer", FromSender: "PGM", ToRole: "Recorder", ToReceiver: "Video"},
			{FromRole: "Tonmischer", FromSender: "Tonmischer Sender 1", ToRole: "Recorder", ToReceiver: "Audio"},
			{FromRole: "Recorder", FromSender: "Recorder Out", ToRole: "Bildmischer", ToReceiver: "Bildmischer Eingang 1"},
		},
		Interface: &Interface{Outputs: []InterfacePort{{Name: "PGM", Members: []InterfaceMember{
			{Role: "Bildmischer", Port: "PGM"}, {Role: "Tonmischer", Port: "Tonmischer Sender 1"}}}}},
	}
}

func TestRenameRolesInDefinition(t *testing.T) {
	in := renameDef()
	out, err := RenameRolesInDefinition(in, map[string]string{"Bildmischer": "Video Mixer", "Tonmischer": "Audio Mixer", "Radio-Automation": "Radio Automation"})
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, r := range out.Roles {
		names = append(names, r.Name)
	}
	if strings.Join(names, ",") != "Video Mixer,Audio Mixer,Recorder,Radio Automation" {
		t.Fatalf("Rollen: %v", names)
	}
	c := out.Connections
	if c[0].FromRole != "Video Mixer" || c[0].FromSender != "PGM" || c[0].ToRole != "Recorder" {
		t.Errorf("Verbindung 1: %+v", c[0])
	}
	// Das Port-Präfix folgt der Rolle (Port „<Rolle> Sender 1“), fremde Ports bleiben.
	if c[1].FromRole != "Audio Mixer" || c[1].FromSender != "Audio Mixer Sender 1" {
		t.Errorf("Verbindung 2: %+v", c[1])
	}
	if c[2].ToRole != "Video Mixer" || c[2].ToReceiver != "Video Mixer Eingang 1" || c[2].FromSender != "Recorder Out" {
		t.Errorf("Verbindung 3: %+v", c[2])
	}
	m := out.Interface.Outputs[0].Members
	if m[0].Role != "Video Mixer" || m[0].Port != "PGM" || m[1].Role != "Audio Mixer" || m[1].Port != "Audio Mixer Sender 1" {
		t.Errorf("Schnittstelle: %+v", m)
	}
	// Umgebungswerte, die eine Rolle beim Namen nennen, folgen; andere nicht.
	if env := out.Roles[3].Env; env["OMP_RADIO_TARGET_LABEL"] != "Audio Mixer" {
		t.Errorf("Env: %v", env)
	}
	// Die übergebene Definition bleibt unberührt.
	if in.Roles[0].Name != "Bildmischer" || in.Connections[1].FromSender != "Tonmischer Sender 1" || in.Roles[3].Env["OMP_RADIO_TARGET_LABEL"] != "Tonmischer" {
		t.Error("Eingabe wurde verändert")
	}
}

func TestRenameRolesSwapAndErrors(t *testing.T) {
	// Tausch zweier Namen gleichzeitig.
	out, err := RenameRolesInDefinition(renameDef(), map[string]string{"Bildmischer": "Tonmischer", "Tonmischer": "Bildmischer"})
	if err != nil {
		t.Fatal(err)
	}
	if out.Roles[0].Name != "Tonmischer" || out.Roles[1].Name != "Bildmischer" || out.Connections[1].FromRole != "Bildmischer" || out.Connections[1].FromSender != "Bildmischer Sender 1" {
		t.Errorf("Tausch: %+v", out.Connections[1])
	}
	for name, m := range map[string]map[string]string{
		"leer":           {},
		"unbekannt":      {"Gibt es nicht": "X"},
		"leerer Name":    {"Bildmischer": "  "},
		"doppelter Name": {"Bildmischer": "Recorder"},
		"beide gleich":   {"Bildmischer": "X", "Tonmischer": "X"},
	} {
		if _, err := RenameRolesInDefinition(renameDef(), m); !errors.Is(err, ErrValidation) {
			t.Errorf("%s: ErrValidation erwartet, bekam %v", name, err)
		}
	}
}

func TestRenameRoleStateAliases(t *testing.T) {
	blob := json.RawMessage(`{"sources":[{"id":"@@omp-role-sender:Bildmischer:1"},"@@omp-role-sender:Quelle 1:0","@@omp-role-sender:Fremd:2"],"follow":"@@omp-role-node:Bildmischer","plain":"Bildmischer","n":3}`)
	m := map[string]string{"Bildmischer": "Video Mixer", "Quelle 1": "Source 1"}
	out, err := RenameRoleStateJSON(blob, m)
	if err != nil {
		t.Fatal(err)
	}
	var v map[string]any
	_ = json.Unmarshal(out, &v)
	src := v["sources"].([]any)
	if src[0].(map[string]any)["id"] != "@@omp-role-sender:Video Mixer:1" || src[1] != "@@omp-role-sender:Source 1:0" || src[2] != "@@omp-role-sender:Fremd:2" {
		t.Errorf("Sender-Alias: %v", src)
	}
	if v["follow"] != "@@omp-role-node:Video Mixer" || v["plain"] != "Bildmischer" || v["n"].(float64) != 3 {
		t.Errorf("Rest: %v", v)
	}
	// Schlüssel der Zustandsliste folgen ebenfalls; der Rolle-Zustand bleibt erhalten.
	states := map[string]json.RawMessage{"Bildmischer": blob, "Recorder": json.RawMessage(`{"a":1}`)}
	got := RenameRoleStateMap(states, m)
	if _, ok := got["Bildmischer"]; ok || len(got) != 2 || string(got["Recorder"]) != `{"a":1}` || !strings.Contains(string(got["Video Mixer"]), "Video Mixer:1") {
		t.Errorf("Zustandsliste: %v", got)
	}
}

func TestServiceRenameRolesMigratesStateAndNeedsStopped(t *testing.T) {
	store := newFakeStore()
	svc := newTestService(store, &fakeNodeLister{}, &fakeGraph{}, &fakeLauncher{})
	def := renameDef()
	wf, err := svc.Create("Durchlauf", def, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	store.roleStates = map[string]map[string]json.RawMessage{wf.ID: {"Bildmischer": json.RawMessage(`{"x":"@@omp-role-node:Tonmischer"}`)}}
	out, err := svc.RenameRoles(wf.ID, map[string]string{"Bildmischer": "Video Mixer", "Tonmischer": "Audio Mixer"})
	if err != nil {
		t.Fatal(err)
	}
	if out.Definition.Roles[0].Name != "Video Mixer" {
		t.Fatalf("Definition: %+v", out.Definition.Roles)
	}
	st, _ := store.GetRoleState(wf.ID)
	if string(st["Video Mixer"]) != `{"x":"@@omp-role-node:Audio Mixer"}` || len(st) != 1 {
		t.Fatalf("Zustand migriert: %v", st)
	}
	// Läuft der Workflow, wird abgelehnt (laufende Instanzen tragen den alten Namen).
	cur, _ := store.Get(wf.ID)
	cur.Status = StatusStarted
	_ = store.Put(cur)
	if _, err := svc.RenameRoles(wf.ID, map[string]string{"Recorder": "Rec"}); !errors.Is(err, ErrNotStopped) {
		t.Fatalf("laufend: %v", err)
	}
	if _, err := svc.RenameRoles("gibt-es-nicht", map[string]string{"a": "b"}); err == nil {
		t.Fatal("unbekannter Workflow")
	}
}
