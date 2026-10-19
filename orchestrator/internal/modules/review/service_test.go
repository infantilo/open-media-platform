package review

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/asset"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

type testEnv struct {
	svc  *Service
	dir  string
	cfg  *Config
	file string
}

type auditSink struct{ n atomic.Int64 }

func (a *auditSink) Log(actor, objectType, objectID, action string, details map[string]any) {
	a.n.Add(1)
}

func newEnv(t *testing.T, mut func(*Config)) *testEnv {
	t.Helper()
	db := dbtest.Open(t)
	reg := module.NewRegistry()
	if err := reg.Register(&Module{}); err != nil {
		t.Fatal(err)
	}
	if err := reg.Migrate(context.Background(), db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	dir := t.TempDir()
	cfg := DefaultConfig()
	cfg.ImportDir = dir
	cfg.AutoQC = true
	if mut != nil {
		mut(&cfg)
	}
	if err := cfg.Normalize(); err != nil {
		t.Fatal(err)
	}
	tools := needFFmpeg(t)
	e := &testEnv{dir: dir, cfg: &cfg}
	e.svc = &Service{St: NewStore(db), Assets: asset.NewStore(db), Tools: tools, Cfg: func() Config { return *e.cfg }, DataDir: filepath.Join(dir, ".data"), Audit: &auditSink{}}
	// kleine Datei: 8 s, 25 fps, Timecode 10:00:00:00
	e.file = makeFixture(t, "in.mxf", "null", "anull")
	data, _ := os.ReadFile(e.file)
	name := strings.ReplaceAll(t.Name(), "/", "_") + ".mxf"
	if err := os.WriteFile(filepath.Join(dir, name), data, 0o644); err != nil {
		t.Fatal(err)
	}
	e.file = name
	t.Cleanup(func() { e.drain(t) }) // keine wartenden Aufträge für Folgetests zurücklassen
	return e
}

func (e *testEnv) drain(t *testing.T) {
	t.Helper()
	for i := 0; i < 20; i++ {
		ran, err := e.svc.RunNextQC(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if !ran {
			return
		}
	}
}

func (e *testEnv) importReady(t *testing.T) Item {
	t.Helper()
	it, err := e.svc.ImportFile(context.Background(), e.file, "", "importer")
	if err != nil {
		t.Fatal(err)
	}
	e.drain(t)
	got, err := e.svc.St.GetItem(context.Background(), it.AssetID)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestLifecycleEndToEnd(t *testing.T) {
	e := newEnv(t, func(c *Config) {
		c.QCProfiles["broadcast-default"] = noLoudness(c.QCProfiles["broadcast-default"])
		c.MetadataFields = append(c.MetadataFields, MetaField{ID: "scene", Label: "Szene", Type: "select", Values: []string{"Studio", "Außen"}, Segment: true})
	})
	ctx := context.Background()
	it := e.importReady(t)
	if it.State != StateAwaitingReview || it.QCStatus == "" || it.QCReportID == "" || it.Timeline == nil || it.Timeline.DurationFrames != 200 {
		t.Fatalf("after QC: %+v", it)
	}
	// Bericht ist persistent und enthält Befunde mit Herkunft
	rep, err := e.svc.St.GetReport(ctx, it.QCReportID, true)
	if err != nil || len(rep.Findings) < 10 || rep.Ruleset != "broadcast-default@1" || rep.Tools["ffmpeg"] == "" {
		t.Fatalf("report: %v %+v", err, rep)
	}

	// Claim: genau einer
	a, err := e.svc.Claim(ctx, it.AssetID, "alice")
	if err != nil || a.State != StateInReview || a.Assignee != "alice" {
		t.Fatalf("claim: %v %+v", err, a)
	}
	if _, err := e.svc.Claim(ctx, it.AssetID, "bob"); !errors.Is(err, ErrClaimed) {
		t.Fatalf("second claim = %v, want ErrClaimed", err)
	}
	if again, err := e.svc.Claim(ctx, it.AssetID, "alice"); err != nil || again.Revision != a.Revision {
		t.Fatalf("own re-claim must be idempotent: %v", err)
	}

	// Conform speichern (Entwurf) — Out exklusiv: [0,200) ist die ganze Datei
	in := SaveConformInput{ExpectedRevision: a.Revision, Segments: []SegmentInput{
		{Label: "Teaser", In: 0, Out: 50, Metadata: map[string]any{"scene": "Studio"}},
		{Label: "Hauptteil", In: 50, Out: 200},
	}, AssetMetadata: map[string]any{"title": "Testsendung", "keywords": []any{"a", "b"}}}
	saved, c, err := e.svc.SaveConform(ctx, it.AssetID, "alice", in)
	if err != nil || saved.State != StateConforming || c.State != ConformDraft || len(c.Segments) != 2 || c.Segments[1].Out != 200 {
		t.Fatalf("save: %v %+v %+v", err, saved, c)
	}
	firstID := c.Segments[0].ID
	// Stabile Segment-IDs über erneutes Speichern
	in.ExpectedRevision = saved.Revision
	in.Segments[0].ID = firstID
	in.Segments[0].Label = "Teaser (neu)"
	saved2, c2, err := e.svc.SaveConform(ctx, it.AssetID, "alice", in)
	if err != nil || c2.Segments[0].ID != firstID || c2.Segments[0].Label != "Teaser (neu)" {
		t.Fatalf("resave: %v %+v", err, c2)
	}
	// Veraltete Revision → Konflikt, nichts überschrieben
	stale := in
	stale.ExpectedRevision = saved.Revision
	stale.Segments = []SegmentInput{{Label: "x", In: 0, Out: 10}}
	if _, _, err := e.svc.SaveConform(ctx, it.AssetID, "alice", stale); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale save = %v, want ErrConflict", err)
	}
	if w, _ := e.svc.St.WorkingConform(ctx, it.AssetID); len(w.Segments) != 2 {
		t.Fatal("stale save must not overwrite")
	}
	// Fremder darf nicht speichern
	in.ExpectedRevision = saved2.Revision
	if _, _, err := e.svc.SaveConform(ctx, it.AssetID, "mallory", in); !errors.Is(err, ErrForbidden) {
		t.Fatalf("foreign save = %v", err)
	}
	// Einreichen → Freigabe
	sub, err := e.svc.Submit(ctx, it.AssetID, "alice", saved2.Revision)
	if err != nil || sub.State != StateReadyForApproval {
		t.Fatalf("submit: %v %+v", err, sub)
	}
	if _, _, err := e.svc.SaveConform(ctx, it.AssetID, "alice", in); !errors.Is(err, ErrState) && !errors.Is(err, ErrConflict) {
		t.Fatalf("edit after submit must fail, got %v", err)
	}
	done, err := e.svc.Decide(ctx, it.AssetID, "bob", true, "ok", sub.Revision)
	if err != nil || done.State != StateApproved || done.Assignee != "" {
		t.Fatalf("approve: %v %+v", err, done)
	}
	// Metadaten stehen nach der Freigabe im Asset (redaktionell), Quelle unverändert
	a2, _ := e.svc.Assets.GetAsset(it.AssetID)
	if a2.Metadata.Editorial["title"] != "Testsendung" || a2.Metadata.Editorial["conformRevision"] == nil {
		t.Fatalf("editorial = %+v", a2.Metadata.Editorial)
	}
	// Verlauf vollständig
	h, _ := e.svc.St.History(ctx, it.AssetID, 100)
	var acts []string
	for _, x := range h {
		acts = append(acts, x.Action)
	}
	for _, want := range []string{"registered", "qc_requested", "qc_started", "qc_done", "claimed", "conform_saved", "submitted", "approved"} {
		if !contains(acts, want) {
			t.Errorf("history lacks %q: %v", want, acts)
		}
	}
	// Neue Revision starten: Kopie des Freigegebenen
	rev, err := e.svc.Revise(ctx, it.AssetID, "carol", done.Revision)
	if err != nil || rev.State != StateInReview || rev.Assignee != "carol" {
		t.Fatalf("revise: %v %+v", err, rev)
	}
	w, _ := e.svc.St.WorkingConform(ctx, it.AssetID)
	if w.State != ConformDraft || w.Revision != 2 || len(w.Segments) != 2 {
		t.Fatalf("revision 2 draft: %+v", w)
	}
	list, _ := e.svc.St.ListConforms(ctx, it.AssetID)
	if len(list) != 2 {
		t.Fatalf("conforms = %d", len(list))
	}
}

func noLoudness(p QCProfile) QCProfile { p.Loudness.Enabled = false; return p }

func TestConcurrentClaimsExactlyOneWins(t *testing.T) {
	e := newEnv(t, nil)
	it := e.importReady(t)
	var wins, losses atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			_, err := e.svc.Claim(context.Background(), it.AssetID, "op"+string(rune('a'+n)))
			switch {
			case err == nil:
				wins.Add(1)
			case errors.Is(err, ErrClaimed):
				losses.Add(1)
			default:
				t.Errorf("unexpected: %v", err)
			}
		}(i)
	}
	wg.Wait()
	if wins.Load() != 1 || losses.Load() != 11 {
		t.Fatalf("wins=%d losses=%d", wins.Load(), losses.Load())
	}
}

func TestValidationRangesPolicyAndRequiredMetadata(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.AllowOverlap = false; c.AllowGaps = false; c.MinSegmentFrames = 5 })
	ctx := context.Background()
	it := e.importReady(t)
	cl, _ := e.svc.Claim(ctx, it.AssetID, "alice")
	bad := func(segs []SegmentInput, want string) {
		t.Helper()
		_, _, err := e.svc.SaveConform(ctx, it.AssetID, "alice", SaveConformInput{ExpectedRevision: cl.Revision, Segments: segs})
		var ve *ValidationError
		if !errors.As(err, &ve) || !strings.Contains(strings.Join(ve.Problems, "|"), want) {
			t.Fatalf("segments %v: err=%v, want problem containing %q", segs, err, want)
		}
	}
	bad([]SegmentInput{{In: 0, Out: 201}}, "hinter dem Dateiende")
	bad([]SegmentInput{{In: -1, Out: 10}}, "vor dem Dateianfang")
	bad([]SegmentInput{{In: 10, Out: 12}}, "kürzer")
	bad([]SegmentInput{{In: 0, Out: 60}, {In: 50, Out: 100}}, "überlappen")
	bad([]SegmentInput{{In: 0, Out: 50}, {In: 60, Out: 100}}, "Lücke")
	bad([]SegmentInput{{In: 0, Out: 50, Metadata: map[string]any{"nope": 1}}}, "unbekanntes Feld")
	// gültig, aber Einreichen verlangt Pflichtfeld „Titel“
	s1, _, err := e.svc.SaveConform(ctx, it.AssetID, "alice", SaveConformInput{ExpectedRevision: cl.Revision, Segments: []SegmentInput{{In: 0, Out: 100}, {In: 100, Out: 200}}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = e.svc.Submit(ctx, it.AssetID, "alice", s1.Revision)
	var ve *ValidationError
	if !errors.As(err, &ve) || !strings.Contains(strings.Join(ve.Problems, "|"), "Titel") {
		t.Fatalf("submit without title: %v", err)
	}
	// Auswahlfeld mit nicht erlaubtem Wert
	_, _, err = e.svc.SaveConform(ctx, it.AssetID, "alice", SaveConformInput{ExpectedRevision: s1.Revision, Segments: []SegmentInput{{In: 0, Out: 200}}, AssetMetadata: map[string]any{"category": "Quatsch"}})
	if !errors.As(err, &ve) {
		t.Fatalf("bad select value must be rejected: %v", err)
	}
}

func TestQCExecutionFailureIsNotAQCFailure(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.AllowReviewAfterQCExecFail = false })
	ctx := context.Background()
	good := e.svc.Tools
	e.svc.Tools = &Tools{FFmpeg: "/nonexistent/ffmpeg", FFprobe: "/nonexistent/ffprobe", R: newOSRunner()}
	it, err := e.svc.ImportFile(ctx, e.file, "", "importer")
	if err != nil {
		t.Fatal(err)
	}
	e.drain(t)
	got, _ := e.svc.St.GetItem(ctx, it.AssetID)
	if got.State != StateQCFailedToRun || got.QCStatus != "" || got.QCReportID != "" {
		t.Fatalf("exec failure must not produce a verdict: %+v", got)
	}
	jobs, _ := e.svc.St.ListJobs(ctx, it.AssetID, 5)
	if len(jobs) != 1 || jobs[0].State != JobExecFail || jobs[0].Error == "" {
		t.Fatalf("job: %+v", jobs)
	}
	// Richtlinie: Review nach nicht ausführbarer QC gesperrt
	if _, err := e.svc.Claim(ctx, it.AssetID, "alice"); !errors.Is(err, ErrState) {
		t.Fatalf("claim = %v, want ErrState by policy", err)
	}
	e.cfg.AllowReviewAfterQCExecFail = true
	// QC wiederholen mit funktionierendem Werkzeug → Zustand + Bericht
	e.svc.Tools = good
	if _, _, err := e.svc.RequestQC(ctx, it.AssetID, "alice", "", false); err != nil {
		t.Fatal(err)
	}
	e.drain(t)
	got, _ = e.svc.St.GetItem(ctx, it.AssetID)
	if got.State != StateAwaitingReview || got.QCReportID == "" {
		t.Fatalf("after retry: %+v", got)
	}
}

func TestQCFindingsAreNotExecutionFailures(t *testing.T) {
	e := newEnv(t, nil)
	ctx := context.Background()
	// Datei mit Mängeln (Standard-Lautheitsprofil schlägt bei den Sinus-Spuren an)
	it := e.importReady(t)
	if it.State != StateAwaitingReview {
		t.Fatalf("state = %s", it.State)
	}
	if it.QCStatus != OverallFail && it.QCStatus != OverallWarning && it.QCStatus != OverallIncomplete {
		t.Fatalf("expected findings in the verdict, got %q", it.QCStatus)
	}
	jobs, _ := e.svc.St.ListJobs(ctx, it.AssetID, 5)
	if jobs[0].State != JobDone {
		t.Fatalf("job state = %s (QC found issues but ran fine)", jobs[0].State)
	}
}

func TestQCRerunPreservesHistoryAndIsIdempotent(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.QCProfiles["broadcast-default"] = noLoudness(c.QCProfiles["broadcast-default"]) })
	ctx := context.Background()
	it := e.importReady(t)
	first := it.QCReportID
	j1, created1, err := e.svc.RequestQC(ctx, it.AssetID, "alice", "", false)
	if err != nil || !created1 {
		t.Fatal(err)
	}
	j2, created2, _ := e.svc.RequestQC(ctx, it.AssetID, "alice", "", false)
	if created2 || j2.ID != j1.ID {
		t.Fatal("a second request while one is active must reuse the active job")
	}
	e.drain(t)
	reps, _ := e.svc.St.ListReports(ctx, it.AssetID)
	if len(reps) != 2 {
		t.Fatalf("reports = %d, want 2 (history preserved)", len(reps))
	}
	if r, _ := e.svc.St.GetReport(ctx, first, false); r.ID != first {
		t.Fatal("old report must still exist")
	}
}

func TestSourceChangeRequiresAcknowledgement(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.QCProfiles["broadcast-default"] = noLoudness(c.QCProfiles["broadcast-default"]) })
	ctx := context.Background()
	it := e.importReady(t)
	cl, _ := e.svc.Claim(ctx, it.AssetID, "alice")
	s1, _, err := e.svc.SaveConform(ctx, it.AssetID, "alice", SaveConformInput{ExpectedRevision: cl.Revision, Segments: []SegmentInput{{In: 0, Out: 100}}})
	if err != nil {
		t.Fatal(err)
	}
	// Datei „ändert“ sich (mtime) → neuer Fingerprint
	p := filepath.Join(e.dir, e.file)
	future := time.Now().Add(time.Hour)
	_ = os.Chtimes(p, future, future)
	if _, _, err := e.svc.RequestQC(ctx, it.AssetID, "alice", "", false); err != nil {
		t.Fatal(err)
	}
	cur, _ := e.svc.St.GetItem(ctx, it.AssetID)
	if cur.SourceRev == it.SourceRev {
		t.Fatal("source revision must change")
	}
	_, _, err = e.svc.SaveConform(ctx, it.AssetID, "alice", SaveConformInput{ExpectedRevision: cur.Revision, Segments: []SegmentInput{{In: 0, Out: 100}}})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("save on changed source = %v, want ErrConflict", err)
	}
	_ = s1
	if _, _, err := e.svc.SaveConform(ctx, it.AssetID, "alice", SaveConformInput{ExpectedRevision: cur.Revision, Segments: []SegmentInput{{In: 0, Out: 100}}, AckSourceChange: true}); err != nil {
		t.Fatalf("acknowledged save: %v", err)
	}
}

func TestDualApprovalForbidsSelfApproval(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.ApprovalMode = "dual"; c.AllowSelfApproval = false })
	ctx := context.Background()
	it := e.importReady(t)
	cl, _ := e.svc.Claim(ctx, it.AssetID, "alice")
	s, _, err := e.svc.SaveConform(ctx, it.AssetID, "alice", SaveConformInput{ExpectedRevision: cl.Revision, Segments: []SegmentInput{{In: 0, Out: 200}}, AssetMetadata: map[string]any{"title": "T"}})
	if err != nil {
		t.Fatal(err)
	}
	sub, err := e.svc.Submit(ctx, it.AssetID, "alice", s.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Decide(ctx, it.AssetID, "alice", true, "", sub.Revision); !errors.Is(err, ErrForbidden) {
		t.Fatalf("self approval = %v, want ErrForbidden", err)
	}
	// Ablehnen verlangt Begründung; danach neu bearbeitbar
	if _, err := e.svc.Decide(ctx, it.AssetID, "bob", false, " ", sub.Revision); !errors.Is(err, ErrValidation) {
		t.Fatalf("reject without reason = %v", err)
	}
	rej, err := e.svc.Decide(ctx, it.AssetID, "bob", false, "Ton fehlt", sub.Revision)
	if err != nil || rej.State != StateRejected {
		t.Fatalf("reject: %v %+v", err, rej)
	}
	if _, err := e.svc.Claim(ctx, it.AssetID, "carol"); err != nil {
		t.Fatalf("rejected item must be claimable: %v", err)
	}
}

func TestApprovalModeNoneApprovesOnSubmit(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.ApprovalMode = "none" })
	ctx := context.Background()
	it := e.importReady(t)
	cl, _ := e.svc.Claim(ctx, it.AssetID, "alice")
	s, _, _ := e.svc.SaveConform(ctx, it.AssetID, "alice", SaveConformInput{ExpectedRevision: cl.Revision, Segments: []SegmentInput{{In: 0, Out: 200}}, AssetMetadata: map[string]any{"title": "T"}})
	sub, err := e.svc.Submit(ctx, it.AssetID, "alice", s.Revision)
	if err != nil || sub.State != StateApproved {
		t.Fatalf("%v %+v", err, sub)
	}
}

func TestReleaseReassignAndStaleJobRequeue(t *testing.T) {
	e := newEnv(t, nil)
	ctx := context.Background()
	it := e.importReady(t)
	cl, _ := e.svc.Claim(ctx, it.AssetID, "alice")
	if _, err := e.svc.Release(ctx, it.AssetID, "bob", false, cl.Revision); !errors.Is(err, ErrForbidden) {
		t.Fatalf("foreign release = %v", err)
	}
	r, err := e.svc.Reassign(ctx, it.AssetID, "lead", "bob", cl.Revision)
	if err != nil || r.Assignee != "bob" {
		t.Fatalf("reassign: %v %+v", err, r)
	}
	if _, err := e.svc.Release(ctx, it.AssetID, "alice", false, r.Revision); !errors.Is(err, ErrForbidden) {
		t.Fatalf("former assignee must not release after reassign: %v", err)
	}
	rel, err := e.svc.Release(ctx, it.AssetID, "bob", false, r.Revision)
	if err != nil || rel.State != StateAwaitingReview || rel.Assignee != "" {
		t.Fatalf("release: %v %+v", err, rel)
	}
	// verwaister QC-Auftrag
	j, _, _ := e.svc.RequestQC(ctx, it.AssetID, "x", "", false)
	if _, err := e.svc.St.ClaimJob(ctx); err != nil {
		t.Fatal(err)
	}
	_, _ = e.svc.St.db.ExecContext(ctx, `UPDATE qc_jobs SET heartbeat_at = now() - interval '10 minutes' WHERE id=$1`, j.ID)
	re, err := e.svc.St.RequeueStale(ctx, time.Minute, 3)
	if err != nil || len(re) != 1 || re[0].State != JobQueued {
		t.Fatalf("requeue: %v %+v", err, re)
	}
	e.drain(t)
}

func TestImportRejectsPathEscape(t *testing.T) {
	e := newEnv(t, nil)
	for _, p := range []string{"../etc/passwd", "/etc/passwd", "nope.mxf", "sub/../../x.mxf"} {
		if _, err := e.svc.ImportFile(context.Background(), p, "", "x"); !errors.Is(err, ErrValidation) {
			t.Errorf("import %q = %v, want ErrValidation", p, err)
		}
	}
}

func TestScanNewRegistersAssetsOnce(t *testing.T) {
	e := newEnv(t, nil)
	ctx := context.Background()
	// Asset ohne Review-Eintrag, wie es ein Ingest hinterlässt
	a, _ := e.svc.Assets.CreateAsset("video", "Eingang", "", "ingest", "")
	v, _ := e.svc.Assets.CreateVersion(a.ID, "", "x", "ingest")
	size := int64(1)
	_, _ = e.svc.Assets.CreateRepresentation(asset.Representation{AssetVersionID: v.ID, Type: "source", Storage: asset.StorageLocation{Provider: "filesystem", URI: filepath.Join(e.dir, e.file)}, SizeBytes: &size})
	_, _ = e.svc.Assets.PublishVersion(v.ID)
	n, err := e.svc.ScanNew(ctx)
	if err != nil || n < 1 {
		t.Fatalf("scan: %d %v", n, err)
	}
	if _, err := e.svc.St.GetItem(ctx, a.ID); err != nil {
		t.Fatal("asset must be in the work list")
	}
	n2, _ := e.svc.ScanNew(ctx)
	if n2 != 0 {
		t.Fatalf("second scan registered %d again", n2)
	}
	jobs, _ := e.svc.St.ListJobs(ctx, a.ID, 5)
	if len(jobs) != 1 {
		t.Fatalf("exactly one QC job expected, got %d", len(jobs))
	}
	e.drain(t)
}
