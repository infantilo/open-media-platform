package mcr

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
)

func mustHouse(t *testing.T, s string) *HouseFormat {
	t.Helper()
	h, err := ParseHouse(json.RawMessage(s))
	if err != nil || h == nil {
		t.Fatalf("Hausformat: %v", err)
	}
	return h
}

func TestMaterializeTwoLines(t *testing.T) {
	e := Event{ID: "abcdef1234567890", Name: "A gegen B", State: StateTesting,
		HouseFormat: json.RawMessage(`{"video":{"width":1280,"height":720,"rate":"50/1","scan":"progressive"}}`),
		Lines: []Line{
			{ID: "l1", Name: "PGM", Kind: KindSRT, Transport: json.RawMessage(`{"uri":"srt://:9000","mode":"listener","latencyMs":300,"passphraseKey":"pgm-key"}`),
				Normalize: json.RawMessage(`{"mode":"auto"}`)},
			{ID: "l2", Name: "Kamera 1", Kind: KindMXL, Transport: json.RawMessage(`{"sourceNodeType":"omp-source"}`),
				HouseFormat: json.RawMessage(`{"audio":{"sampleRate":44100,"channels":2}}`)},
			{ID: "l3", Name: "Reserve", Kind: KindMXL}, // ohne Quellrolle
		}}
	g := mustHouse(t, house1080)
	def, roles, envs, err := Materialize(e, g, "/etc/omp/secrets")
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]workflows.Role{}
	for _, r := range def.Roles {
		byName[r.Name] = r
	}
	if byName["pgm-in"].NodeType != NodeContribIn || byName["pgm-norm"].NodeType != NodeNormalizer ||
		byName["kamera-1-in"].NodeType != "omp-source" || byName["reserve-norm"].NodeType != NodeNormalizer {
		t.Fatalf("Rollen: %+v", def.Roles)
	}
	if _, ok := byName["reserve-in"]; ok || roles["l3"].Input != "" {
		t.Fatalf("mxl ohne Quellrolle darf keine Eingangsrolle haben")
	}
	if len(def.Connections) != 4 {
		t.Fatalf("2 Leitungen mit Eingang × (Bild+Ton) = 4 Verbindungen, war %d", len(def.Connections))
	}
	if len(def.Interface.Outputs) != 3 || def.Interface.Outputs[0].Name != "PGM" {
		t.Fatalf("Interface-Ausgänge: %+v", def.Interface)
	}
	// wirksames Hausformat: Event überstimmt Vorgabe (Bild), Leitung überstimmt (Ton)
	var h0, h1 HouseFormat
	_ = json.Unmarshal([]byte(envs["pgm-norm"]["OMP_HOUSE_FORMAT"]), &h0)
	_ = json.Unmarshal([]byte(envs["kamera-1-norm"]["OMP_HOUSE_FORMAT"]), &h1)
	if h0.Video.Width != 1280 || h0.Audio.SampleRate != 48000 || h1.Audio.SampleRate != 44100 || h1.Video.Rate != "50/1" {
		t.Fatalf("wirksames Hausformat: %+v %+v", h0, h1)
	}
	// Geheimnis: nur Dateipfad aus Schlüsselname, nie ein Wert
	if envs["pgm-in"]["OMP_CONTRIB_PASSPHRASE_FILE"] != "/etc/omp/secrets/pgm-key" || envs["pgm-in"]["OMP_CONTRIB_URI"] != "srt://:9000" {
		t.Fatalf("Eingangs-Umgebung: %v", envs["pgm-in"])
	}
	raw, _ := json.Marshal(def)
	if strings.Contains(strings.ToLower(string(raw)), "geheim") {
		t.Fatal("Geheimnis in der Definition")
	}
	if def.Settings.ConfirmStop {
		t.Fatal("ConfirmStop erst ab live")
	}
	e.State = StateLive
	def, _, _, _ = Materialize(e, g, "/s")
	if !def.Settings.ConfirmStop {
		t.Fatal("ConfirmStop ab live")
	}
	// Schlüsselname ohne Verzeichnis → Fehler; Pfad im Schlüssel → Fehler
	if _, _, _, err := Materialize(e, g, ""); err == nil {
		t.Fatal("passphraseKey ohne Verzeichnis muss scheitern")
	}
	e.Lines[0].Transport = json.RawMessage(`{"uri":"srt://:9000","passphraseKey":"../x"}`)
	if _, _, _, err := Materialize(e, g, "/s"); err == nil {
		t.Fatal("Pfad im Schlüssel muss scheitern")
	}
}

func TestNodeParamsOrder(t *testing.T) {
	l := Line{Avsync: json.RawMessage(`{"mode":"manual","manualMs":30,"heldMs":-80,"deadbandMs":10}`)}
	g := mustHouse(t, house1080)
	ps := NodeParams(l, Effective(g, nil, nil))
	names := []string{}
	for _, p := range ps {
		names = append(names, p.Name)
	}
	if names[0] != "normalize.houseFormat" || names[len(names)-1] != "avsync.mode" {
		t.Fatalf("Reihenfolge: %v", names)
	}
}

// ---- gefälschte Dienste ----

type fakeWf struct {
	mu       sync.Mutex
	wfs      map[string]*workflows.Workflow
	n        int
	runs     int
	reshapes int
}

func newFakeWf() *fakeWf { return &fakeWf{wfs: map[string]*workflows.Workflow{}} }

func (f *fakeWf) Create(name string, def workflows.Definition, _ map[string]workflows.RoleRuntime, _ string) (workflows.Workflow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.n++
	id := fmt.Sprintf("wf-%d", f.n)
	w := &workflows.Workflow{ID: id, Name: name, Definition: def, Status: workflows.StatusStopped}
	f.wfs[id] = w
	return *w, nil
}
func (f *fakeWf) Update(id, name string, def workflows.Definition) (workflows.Workflow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w, ok := f.wfs[id]
	if !ok {
		return workflows.Workflow{}, workflows.ErrNotFound
	}
	w.Name, w.Definition = name, def
	return *w, nil
}
func (f *fakeWf) Reshape(_ context.Context, id string, name string, def workflows.Definition) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	w, ok := f.wfs[id]
	if !ok {
		return workflows.ErrNotFound
	}
	if w.Status != workflows.StatusStarted {
		return workflows.ErrNotRunning
	}
	keep := map[string]bool{}
	for _, r := range def.Roles {
		keep[r.Name] = true
		if _, ok := w.Runtime[r.Name]; !ok {
			f.runs++
			w.Runtime[r.Name] = workflows.RoleRuntime{InstanceID: fmt.Sprintf("inst-%s-%d", r.Name, f.runs)}
		}
	}
	for n := range w.Runtime {
		if !keep[n] {
			delete(w.Runtime, n)
		}
	}
	w.Name, w.Definition = name, def
	f.reshapes++
	return nil
}
func (f *fakeWf) Get(id string) (workflows.Workflow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w, ok := f.wfs[id]
	if !ok {
		return workflows.Workflow{}, workflows.ErrNotFound
	}
	return *w, nil
}
func (f *fakeWf) List() ([]workflows.Workflow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []workflows.Workflow
	for _, w := range f.wfs {
		out = append(out, *w)
	}
	return out, nil
}
func (f *fakeWf) Start(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	w := f.wfs[id]
	f.runs++
	w.Status = workflows.StatusStarted
	w.Runtime = map[string]workflows.RoleRuntime{}
	for _, r := range w.Definition.Roles {
		w.Runtime[r.Name] = workflows.RoleRuntime{InstanceID: fmt.Sprintf("inst-%s-%d", r.Name, f.runs)}
	}
	return nil
}
func (f *fakeWf) Stop(_ context.Context, id string, confirm bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	w := f.wfs[id]
	if w.Status != workflows.StatusStarted {
		return workflows.ErrNotRunning
	}
	if w.Definition.Settings.ConfirmStop && !confirm {
		return workflows.ErrConfirmationRequired
	}
	w.Status, w.Runtime = workflows.StatusStopped, nil
	return nil
}
func (f *fakeWf) Delete(id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.wfs, id)
	return nil
}

type fakeNodes struct {
	mu      sync.Mutex
	patches []string // "<instanz> <param>=<wert>"
	states  []string // POST /state: "<url> <json>"
	selects []string // POST /methods/select: "<instanz>/methods/select <json>"
	online  map[string]bool
}

func (n *fakeNodes) BaseURL(inst string) (string, bool) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.online != nil && !n.online[inst] {
		return "", false
	}
	return "http://node/" + inst, true
}
func (n *fakeNodes) Do(_ context.Context, method, url string, body any) ([]byte, int, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	inst := strings.TrimPrefix(strings.SplitN(url, "/params/", 2)[0], "http://node/")
	if method == "POST" && strings.HasSuffix(url, "/methods/select") {
		b, _ := json.Marshal(body)
		n.selects = append(n.selects, strings.TrimPrefix(url, "http://node/")+" "+string(b))
		return []byte(`{}`), 200, nil
	}
	if method == "POST" && strings.HasSuffix(url, "/state") {
		b, _ := json.Marshal(body)
		n.states = append(n.states, url+" "+string(b))
		return []byte(`{}`), 200, nil
	}
	if method == "PATCH" {
		name := strings.SplitN(url, "/params/", 2)[1]
		v := body.(map[string]any)["value"]
		n.patches = append(n.patches, fmt.Sprintf("%s %s=%v", inst, name, v))
		return []byte(`{}`), 200, nil
	}
	return []byte(`{"value":null}`), 200, nil
}
func (n *fakeNodes) applied(inst string) []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	var out []string
	for _, p := range n.patches {
		if strings.HasPrefix(p, inst+" ") {
			out = append(out, strings.TrimPrefix(p, inst+" "))
		}
	}
	return out
}

func TestLifecycleWithRuntimeAndStopStart(t *testing.T) {
	e := newEnv(t)
	wf, nodes := newFakeWf(), &fakeNodes{}
	rt := &Runtime{Wf: wf, Nodes: nodes, Poll: 1, Timeout: 1_000_000_000}
	e.m.svc.Run, e.m.rt = rt, rt
	svc := e.m.svc
	ctx := context.Background()

	_ = svc.SetGlobalHouse(json.RawMessage(house1080))
	ev, err := svc.CreateEvent(ctx, NewEventInput{Name: "Spiel", Lines: []Line{
		{Name: "PGM", Kind: KindMXL, Transport: json.RawMessage(`{"sourceNodeType":"omp-source"}`), Avsync: json.RawMessage(`{"mode":"manual","manualMs":30}`)}}}, "alice")
	if err != nil {
		t.Fatal(err)
	}
	// planned → testing: Workflow angelegt und gestartet
	ev, err = svc.Transition(ctx, ev.ID, StateTesting, "alice", false)
	if err != nil || ev.WorkflowID == "" {
		t.Fatalf("testing: %v %+v", err, ev)
	}
	w, _ := wf.Get(ev.WorkflowID)
	if w.Status != workflows.StatusStarted || len(w.Definition.Roles) != 2 {
		t.Fatalf("Workflow: %+v", w)
	}
	full, _ := svc.St.GetEvent(ctx, ev.ID)
	n, err := rt.Reconcile(ctx, svc, full)
	if err != nil || n != 1 {
		t.Fatalf("Reconcile: %d %v", n, err)
	}
	inst1 := w.Runtime["pgm-norm"].InstanceID
	got := strings.Join(nodes.applied(inst1), "|")
	if !strings.Contains(got, "normalize.houseFormat=") || !strings.Contains(got, "avsync.manualMs=30") || !strings.HasSuffix(got, "avsync.mode=manual") {
		t.Fatalf("Einstellungen an den Node: %s", got)
	}
	// nochmaliger Abgleich ohne Änderung sendet nichts erneut
	before := len(nodes.patches)
	_, _ = rt.Reconcile(ctx, svc, full)
	if len(nodes.patches) != before {
		t.Fatal("unveränderte Instanz darf nicht erneut versorgt werden")
	}
	// HARTE ANFORDERUNG: Stop/Start (neue Instanz) → manueller Offset 30 ms wieder am Node
	_ = wf.Stop(ctx, ev.WorkflowID, true)
	_ = wf.Start(ctx, ev.WorkflowID)
	w, _ = wf.Get(ev.WorkflowID)
	inst2 := w.Runtime["pgm-norm"].InstanceID
	if inst2 == inst1 {
		t.Fatal("Test-Annahme: neue Instanz")
	}
	if _, err := rt.Reconcile(ctx, svc, full); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(nodes.applied(inst2), "|"), "avsync.manualMs=30") {
		t.Fatalf("Offset nach Stop/Start nicht wieder da: %v", nodes.applied(inst2))
	}
	// HARTE ANFORDERUNG: Hausformat des Events im laufenden Workflow ändern → sofort am Node und nach Stop/Start weiter
	if _, err := svc.UpdateEvent(ctx, ev.ID, NewEventInput{Name: "Spiel", HouseFormat: json.RawMessage(`{"video":{"width":1280,"height":720,"rate":"50/1","scan":"progressive"}}`)}, false, "alice"); err != nil {
		t.Fatal(err)
	}
	full, _ = svc.St.GetEvent(ctx, ev.ID)
	_, _ = rt.Reconcile(ctx, svc, full)
	last := ""
	for _, p := range nodes.applied(inst2) {
		if strings.HasPrefix(p, "normalize.houseFormat=") {
			last = p
		}
	}
	if !strings.Contains(last, `"width":1280`) {
		t.Fatalf("neues Hausformat nicht am Node: %s", last)
	}
	// Startumgebung kommt bei jedem Start frisch aus der Datenbank (Hook)
	w, _ = wf.Get(ev.WorkflowID)
	henv := e.m.RoleEnvHook(w.Definition, workflows.Role{Name: "pgm-norm", NodeType: NodeNormalizer})
	if !strings.Contains(henv["OMP_HOUSE_FORMAT"], `"width":1280`) {
		t.Fatalf("Startumgebung trägt das neue Hausformat nicht: %v", henv)
	}
	if e.m.RoleEnvHook(workflows.Definition{Description: "anderer"}, workflows.Role{Name: "pgm-norm"}) != nil {
		t.Fatal("fremde Workflows bekommen nichts")
	}
	_ = wf.Stop(ctx, ev.WorkflowID, true)
	_ = wf.Start(ctx, ev.WorkflowID)
	w, _ = wf.Get(ev.WorkflowID)
	inst3 := w.Runtime["pgm-norm"].InstanceID
	_, _ = rt.Reconcile(ctx, svc, full)
	hf := ""
	for _, p := range nodes.applied(inst3) {
		if strings.HasPrefix(p, "normalize.houseFormat=") {
			hf = p
		}
	}
	if !strings.Contains(hf, `"width":1280`) {
		t.Fatalf("neues Hausformat nach Stop/Start weg: %s", hf)
	}
	// testing → live: Stoppbestätigung; live → teardown ohne Bestätigung → ErrConfirm
	if ev, err = svc.Transition(ctx, ev.ID, StateLive, "alice", false); err != nil {
		t.Fatal(err)
	}
	w, _ = wf.Get(ev.WorkflowID)
	if !w.Definition.Settings.ConfirmStop {
		t.Fatal("ConfirmStop ab live")
	}
	if _, err := svc.Transition(ctx, ev.ID, StateTeardown, "alice", false); err != ErrConfirm {
		t.Fatalf("ohne Bestätigung muss ErrConfirm kommen: %v", err)
	}
	cur, _ := svc.St.GetEvent(ctx, ev.ID)
	if cur.State != StateLive {
		t.Fatalf("Zustand darf sich nicht ändern: %s", cur.State)
	}
	if _, err := svc.Transition(ctx, ev.ID, StateTeardown, "alice", true); err != nil {
		t.Fatal(err)
	}
	w, _ = wf.Get(ev.WorkflowID)
	if w.Status != workflows.StatusStopped {
		t.Fatalf("teardown stoppt: %s", w.Status)
	}
	// done: Ressourcen frei (Workflow gelöscht)
	if ev, err = svc.Transition(ctx, ev.ID, StateDone, "alice", false); err != nil {
		t.Fatal(err)
	}
	if _, err := wf.Get(cur.WorkflowID); err == nil || ev.WorkflowID != "" {
		t.Fatalf("done muss den Workflow löschen: %v %q", err, ev.WorkflowID)
	}
}

func TestPlannedToTestingFailureKeepsState(t *testing.T) {
	e := newEnv(t)
	e.m.svc.Run = &Runtime{Wf: newFakeWf(), Nodes: &fakeNodes{}, Poll: 1, Timeout: 1_000_000}
	ctx := context.Background()
	// Event ohne Leitungen: nichts zu starten → Fehler, Zustand bleibt planned
	ev, _ := e.m.svc.CreateEvent(ctx, NewEventInput{Name: "leer"}, "alice")
	if _, err := e.m.svc.Transition(ctx, ev.ID, StateTesting, "alice", false); err == nil {
		t.Fatal("Event ohne Leitungen darf nicht starten")
	}
	cur, _ := e.m.svc.St.GetEvent(ctx, ev.ID)
	if cur.State != StatePlanned {
		t.Fatalf("Zustand: %s", cur.State)
	}
}

type fakeLinker struct{ calls []string }

func (f *fakeLinker) Link(_ context.Context, src Existing, inst, _ string) error {
	f.calls = append(f.calls, src.NodeID+"->"+inst)
	return nil
}

func TestExistingSourceHasNoInputRoleAndIsLinkedOnce(t *testing.T) {
	e := Event{ID: "ev1", Name: "Test", Lines: []Line{
		{ID: "l1", Name: "SRT dediziert", Kind: KindSRT, Transport: json.RawMessage(`{"existing":{"nodeId":"n-1","nodeLabel":"SRT Eingang"}}`)},
		{ID: "l2", Name: "Neu", Kind: KindSRT, Transport: json.RawMessage(`{"uri":"srt://:9000"}`)},
	}}
	def, roles, _, err := Materialize(e, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if roles["l1"].Input != "" {
		t.Fatalf("vorhandene Quelle darf keinen Eingang starten: %+v", roles["l1"])
	}
	if roles["l2"].Input == "" {
		t.Fatal("Leitung ohne vorhandene Quelle braucht ihren Eingang")
	}
	if len(def.Connections) != 2 {
		t.Fatalf("nur die zweite Leitung hat Eingang→Normalizer-Verbindungen, bekam %d", len(def.Connections))
	}
	lk := &fakeLinker{}
	rt := &Runtime{Sources: lk}
	wf := workflows.Workflow{Status: workflows.StatusStarted, Runtime: map[string]workflows.RoleRuntime{roles["l1"].Normalizer: {InstanceID: "inst-a"}}}
	for i := 0; i < 3; i++ {
		if err := rt.reconcileSources(context.Background(), e, wf, roles); err != nil {
			t.Fatal(err)
		}
	}
	if len(lk.calls) != 1 || lk.calls[0] != "n-1->inst-a" {
		t.Fatalf("einmal verbinden, bekam %v", lk.calls)
	}
	wf.Runtime[roles["l1"].Normalizer] = workflows.RoleRuntime{InstanceID: "inst-b"} // Neustart
	_ = rt.reconcileSources(context.Background(), e, wf, roles)
	if len(lk.calls) != 2 {
		t.Fatalf("nach Neustart erneut verbinden, bekam %v", lk.calls)
	}
}

func TestAudioTracksBuildMapAndSameSourceTwoLines(t *testing.T) {
	src := `"nodeId":"n-1","videoSenderId":"v1","audioSenderId":"a1"`
	l1 := Line{ID: "l1", Name: "PGM", Kind: KindMXL, Transport: json.RawMessage(`{"existing":{` + src + `,"audioTracks":[{"label":"Deutsch","channels":[1,2]},{"label":"Kommentar","channels":[5]}]}}`)}
	l2 := Line{ID: "l2", Name: "Englisch", Kind: KindMXL, Transport: json.RawMessage(`{"existing":{` + src + `,"audioTracks":[{"label":"English","channels":[3,4]}]}}`)}
	l3 := Line{ID: "l3", Name: "Alles", Kind: KindMXL, Transport: json.RawMessage(`{"existing":{` + src + `}}`)}
	if got := string(TrackAudioMap(l1)); got != `{"outputs":[{"out":1,"in":1},{"out":2,"in":2},{"out":3,"in":5}]}` {
		t.Fatalf("l1: %s", got)
	}
	if got := string(TrackAudioMap(l2)); got != `{"outputs":[{"out":1,"in":3},{"out":2,"in":4}]}` {
		t.Fatalf("l2: %s", got)
	}
	if TrackAudioMap(l3) != nil {
		t.Fatal("ohne Tonspuren keine Zuordnung (alle Kanäle unverändert)")
	}
	_, _, envs, err := Materialize(Event{ID: "e", Name: "X", Lines: []Line{l1, l2, l3}}, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if envs["pgm-norm"]["OMP_AUDIO_MAP"] == "" || envs["englisch-norm"]["OMP_AUDIO_MAP"] == "" || envs["alles-norm"]["OMP_AUDIO_MAP"] != "" {
		t.Fatalf("env: %v", envs)
	}
	found := false
	for _, p := range NodeParams(l2, HouseFormat{}) {
		if p.Name == "normalize.audioMap" {
			found = true
		}
	}
	if !found {
		t.Fatal("audioMap muss auch als Parameter gehen (Stop/Start-fest)")
	}
	bad := Line{Name: "B", Kind: KindMXL, Transport: json.RawMessage(`{"existing":{"nodeId":"n","audioTracks":[{"channels":[]}]}}`)}
	if validateLine(&bad) == nil {
		t.Fatal("leere Tonspur muss abgelehnt werden")
	}
	bad2 := Line{Name: "B", Kind: KindMXL, Transport: json.RawMessage(`{"existing":{"nodeId":"n","audioTracks":[{"channels":[0]}]}}`)}
	if validateLine(&bad2) == nil {
		t.Fatal("Kanal 0 muss abgelehnt werden")
	}
}

func TestSourceNamesUseEventAndLineNames(t *testing.T) {
	e := Event{ID: "e1", Name: "Fussball Admira", Lines: []Line{{ID: "a", Name: "PGM"}, {ID: "b", Name: "PGM"}}}
	got := SourceNames(e)
	if got["pgm-norm"] != "MCR/Fussball Admira/PGM" || got["pgm-2-norm"] != "MCR/Fussball Admira/PGM" {
		t.Fatalf("%v", got)
	}
	_, roles, _, _ := Materialize(Event{ID: "e1", Name: "Fussball Admira", Lines: []Line{{ID: "a", Name: "PGM", Kind: KindMXL}, {ID: "b", Name: "PGM", Kind: KindMXL}}}, nil, "")
	for _, lr := range roles {
		if _, ok := got[lr.Normalizer]; !ok {
			t.Fatalf("Rolle %s nicht benannt: %v", lr.Normalizer, got)
		}
	}
}

func TestExistingSourceMixedNodes(t *testing.T) {
	l := Line{Name: "Mix", Transport: json.RawMessage(`{"existing":{"videoNodeId":"v","audioNodeId":"a","audioTracks":[{"channels":[3,4]}],"dataNodeId":"d"}}`)}
	ex := ExistingSourceOf(l)
	if ex == nil || ex.VideoNodeID != "v" || ex.AudioNodeID != "a" || ex.DataNodeID != "d" {
		t.Fatalf("getrennte Quellen nicht gelesen: %+v", ex)
	}
	if ex.Signature() == (Existing{NodeID: "v"}).Signature() {
		t.Fatal("Signatur muss die getrennten Nodes enthalten")
	}
	if err := validateTracks(l); err != nil {
		t.Fatal(err)
	}
	if TrackAudioMap(l) == nil {
		t.Fatal("Tonspuren müssen auch bei getrennten Quellen gelten")
	}
}
