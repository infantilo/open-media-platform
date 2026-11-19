package files

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func (e *env) secondRoot(t *testing.T, name string) (Root, string) {
	t.Helper()
	dir := t.TempDir()
	lid, err := ensureLocation(context.Background(), e.m.db(), name, dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := SaveRootSettings(context.Background(), e.m.db(), Root{ID: lid, Role: RoleMedia}); err != nil {
		t.Fatal(err)
	}
	r, err := GetRoot(context.Background(), e.m.db(), lid)
	if err != nil {
		t.Fatal(err)
	}
	return r, dir
}

func (e *env) waitTransfer(t *testing.T, id string) Transfer {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		list, err := e.m.ListTransfers(context.Background(), 20)
		if err != nil {
			t.Fatal(err)
		}
		for _, tr := range list {
			if tr.ID == id && tr.Status != TrQueued && tr.Status != TrRunning {
				return tr
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("Übertragung wurde nicht fertig")
	return Transfer{}
}

func write(t *testing.T, p, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestCopyFileAndFolderBetweenRoots(t *testing.T) {
	e := newEnv(t)
	_, _ = e.m.db().Exec("DELETE FROM file_transfers")
	dst, dstDir := e.secondRoot(t, "Ziel")
	big := strings.Repeat("x", 900*1024) // mehr als zwei Blöcke
	write(t, filepath.Join(e.dir, "clip.mxf"), big)
	write(t, filepath.Join(e.dir, "serie/folge1.mxf"), "eins")
	write(t, filepath.Join(e.dir, "serie/sub/folge2.mxf"), "zwei")
	if err := os.MkdirAll(filepath.Join(e.dir, "serie/leer"), 0o755); err != nil {
		t.Fatal(err)
	}
	req := TransferRequest{Mode: ModeCopy, SrcRootID: e.root.ID, Paths: []string{"clip.mxf", "serie"}, DstRootID: dst.ID, DstDir: "eingang"}
	plan, err := e.m.PlanTransfer(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Blocked || plan.Files != 3 || plan.TotalBytes != int64(len(big)+len("eins")+len("zwei")) {
		t.Fatalf("Plan = files %d bytes %d blocked %v: %+v", plan.Files, plan.TotalBytes, plan.Blocked, plan.Items)
	}
	tr, _, err := e.m.ExecTransfer(context.Background(), req, "tester", false)
	if err != nil {
		t.Fatal(err)
	}
	done := e.waitTransfer(t, tr.ID)
	if done.Status != TrDone || done.FilesDone != 3 || done.DoneBytes != plan.TotalBytes {
		t.Fatalf("Übertragung = %+v", done)
	}
	got, _ := os.ReadFile(filepath.Join(dstDir, "eingang/clip.mxf"))
	if string(got) != big {
		t.Fatal("große Datei weicht ab")
	}
	if b, _ := os.ReadFile(filepath.Join(dstDir, "eingang/serie/sub/folge2.mxf")); string(b) != "zwei" {
		t.Fatalf("Unterordner fehlt: %q", b)
	}
	if st, err := os.Stat(filepath.Join(dstDir, "eingang/serie/leer")); err != nil || !st.IsDir() {
		t.Fatal("leerer Ordner wurde nicht angelegt")
	}
	if _, err := os.Stat(filepath.Join(e.dir, "clip.mxf")); err != nil {
		t.Fatal("beim Kopieren muss die Quelle bleiben")
	}
}

func TestConflictPolicies(t *testing.T) {
	e := newEnv(t)
	dst, dstDir := e.secondRoot(t, "Ziel2")
	write(t, filepath.Join(e.dir, "a.mxf"), "neu")
	write(t, filepath.Join(dstDir, "a.mxf"), "alt")
	base := TransferRequest{Mode: ModeCopy, SrcRootID: e.root.ID, Paths: []string{"a.mxf"}, DstRootID: dst.ID}
	plan, _ := e.m.PlanTransfer(context.Background(), base)
	if plan.Conflicts != 1 || plan.Items[0].Status != "conflict" {
		t.Fatalf("Konflikt nicht erkannt: %+v", plan.Items)
	}
	run := func(policy string) Transfer {
		r := base
		r.Conflict = policy
		tr, _, err := e.m.ExecTransfer(context.Background(), r, "t", false)
		if err != nil {
			t.Fatal(err)
		}
		return e.waitTransfer(t, tr.ID)
	}
	if d := run(ConflictSkip); d.FilesSkipped != 1 {
		t.Fatalf("skip: %+v", d)
	}
	if b, _ := os.ReadFile(filepath.Join(dstDir, "a.mxf")); string(b) != "alt" {
		t.Fatal("skip darf das Ziel nicht ändern")
	}
	if d := run(ConflictRename); d.Status != TrDone {
		t.Fatalf("rename: %+v", d)
	}
	if b, _ := os.ReadFile(filepath.Join(dstDir, "a (2).mxf")); string(b) != "neu" {
		t.Fatal("rename muss „a (2).mxf“ anlegen")
	}
	if d := run(ConflictOverwrite); d.Status != TrDone {
		t.Fatalf("overwrite: %+v", d)
	}
	if b, _ := os.ReadFile(filepath.Join(dstDir, "a.mxf")); string(b) != "neu" {
		t.Fatal("overwrite muss das Ziel ersetzen")
	}
	// die überschriebene Fassung liegt im Papierkorb des Ziels
	if ents, _ := os.ReadDir(filepath.Join(dstDir, ".trash")); len(ents) == 0 {
		t.Fatal("überschriebene Datei gehört in den Papierkorb")
	}
}

func TestMoveBetweenRootsTrashesTheSource(t *testing.T) {
	e := newEnv(t)
	dst, dstDir := e.secondRoot(t, "Ziel3")
	write(t, filepath.Join(e.dir, "m.mxf"), "inhalt")
	req := TransferRequest{Mode: ModeMove, SrcRootID: e.root.ID, Paths: []string{"m.mxf"}, DstRootID: dst.ID}
	tr, _, err := e.m.ExecTransfer(context.Background(), req, "t", false)
	if err != nil {
		t.Fatal(err)
	}
	if d := e.waitTransfer(t, tr.ID); d.Status != TrDone {
		t.Fatalf("Verschieben = %+v", d)
	}
	if b, _ := os.ReadFile(filepath.Join(dstDir, "m.mxf")); string(b) != "inhalt" {
		t.Fatal("Ziel fehlt")
	}
	if _, err := os.Stat(filepath.Join(e.dir, "m.mxf")); err == nil {
		t.Fatal("die Quelle muss weg sein")
	}
	if ents, _ := os.ReadDir(filepath.Join(e.dir, ".trash")); len(ents) == 0 {
		t.Fatal("die Quelle gehört in den Papierkorb (wiederherstellbar)")
	}
}

func TestMoveWithinOneRootIsARename(t *testing.T) {
	e := newEnv(t)
	write(t, filepath.Join(e.dir, "x.mxf"), "1")
	req := TransferRequest{Mode: ModeMove, SrcRootID: e.root.ID, Paths: []string{"x.mxf"}, DstRootID: e.root.ID, DstDir: "archiv/2026"}
	plan, _ := e.m.PlanTransfer(context.Background(), req)
	if !plan.Rename {
		t.Fatal("innerhalb eines Ortes ist Verschieben ein Umbenennen")
	}
	tr, _, err := e.m.ExecTransfer(context.Background(), req, "t", false)
	if err != nil {
		t.Fatal(err)
	}
	if d := e.waitTransfer(t, tr.ID); d.Status != TrDone {
		t.Fatalf("Umbenennen = %+v", d)
	}
	if _, err := os.Stat(filepath.Join(e.dir, "archiv/2026/x.mxf")); err != nil {
		t.Fatal("Ziel fehlt")
	}
	if ents, _ := os.ReadDir(filepath.Join(e.dir, ".trash")); len(ents) != 0 {
		t.Fatal("ein Umbenennen legt nichts in den Papierkorb")
	}
}

func TestBlocksFolderIntoItselfAndReadOnlyTarget(t *testing.T) {
	e := newEnv(t)
	write(t, filepath.Join(e.dir, "ordner/a.mxf"), "1")
	p, _ := e.m.PlanTransfer(context.Background(), TransferRequest{Mode: ModeCopy, SrcRootID: e.root.ID, Paths: []string{"ordner"}, DstRootID: e.root.ID, DstDir: "ordner/unter"})
	if !p.Blocked {
		t.Fatalf("Ordner in sich selbst muss blockiert sein: %+v", p.Items)
	}
	ro, _ := e.secondRoot(t, "Nur lesen")
	if err := SaveRootSettings(context.Background(), e.m.db(), Root{ID: ro.ID, Role: RoleMedia, ReadOnly: true}); err != nil {
		t.Fatal(err)
	}
	p, _ = e.m.PlanTransfer(context.Background(), TransferRequest{Mode: ModeCopy, SrcRootID: e.root.ID, Paths: []string{"ordner"}, DstRootID: ro.ID})
	if !p.Blocked {
		t.Fatal("schreibgeschütztes Ziel muss blockiert sein")
	}
}

func TestMoveOfAssetFileIsBlockedCopyIsAllowed(t *testing.T) {
	e := newEnv(t)
	_, _, _ = e.mkAsset(t, "master.mxf")
	dst, _ := e.secondRoot(t, "Ziel4")
	mv, _ := e.m.PlanTransfer(context.Background(), TransferRequest{Mode: ModeMove, SrcRootID: e.root.ID, Paths: []string{"master.mxf"}, DstRootID: dst.ID})
	if !mv.Blocked || !strings.Contains(mv.Items[0].Error, "Asset") {
		t.Fatalf("Verschieben einer Asset-Datei muss blockiert sein: %+v", mv.Items)
	}
	cp, _ := e.m.PlanTransfer(context.Background(), TransferRequest{Mode: ModeCopy, SrcRootID: e.root.ID, Paths: []string{"master.mxf"}, DstRootID: dst.ID})
	if cp.Blocked {
		t.Fatalf("Kopieren einer Asset-Datei ist erlaubt: %+v", cp.Items)
	}
}
