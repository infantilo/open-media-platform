package analyze

import (
	"fmt"
	"strings"
	"time"
)

const tsFmt = "2006-01-02 15:04:05"

func ts(t time.Time) string {
	if t.IsZero() {
		return "-"
	}
	return t.UTC().Format(tsFmt) + "Z"
}

// Markdown schreibt den Bericht als Text (zum Lesen und als Eingabe für ein Sprachmodell).
func Markdown(r *Report, lang string) string {
	t := tr{en: strings.HasPrefix(lang, "en")}
	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n\n", r.Title)
	fmt.Fprintf(&b, "- %s: %s … %s\n", t.s("Zeitraum", "Window"), ts(r.From), ts(r.To))
	if r.Version != "" {
		fmt.Fprintf(&b, "- %s: %s\n", t.s("Version", "Version"), r.Version)
	}
	if r.Trigger != "" {
		fmt.Fprintf(&b, "- %s: %s %s\n", t.s("Auslöser", "Trigger"), r.Trigger, r.Reason)
	}
	if r.Note != "" {
		fmt.Fprintf(&b, "- %s: %s\n", t.s("Notiz", "Note"), r.Note)
	}
	fmt.Fprintf(&b, "- **%s**\n\n", r.Summary)

	b.WriteString("## " + t.s("Befunde", "Findings") + "\n\n")
	if len(r.Findings) == 0 {
		b.WriteString(t.s("Keine.\n\n", "None.\n\n"))
	}
	for _, f := range r.Findings {
		fmt.Fprintf(&b, "- [%s] %s", strings.ToUpper(f.Level), f.Title)
		if !f.At.IsZero() {
			fmt.Fprintf(&b, " (%s)", ts(f.At))
		}
		if f.Detail != "" {
			fmt.Fprintf(&b, " — %s", f.Detail)
		}
		if f.Fix != "" {
			fmt.Fprintf(&b, "\n  - %s: %s", t.s("Nächster Schritt", "Next step"), f.Fix)
		}
		b.WriteString("\n")
	}
	if len(r.Outages) > 0 {
		b.WriteString("\n## " + t.s("Ausfälle (Medien nicht bereit)", "Outages (media not ready)") + "\n\n")
		for _, o := range r.Outages {
			end := ts(o.To)
			if o.Open {
				end = t.s("offen", "open")
			}
			fmt.Fprintf(&b, "- %s: %s … %s (%.0f s)\n", o.Label, ts(o.From), end, o.Seconds)
		}
	}
	if len(r.Timeline) > 0 {
		b.WriteString("\n## " + t.s("Zeitleiste", "Timeline") + "\n\n")
		for _, e := range r.Timeline {
			fmt.Fprintf(&b, "- %s [%s] %s/%s %s %s\n", ts(e.At), e.Severity, e.Source, e.Kind, e.Subject, e.Text)
		}
	}
	var flagged []Series
	for _, s := range r.Series {
		if s.Flag != "" {
			flagged = append(flagged, s)
		}
	}
	if len(flagged) > 0 {
		b.WriteString("\n## " + t.s("Auffällige Messreihen", "Notable series") + "\n\n")
		for _, s := range flagged {
			fmt.Fprintf(&b, "- %s %s (%s): min %.1f, Ø %.1f, max %.1f, %s %.1f → %.1f\n", s.Label, s.Metric, s.Flag, s.Min, s.Avg, s.Max, t.s("von", "from"), s.First, s.Last)
		}
	}
	if len(r.LogGroups) > 0 {
		b.WriteString("\n## " + t.s("Meldungen (gruppiert)", "Log messages (grouped)") + "\n\n")
		for _, g := range r.LogGroups {
			fmt.Fprintf(&b, "- [%s] %d× %s %s %s (%s … %s)\n", g.Level, g.Count, g.Source, g.Code, g.Message, ts(g.First), ts(g.Last))
		}
	}
	if len(r.Pipelines) > 0 {
		fmt.Fprintf(&b, "\n## Pipelines\n\n%s\n", strings.Join(r.Pipelines, ", "))
	}
	return b.String()
}
