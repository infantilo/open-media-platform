package alertsink

import (
	"bytes"
	"fmt"
	"html"
	"image"
	"image/color"
	"image/png"
	"sort"
	"strings"
	"time"
)

// Statusbeilage einer Alarm-Mail (Empfängerregel „Status“): Zustand von Orchestrator, Hosts (Medienserver),
// betroffenen Workflows und der Signalweg vom Alarm-Node aufwärts bis zur Wurzel (Quelle ohne Eingang).

// Werte für Route.Status.
const (
	StatusNone  = ""          // keine Beilage
	StatusText  = "text"      // Textblock im Mailtext
	StatusGraph = "graph"     // Textblock + Node-Grafik (PNG, inline)
	StatusSVG   = "graph-svg" // Textblock + Node-Grafik (SVG-Anhang, scharf/zoombar; Mailprogramme zeigen SVG meist nicht inline)
)

func validStatusMode(s string) bool {
	return s == StatusNone || s == StatusText || s == StatusGraph || s == StatusSVG
}

// StatusReport ist die Momentaufnahme zum Alarmzeitpunkt.
type StatusReport struct {
	Time         time.Time        `json:"time"`
	Orchestrator OrchestratorInfo `json:"orchestrator"`
	Hosts        []HostInfo       `json:"hosts"`
	Workflows    []WorkflowInfo   `json:"workflows"`
	Flow         FlowGraph        `json:"flow"`
}

// OrchestratorInfo beschreibt den sendenden Orchestrator.
type OrchestratorInfo struct {
	Name    string `json:"name"`
	Version string `json:"version,omitempty"`
	Leader  bool   `json:"leader"`
	Peers   int    `json:"peers"` // weitere Cluster-Mitglieder
}

// HostInfo ist ein Host (Medienserver) mit Zustand.
type HostInfo struct {
	Name   string  `json:"name"`
	Online bool    `json:"online"`
	CPU    float64 `json:"cpuPercent"`
	Mem    float64 `json:"memPercent"`
	Note   string  `json:"note,omitempty"` // z. B. „betroffen“
}

// WorkflowInfo ist ein beteiligter Workflow.
type WorkflowInfo struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Nodes  int    `json:"nodes"`
	Down   int    `json:"down"` // davon nicht erreichbar
}

// FlowNode ist eine Kachel im Signalweg.
type FlowNode struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	OK    bool   `json:"ok"`
	Focus bool   `json:"focus"` // der Alarm-Node
}

// FlowEdge: Signal fließt von From nach To.
type FlowEdge struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// FlowGraph: der Alarm-Node und alles, was ihn (über beliebig viele Stufen) speist, bis zu den Wurzeln.
type FlowGraph struct {
	Nodes []FlowNode `json:"nodes"`
	Edges []FlowEdge `json:"edges"`
}

// UpstreamOf sammelt focus und alle Vorgänger über edges (Signalrichtung From→To) bis zu den Wurzeln.
// Nur Nodes aus label kommen vor; Schleifen werden abgefangen.
func UpstreamOf(focus string, edges []FlowEdge, label map[string]string, ok map[string]bool) FlowGraph {
	var g FlowGraph
	if _, known := label[focus]; !known {
		return g
	}
	in := map[string][]string{}
	for _, e := range edges {
		in[e.To] = append(in[e.To], e.From)
	}
	seen := map[string]bool{focus: true}
	queue := []string{focus}
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		g.Nodes = append(g.Nodes, FlowNode{ID: id, Label: label[id], OK: ok[id], Focus: id == focus})
		for _, from := range in[id] {
			if _, known := label[from]; !known {
				continue
			}
			g.Edges = append(g.Edges, FlowEdge{From: from, To: id})
			if !seen[from] {
				seen[from] = true
				queue = append(queue, from)
			}
		}
	}
	return g
}

// Text liefert den Statusblock als Klartext.
func (r *StatusReport) Text() string {
	var b strings.Builder
	b.WriteString("— Status zum Alarmzeitpunkt (" + r.Time.Format("2006-01-02 15:04:05 MST") + ") —\n")
	o := r.Orchestrator
	role := "Folger"
	if o.Leader {
		role = "Leader"
	}
	fmt.Fprintf(&b, "Orchestrator: %s%s, %s, %d weitere(s) Cluster-Mitglied(er)\n", o.Name, ifs(o.Version != "", " "+o.Version), role, o.Peers)
	if len(r.Hosts) > 0 {
		b.WriteString("Hosts / Medienserver:\n")
		for _, h := range r.Hosts {
			st := "ONLINE"
			if !h.Online {
				st = "OFFLINE"
			}
			fmt.Fprintf(&b, "  %-7s %s  CPU %.0f %%  RAM %.0f %%%s\n", st, h.Name, h.CPU, h.Mem, ifs(h.Note != "", "  ("+h.Note+")"))
		}
	}
	if len(r.Workflows) > 0 {
		b.WriteString("Beteiligte Workflows:\n")
		for _, w := range r.Workflows {
			fmt.Fprintf(&b, "  %s (%s): %d Node(s), %d nicht erreichbar\n", w.Name, w.Status, w.Nodes, w.Down)
		}
	}
	if len(r.Flow.Nodes) > 0 {
		b.WriteString("Signalweg bis zur Wurzel (Alarm-Node zuerst):\n")
		b.WriteString(r.Flow.indent())
	}
	return b.String()
}

func ifs(c bool, s string) string {
	if c {
		return s
	}
	return ""
}

// indent druckt den Signalweg als eingerückten Baum (Alarm-Node oben, Vorgänger darunter).
func (g FlowGraph) indent() string {
	lab := map[string]FlowNode{}
	for _, n := range g.Nodes {
		lab[n.ID] = n
	}
	in := map[string][]string{}
	for _, e := range g.Edges {
		in[e.To] = append(in[e.To], e.From)
	}
	var b strings.Builder
	var walk func(id string, depth int, path map[string]bool)
	walk = func(id string, depth int, path map[string]bool) {
		n := lab[id]
		mark := "ok"
		if !n.OK {
			mark = "AUSFALL"
		}
		fmt.Fprintf(&b, "  %s%s%s [%s]\n", strings.Repeat("   ", depth), ifs(depth > 0, "<- "), sanitizeHeader(n.Label), mark)
		if path[id] {
			return
		}
		path[id] = true
		ups := in[id]
		sort.Strings(ups)
		for _, u := range ups {
			if !path[u] {
				walk(u, depth+1, path)
			}
		}
		delete(path, id)
	}
	for _, n := range g.Nodes {
		if n.Focus {
			walk(n.ID, 0, map[string]bool{})
		}
	}
	return b.String()
}

// ---- PNG ----

const (
	boxW, boxH       = 168, 34
	gapX, gapY       = 56, 14
	margin, titleBar = 14, 26
	scale            = 1
)

var (
	colBG    = color.RGBA{0x14, 0x18, 0x20, 0xff}
	colBox   = color.RGBA{0x24, 0x2c, 0x3a, 0xff}
	colOK    = color.RGBA{0x3d, 0xb8, 0x6b, 0xff}
	colBad   = color.RGBA{0xe5, 0x48, 0x4d, 0xff}
	colFocus = color.RGBA{0xf5, 0xb0, 0x30, 0xff}
	colText  = color.RGBA{0xe6, 0xea, 0xf0, 0xff}
	colLine  = color.RGBA{0x7a, 0x86, 0x99, 0xff}
)

// layout ordnet jede Kachel einer Spalte zu: Wurzeln links, der Alarm-Node rechts (Spalte = längster Weg bis zur Wurzel, gespiegelt).
func (g FlowGraph) layout() (pos map[string]image.Point, w, h int) {
	in := map[string][]string{}
	for _, e := range g.Edges {
		in[e.To] = append(in[e.To], e.From)
	}
	depth := map[string]int{} // Abstand zum Alarm-Node (längster Weg)
	var focus string
	for _, n := range g.Nodes {
		if n.Focus {
			focus = n.ID
		}
	}
	// Bellman-Ford-artig, durch Knotenzahl begrenzt (Schleifen)
	depth[focus] = 0
	for i := 0; i < len(g.Nodes); i++ {
		changed := false
		for _, e := range g.Edges {
			if d, ok := depth[e.To]; ok && depth[e.From] < d+1 && d+1 <= len(g.Nodes) {
				depth[e.From] = d + 1
				changed = true
			}
		}
		if !changed {
			break
		}
	}
	maxD := 0
	cols := map[int][]string{}
	for _, n := range g.Nodes {
		d := depth[n.ID]
		if d > maxD {
			maxD = d
		}
		cols[d] = append(cols[d], n.ID)
	}
	rows := 1
	for _, c := range cols {
		sort.Strings(c)
		if len(c) > rows {
			rows = len(c)
		}
	}
	pos = map[string]image.Point{}
	colH := rows*(boxH+gapY) - gapY
	for d, ids := range cols {
		x := margin + (maxD-d)*(boxW+gapX)
		off := (colH - (len(ids)*(boxH+gapY) - gapY)) / 2
		for i, id := range ids {
			pos[id] = image.Pt(x, titleBar+margin+off+i*(boxH+gapY))
		}
	}
	w = margin*2 + (maxD+1)*boxW + maxD*gapX
	h = titleBar + margin*2 + colH
	return
}

// PNG zeichnet den Signalweg als Node-Grafik (Wurzeln links → Alarm-Node rechts). Leerer Graph = nil.
func (g FlowGraph) PNG(title string) ([]byte, error) {
	if len(g.Nodes) == 0 {
		return nil, nil
	}
	pos, w, h := g.layout()
	if tw := margin*2 + textWidth(title); tw > w {
		w = tw
	}
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	fill(img, img.Bounds(), colBG)
	drawText(img, margin, 8, title, colText)
	for _, e := range g.Edges {
		a, okA := pos[e.From]
		b, okB := pos[e.To]
		if !okA || !okB {
			continue
		}
		drawEdge(img, image.Pt(a.X+boxW, a.Y+boxH/2), image.Pt(b.X, b.Y+boxH/2))
	}
	for _, n := range g.Nodes {
		p := pos[n.ID]
		r := image.Rect(p.X, p.Y, p.X+boxW, p.Y+boxH)
		border := colOK
		if !n.OK {
			border = colBad
		}
		if n.Focus {
			border = colFocus
		}
		fill(img, r, border)
		fill(img, r.Inset(2), colBox)
		fill(img, image.Rect(r.Min.X+2, r.Min.Y+2, r.Min.X+7, r.Max.Y-2), map[bool]color.RGBA{true: colOK, false: colBad}[n.OK])
		drawText(img, r.Min.X+14, r.Min.Y+(boxH-fontH)/2, clip(n.Label, (boxW-20)/fontW), colText)
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "."
}

func textWidth(s string) int { return len([]rune(s)) * fontW }

func fill(img *image.RGBA, r image.Rectangle, c color.RGBA) {
	r = r.Intersect(img.Bounds())
	for y := r.Min.Y; y < r.Max.Y; y++ {
		for x := r.Min.X; x < r.Max.X; x++ {
			img.SetRGBA(x, y, c)
		}
	}
}

func drawText(img *image.RGBA, x, y int, s string, c color.RGBA) {
	for _, r := range s {
		if r < 32 || r > 255 {
			r = '?'
		}
		gl := fontGlyphs[r-32]
		for row := 0; row < fontH; row++ {
			for col := 0; col < fontW; col++ {
				if gl[row]&(1<<(fontW-1-col)) != 0 {
					img.SetRGBA(x+col, y+row, c)
				}
			}
		}
		x += fontW
	}
}

// drawEdge zeichnet eine Linie mit Knick (waagerecht – senkrecht – waagerecht) und Pfeilspitze.
func drawEdge(img *image.RGBA, a, b image.Point) {
	mx := (a.X + b.X) / 2
	hline := func(x1, x2, y int) {
		if x1 > x2 {
			x1, x2 = x2, x1
		}
		for x := x1; x <= x2; x++ {
			img.SetRGBA(x, y, colLine)
		}
	}
	vline := func(x, y1, y2 int) {
		if y1 > y2 {
			y1, y2 = y2, y1
		}
		for y := y1; y <= y2; y++ {
			img.SetRGBA(x, y, colLine)
		}
	}
	hline(a.X, mx, a.Y)
	vline(mx, a.Y, b.Y)
	hline(mx, b.X, b.Y)
	for i := 0; i < 5; i++ { // Pfeilspitze
		vline(b.X-1-i, b.Y-(4-i), b.Y+(4-i))
	}
}

// SVG zeichnet denselben Signalweg als SVG (gleiche Anordnung wie PNG). Leerer Graph = nil.
func (g FlowGraph) SVG(title string) []byte {
	if len(g.Nodes) == 0 {
		return nil
	}
	pos, w, h := g.layout()
	if tw := margin*2 + textWidth(title); tw > w {
		w = tw
	}
	hex := func(c color.RGBA) string { return fmt.Sprintf("#%02x%02x%02x", c.R, c.G, c.B) }
	var b strings.Builder
	fmt.Fprintf(&b, `<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d" font-family="monospace" font-size="12">`, w, h, w, h)
	fmt.Fprintf(&b, `<rect width="%d" height="%d" fill="%s"/><text x="%d" y="18" fill="%s">%s</text>`, w, h, hex(colBG), margin, hex(colText), html.EscapeString(title))
	for _, e := range g.Edges {
		a, okA := pos[e.From]
		c, okC := pos[e.To]
		if !okA || !okC {
			continue
		}
		x1, y1, x2, y2 := a.X+boxW, a.Y+boxH/2, c.X, c.Y+boxH/2
		mx := (x1 + x2) / 2
		fmt.Fprintf(&b, `<polyline points="%d,%d %d,%d %d,%d %d,%d" fill="none" stroke="%s" stroke-width="1.5"/><polygon points="%d,%d %d,%d %d,%d" fill="%s"/>`,
			x1, y1, mx, y1, mx, y2, x2, y2, hex(colLine), x2, y2, x2-7, y2-4, x2-7, y2+4, hex(colLine))
	}
	for _, n := range g.Nodes {
		p := pos[n.ID]
		border, dot := colOK, colOK
		if !n.OK {
			border, dot = colBad, colBad
		}
		if n.Focus {
			border = colFocus
		}
		fmt.Fprintf(&b, `<rect x="%d" y="%d" width="%d" height="%d" rx="3" fill="%s" stroke="%s" stroke-width="2"/><rect x="%d" y="%d" width="5" height="%d" fill="%s"/><text x="%d" y="%d" fill="%s">%s</text>`,
			p.X, p.Y, boxW, boxH, hex(colBox), hex(border), p.X+2, p.Y+2, boxH-4, hex(dot), p.X+14, p.Y+boxH/2+4, hex(colText), html.EscapeString(clip(n.Label, (boxW-20)/fontW)))
	}
	b.WriteString("</svg>")
	return []byte(b.String())
}
