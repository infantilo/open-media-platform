package review

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

type api struct {
	svc      *Service
	m        *Module
	settings module.NodeSettings
	access   module.Access // Funktionsrechte/Gruppen (nil in Tests: alles erlaubt)
}

// actorOf: angemeldeter Nutzer; ohne eingerichtete Benutzerverwaltung (Bootstrap-Modus) „local“, damit Übernehmen/Speichern
// auch in der Entwicklungsumgebung funktionieren. Mit Benutzerverwaltung ist der Name immer gesetzt.
func actorOf(r *http.Request) string {
	if u := module.Actor(r); u != "" {
		return u
	}
	return "local"
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// writeErr bildet Fehler auf HTTP ab. Interne Fehler werden geloggt, aber nicht im Detail an den Client gegeben.
func (a *api) writeErr(w http.ResponseWriter, err error, current *Item) {
	body := map[string]any{"error": err.Error()}
	code := http.StatusInternalServerError
	var ve *ValidationError
	switch {
	case errors.Is(err, ErrNotFound):
		code = http.StatusNotFound
	case errors.Is(err, ErrConflict):
		code, body["code"] = http.StatusConflict, "revision_conflict"
		if current != nil {
			body["current"] = current
		}
	case errors.Is(err, ErrClaimed):
		code, body["code"] = http.StatusConflict, "claimed"
	case errors.Is(err, ErrState):
		code, body["code"] = http.StatusConflict, "invalid_state"
	case errors.Is(err, ErrForbidden):
		code = http.StatusForbidden
	case errors.As(err, &ve):
		code, body["problems"] = http.StatusBadRequest, ve.Problems
	case errors.Is(err, ErrValidation):
		code = http.StatusBadRequest
	default:
		slog.Error("review: interner Fehler", "error", err)
		body["error"] = "interner Fehler"
	}
	writeJSON(w, code, body)
}

func readBody(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil && err != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "ungültiges JSON"})
		return false
	}
	return true
}

func (a *api) listItems() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		f := ListFilter{Query: q.Get("q")}
		if s := q.Get("state"); s != "" {
			f.States = strings.Split(s, ",")
		}
		switch q.Get("assignee") {
		case "me":
			f.Assignee = actorOf(r)
		case "free":
			f.Free = true
		case "mine": // alles, was mir (oder meiner Gruppe) zugewiesen ist oder was ich bearbeite
			who := a.identity(r)
			f.Scope = &Scope{User: who.User, Groups: who.Groups}
		}
		if n, err := strconv.Atoi(q.Get("limit")); err == nil {
			f.Limit = n
		}
		if f.Scope == nil {
			f.Scope = a.scopeFor(r)
		}
		items, err := a.svc.St.ListItems(r.Context(), f)
		if err != nil {
			a.writeErr(w, err, nil)
			return
		}
		if items == nil {
			items = []Item{}
		}
		writeJSON(w, 200, map[string]any{"items": items})
	}
}

func (a *api) getItem() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		id := r.PathValue("id")
		it, err := a.svc.St.GetItem(ctx, id)
		if err != nil {
			a.writeErr(w, err, nil)
			return
		}
		if !a.visible(r, it) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "Die Datei ist Ihnen nicht zugewiesen (Recht „Alle Dateien sehen“ fehlt)"})
			return
		}
		jobs, _ := a.svc.St.ListJobs(ctx, id, 1)
		var job *Job
		if len(jobs) > 0 {
			job = &jobs[0]
		}
		var rep *Report
		if it.QCReportID != "" {
			if x, err := a.svc.St.GetReport(ctx, it.QCReportID, false); err == nil {
				rep = &x
			}
		}
		px, _ := a.svc.CurrentProxy(ctx, id)
		cf, _ := a.svc.St.WorkingConform(ctx, id)
		writeJSON(w, 200, map[string]any{"item": it, "qcJob": job, "qcReport": rep, "proxy": px, "conform": cf, "policy": a.policyFor(it)})
	}
}

// policyFor: was darf mit dem Eintrag jetzt geschehen (für UI-Hinweise; die Durchsetzung passiert im Service).
func (a *api) policyFor(it Item) map[string]any {
	cfg := a.svc.Cfg()
	return map[string]any{
		"claimable":        contains(a.svc.claimableStates(), it.State) && it.Assignee == "",
		"approvalMode":     cfg.ApprovalMode,
		"allowOverlap":     cfg.AllowOverlap,
		"allowGaps":        cfg.AllowGaps,
		"minSegmentFrames": cfg.MinSegmentFrames,
		"qcBlocksReview":   !contains(a.svc.claimableStates(), StateAwaitingQC) && (it.State == StateAwaitingQC || it.State == StateQCRunning),
	}
}

func (a *api) history() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h, err := a.svc.St.History(r.Context(), r.PathValue("id"), 500)
		if err != nil {
			a.writeErr(w, err, nil)
			return
		}
		if h == nil {
			h = []HistoryEntry{}
		}
		writeJSON(w, 200, map[string]any{"history": h})
	}
}

type revBody struct {
	ExpectedRevision int64  `json:"expectedRevision"`
	Note             string `json:"note"`
	To               string `json:"to"`
	Profile          string `json:"profile"`
	Force            bool   `json:"force"`
}

func (a *api) respondItem(w http.ResponseWriter, r *http.Request, it Item, err error) {
	if err != nil {
		var cur *Item
		if errors.Is(err, ErrConflict) {
			if c, e := a.svc.St.GetItem(r.Context(), r.PathValue("id")); e == nil {
				cur = &c
			}
		}
		a.writeErr(w, err, cur)
		return
	}
	writeJSON(w, 200, map[string]any{"item": it})
}

func (a *api) claim() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var groups []string
		override := true
		if a.access != nil {
			who := a.access.Identity(r)
			groups, override = who.Groups, who.Has(FeatAssign)
		}
		it, err := a.svc.ClaimAs(r.Context(), r.PathValue("id"), actorOf(r), groups, override)
		a.respondItem(w, r, it, err)
	}
}

func (a *api) release(privileged bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b revBody
		if !readBody(w, r, &b) {
			return
		}
		it, err := a.svc.Release(r.Context(), r.PathValue("id"), actorOf(r), privileged, b.ExpectedRevision)
		a.respondItem(w, r, it, err)
	}
}

func (a *api) reassign() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b revBody
		if !readBody(w, r, &b) {
			return
		}
		it, err := a.svc.Reassign(r.Context(), r.PathValue("id"), actorOf(r), b.To, b.ExpectedRevision)
		a.respondItem(w, r, it, err)
	}
}

type assignBody struct {
	ExpectedRevision int64      `json:"expectedRevision"`
	User             string     `json:"user"`
	Group            string     `json:"group"`
	DueAt            *time.Time `json:"dueAt"`
}

// assign: POST /items/{id}/assign — Prüfaufgabe einer Person/Gruppe zuweisen (leer = aufheben), mit Frist.
func (a *api) assign() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b assignBody
		if !readBody(w, r, &b) {
			return
		}
		it, err := a.svc.AssignTask(r.Context(), r.PathValue("id"), actorOf(r), b.User, b.Group, b.DueAt, b.ExpectedRevision)
		a.respondItem(w, r, it, err)
	}
}

func (a *api) requestQC() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b revBody
		if !readBody(w, r, &b) {
			return
		}
		j, created, err := a.svc.RequestQC(r.Context(), r.PathValue("id"), actorOf(r), b.Profile, b.Force)
		if err != nil {
			a.writeErr(w, err, nil)
			return
		}
		writeJSON(w, 202, map[string]any{"job": j, "created": created})
	}
}

// compare: POST /api/v1/review/items/{id}/compare {"recordedAssetId":"…","options":{…}} — Original gegen Aufnahme (Kap. 74.5).
func (a *api) compare() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			RecordedAssetID string         `json:"recordedAssetId"`
			Options         CompareOptions `json:"options"`
		}
		if !readBody(w, r, &b) {
			return
		}
		if b.RecordedAssetID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "recordedAssetId fehlt"})
			return
		}
		rep, err := a.svc.Compare(r.Context(), r.PathValue("id"), b.RecordedAssetID, actorOf(r), b.Options)
		if err != nil {
			a.writeErr(w, err, nil)
			return
		}
		writeJSON(w, http.StatusOK, rep)
	}
}

func (a *api) listReports() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		reps, err := a.svc.St.ListReports(r.Context(), r.PathValue("id"))
		if err != nil {
			a.writeErr(w, err, nil)
			return
		}
		if reps == nil {
			reps = []Report{}
		}
		writeJSON(w, 200, map[string]any{"reports": reps})
	}
}

func (a *api) listJobs() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		jobs, err := a.svc.St.ListJobs(r.Context(), r.PathValue("id"), 50)
		if err != nil {
			a.writeErr(w, err, nil)
			return
		}
		if jobs == nil {
			jobs = []Job{}
		}
		writeJSON(w, 200, map[string]any{"jobs": jobs})
	}
}

func (a *api) getReport() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rep, err := a.svc.St.GetReport(r.Context(), r.PathValue("rid"), true)
		if err != nil {
			a.writeErr(w, err, nil)
			return
		}
		writeJSON(w, 200, rep)
	}
}

// exportReport: JSON (vollständig, reproduzierbar: Profil-Schnappschuss, Werkzeugversionen) oder CSV (Befunde).
func (a *api) exportReport() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rep, err := a.svc.St.GetReport(r.Context(), r.PathValue("rid"), true)
		if err != nil {
			a.writeErr(w, err, nil)
			return
		}
		name := "qc-" + rep.AssetID + "-" + rep.ID
		if r.URL.Query().Get("format") == "csv" {
			w.Header().Set("Content-Type", "text/csv; charset=utf-8")
			w.Header().Set("Content-Disposition", `attachment; filename="`+name+`.csv"`)
			cw := csv.NewWriter(w)
			_ = cw.Write([]string{"check", "category", "status", "severity", "message", "start_frame", "end_frame", "stream", "tool", "tool_version", "analyzed_at", "ruleset", "measured", "threshold"})
			for _, f := range rep.Findings {
				m, _ := json.Marshal(f.Measured)
				t, _ := json.Marshal(f.Threshold)
				_ = cw.Write([]string{csvSafe(f.CheckID), f.Category, f.Status, f.Severity, csvSafe(f.Message), optInt(f.StartFrame), optInt(f.EndFrame), optIntI(f.Stream), f.Tool, f.ToolVer, f.AnalyzedAt.Format(time.RFC3339), f.Ruleset, string(m), string(t)})
			}
			cw.Flush()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Disposition", `attachment; filename="`+name+`.json"`)
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		_ = enc.Encode(rep)
	}
}

// csvSafe schützt vor Formel-Injection beim Öffnen in Tabellenkalkulationen.
func csvSafe(s string) string {
	if s != "" && strings.ContainsRune("=+-@\t\r", rune(s[0])) {
		return "'" + s
	}
	return s
}

func optInt(p *int64) string {
	if p == nil {
		return ""
	}
	return strconv.FormatInt(*p, 10)
}

func optIntI(p *int) string {
	if p == nil {
		return ""
	}
	return strconv.Itoa(*p)
}

func (a *api) getConform() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := a.svc.St.WorkingConform(r.Context(), r.PathValue("id"))
		if err != nil {
			a.writeErr(w, err, nil)
			return
		}
		writeJSON(w, 200, map[string]any{"conform": c})
	}
}

func (a *api) listConforms() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cs, err := a.svc.St.ListConforms(r.Context(), r.PathValue("id"))
		if err != nil {
			a.writeErr(w, err, nil)
			return
		}
		if cs == nil {
			cs = []Conform{}
		}
		writeJSON(w, 200, map[string]any{"conforms": cs})
	}
}

func (a *api) saveConform() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in SaveConformInput
		if !readBody(w, r, &in) {
			return
		}
		it, c, err := a.svc.SaveConform(r.Context(), r.PathValue("id"), actorOf(r), in)
		if err != nil {
			a.respondItem(w, r, it, err)
			return
		}
		writeJSON(w, 200, map[string]any{"item": it, "conform": c})
	}
}

func (a *api) submit() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b revBody
		if !readBody(w, r, &b) {
			return
		}
		it, err := a.svc.Submit(r.Context(), r.PathValue("id"), actorOf(r), b.ExpectedRevision)
		a.respondItem(w, r, it, err)
	}
}

func (a *api) withdraw() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b revBody
		if !readBody(w, r, &b) {
			return
		}
		it, err := a.svc.Withdraw(r.Context(), r.PathValue("id"), actorOf(r), b.ExpectedRevision)
		a.respondItem(w, r, it, err)
	}
}

func (a *api) revise() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b revBody
		if !readBody(w, r, &b) {
			return
		}
		it, err := a.svc.Revise(r.Context(), r.PathValue("id"), actorOf(r), b.ExpectedRevision)
		a.respondItem(w, r, it, err)
	}
}

func (a *api) decide(approve bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b revBody
		if !readBody(w, r, &b) {
			return
		}
		it, err := a.svc.Decide(r.Context(), r.PathValue("id"), actorOf(r), approve, b.Note, b.ExpectedRevision)
		a.respondItem(w, r, it, err)
	}
}

func (a *api) archive(on bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b revBody
		if !readBody(w, r, &b) {
			return
		}
		var it Item
		var err error
		if on {
			it, err = a.svc.Archive(r.Context(), r.PathValue("id"), actorOf(r), b.ExpectedRevision)
		} else {
			it, err = a.svc.Unarchive(r.Context(), r.PathValue("id"), actorOf(r), b.ExpectedRevision)
		}
		a.respondItem(w, r, it, err)
	}
}

func (a *api) requestProxy() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b revBody
		if !readBody(w, r, &b) {
			return
		}
		p, err := a.svc.RequestProxy(r.Context(), r.PathValue("id"), b.Force)
		if err != nil {
			a.writeErr(w, err, nil)
			return
		}
		writeJSON(w, 202, map[string]any{"proxy": p})
	}
}

func (a *api) proxyStatus() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, err := a.svc.CurrentProxy(r.Context(), r.PathValue("id"))
		if err != nil {
			a.writeErr(w, err, nil)
			return
		}
		writeJSON(w, 200, map[string]any{"proxy": p})
	}
}

// timecode rechnet serverseitig zwischen Frame und Timecode (gleiche Bibliothek wie die Speicherung — keine zweite Wahrheit im Client).
func (a *api) timecode() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		it, err := a.svc.St.GetItem(r.Context(), r.PathValue("id"))
		if err != nil {
			a.writeErr(w, err, nil)
			return
		}
		if it.Timeline == nil {
			a.writeErr(w, fmt.Errorf("%w: Zeitachse unbekannt", ErrValidation), nil)
			return
		}
		q := r.URL.Query()
		var frame int64
		if tc := q.Get("tc"); tc != "" {
			if frame, err = it.Timeline.FrameForTimecode(tc); err != nil {
				a.writeErr(w, fmt.Errorf("%w: %v", ErrValidation, err), nil)
				return
			}
		} else if f, e := strconv.ParseInt(q.Get("frame"), 10, 64); e == nil && f >= 0 && f <= it.Timeline.DurationFrames {
			frame = f
		} else {
			a.writeErr(w, fmt.Errorf("%w: tc oder frame angeben", ErrValidation), nil)
			return
		}
		writeJSON(w, 200, map[string]any{"frame": frame, "timecode": it.Timeline.Timecode(frame), "timeline": it.Timeline})
	}
}

// serveProxy liefert den Proxy mit Range-Unterstützung (der Browser lädt nie die ganze Datei in den Speicher).
func (a *api) serveProxy() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		path, _, err := a.svc.ProxyFile(r.Context(), r.PathValue("id"))
		if err != nil {
			http.Error(w, "Proxy nicht verfügbar", http.StatusNotFound)
			return
		}
		f, err := os.Open(path)
		if err != nil {
			http.Error(w, "Proxy nicht verfügbar", http.StatusNotFound)
			return
		}
		defer f.Close()
		st, _ := f.Stat()
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Cache-Control", "private, max-age=3600")
		http.ServeContent(w, r, "proxy.mp4", st.ModTime(), f)
	}
}

func (a *api) serveAudioBlock() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		track, e1 := strconv.Atoi(r.PathValue("track"))
		block, e2 := strconv.Atoi(strings.TrimSuffix(r.PathValue("block"), ".wav"))
		if e1 != nil || e2 != nil {
			http.Error(w, "ungültige Spur/Block", http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		wav, err := a.svc.AudioBlock(ctx, r.PathValue("id"), track, block)
		if err != nil {
			code := http.StatusInternalServerError
			if errors.Is(err, ErrNotFound) {
				code = http.StatusNotFound
			} else if errors.Is(err, ErrValidation) {
				code = http.StatusBadRequest
			}
			http.Error(w, "Ton nicht verfügbar", code)
			return
		}
		w.Header().Set("Content-Type", "audio/wav")
		w.Header().Set("Cache-Control", "private, max-age=3600")
		_, _ = w.Write(wav)
	}
}

func (a *api) servePeaks() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		track, err := strconv.Atoi(r.PathValue("track"))
		if err != nil {
			http.Error(w, "ungültige Spur", http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
		defer cancel()
		b, err := a.svc.Peaks(ctx, r.PathValue("id"), track)
		if err != nil {
			code := http.StatusInternalServerError
			if errors.Is(err, ErrNotFound) {
				code = http.StatusNotFound
			} else if errors.Is(err, ErrValidation) {
				code = http.StatusBadRequest
			}
			http.Error(w, "Wellenform nicht verfügbar", code)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Cache-Control", "private, max-age=3600")
		_, _ = w.Write(b)
	}
}

func (a *api) serveFrame() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		n, err := strconv.ParseInt(strings.TrimSuffix(r.PathValue("n"), ".jpg"), 10, 64)
		if err != nil {
			http.Error(w, "ungültige Bildnummer", http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		img, err := a.svc.Frame(ctx, r.PathValue("id"), n)
		if err != nil {
			code := http.StatusInternalServerError
			if errors.Is(err, ErrNotFound) {
				code = http.StatusNotFound
			} else if errors.Is(err, ErrValidation) {
				code = http.StatusBadRequest
			}
			http.Error(w, "Bild nicht verfügbar", code)
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("Cache-Control", "private, max-age=3600")
		_, _ = w.Write(img)
	}
}

func (a *api) importList() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		root := a.svc.Cfg().ImportDir
		if root == "" {
			writeJSON(w, 200, map[string]any{"enabled": false, "files": []string{}})
			return
		}
		var files []string
		_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() || len(files) >= 500 {
				return nil
			}
			if mediaExt[strings.ToLower(filepath.Ext(p))] {
				if rel, e := filepath.Rel(root, p); e == nil {
					files = append(files, rel)
				}
			}
			return nil
		})
		sort.Strings(files)
		if files == nil {
			files = []string{}
		}
		writeJSON(w, 200, map[string]any{"enabled": true, "files": files})
	}
}

func (a *api) importFile() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct{ Path, Title string }
		if !readBody(w, r, &b) {
			return
		}
		it, err := a.svc.ImportFile(r.Context(), b.Path, b.Title, actorOf(r))
		if err != nil {
			a.writeErr(w, err, nil)
			return
		}
		writeJSON(w, 201, map[string]any{"item": it})
	}
}

func (a *api) registerAsset() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			AssetID string `json:"assetId"`
		}
		if !readBody(w, r, &b) {
			return
		}
		it, created, err := a.svc.Register(r.Context(), b.AssetID, actorOf(r))
		if err != nil {
			a.writeErr(w, err, nil)
			return
		}
		writeJSON(w, 200, map[string]any{"item": it, "created": created})
	}
}

func (a *api) getConfig() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, a.svc.Cfg())
	}
}

func (a *api) putConfig() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil {
			writeJSON(w, 400, map[string]any{"error": "Körper nicht lesbar"})
			return
		}
		c, err := ParseConfig(raw)
		if err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		out, _ := json.Marshal(c)
		if err := a.settings.Put(settingsKey, out); err != nil {
			a.writeErr(w, err, nil)
			return
		}
		a.m.cfg.Invalidate()
		a.svc.audit(actorOf(r), "", "config_changed", nil)
		writeJSON(w, 200, c)
	}
}
