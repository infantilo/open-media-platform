package hostbridge

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

// Launcher ist die genutzte Teilmenge von *launcher.Launcher.
type Launcher interface {
	StartLabeled(nodeType, version, hostID, customLabel string, extraEnv map[string]string) (launcher.Instance, error)
	Stop(id string) error
}

// Nodes liefert den Registry-Snapshot.
type Nodes interface {
	List() []registry.NodeView
}

// Runner baut und entfernt die Gateway-Ketten.
type Runner struct {
	Launcher Launcher
	Nodes    Nodes
	// Ready prüft nach der Registrierung, ob ein Glied betriebsbereit ist (nil = Registrierung genügt).
	Ready func(ctx context.Context, n registry.NodeView, role string) error
	// RegistrationTimeout: Frist je Glied (Standard 15 s).
	RegistrationTimeout time.Duration
	PollInterval        time.Duration
	// Ports vergibt UDP-Ports für Ketten mit RTP/SRT-Gliedern (nil = Zufall im Bereich 24000–28999).
	Ports func() int

	mu      sync.Mutex
	portSeq int
}

// ErrBuild: keiner der möglichen Transporte ließ sich aufbauen.
var ErrBuild = errors.New("hostbridge: bridge could not be built")

// Built ist eine laufende Kette. Entry nimmt die Quelle (IS-05-Empfänger) auf der Senderseite an, Exit liefert
// das Signal (IS-05-Sender) auf der Empfängerseite.
type Built struct {
	// ID verbindet die Glieder der Kette (Marke OMP_BRIDGE_ID).
	ID        string
	Transport Transport
	Entry     registry.NodeView
	Exit      registry.NodeView
	// Instances in Startreihenfolge; Teardown stoppt in umgekehrter Reihenfolge.
	Instances []string
}

// EntryReceiver ist der Empfänger, an den die Quelle geschaltet wird (Bild: der erste Empfänger).
func (b *Built) EntryReceiver() string {
	if len(b.Entry.Receivers) == 0 {
		return ""
	}
	return b.Entry.Receivers[0].ID
}

// ExitSender ist der Sender, aus dem die Verbraucher speisen.
func (b *Built) ExitSender() string {
	if len(b.Exit.Senders) == 0 {
		return ""
	}
	return b.Exit.Senders[0].ID
}

type stage struct {
	role  string // "entry", "exit" oder "" (Zwischenglied)
	typ   string
	host  string
	env   func(st *runState) map[string]string
	label string
}

type runState struct {
	b     Bridge
	ports []int
	nodes map[string]registry.NodeView // je Phase (Rolle/Typname)
	addr  map[string]string            // Host-ID → Adresse
}

func (r *Runner) port() int {
	if r.Ports != nil {
		return r.Ports()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.portSeq++
	return 24000 + (int(time.Now().UnixNano()/1000)+r.portSeq*7)%5000
}

func rate(f Format) (int, int) {
	n, d := f.RateNum, f.RateDen
	if n <= 0 {
		n = 25
	}
	if d <= 0 {
		d = 1
	}
	return n, d
}

func geom(f Format) (int, int) {
	w, h := f.Width, f.Height
	if w <= 0 || h <= 0 {
		w, h = 1920, 1080
	}
	return w, h
}

func itoa(i int) string { return strconv.Itoa(i) }

// stages liefert die Glieder in Startreihenfolge (Empfängerseite zuerst). Fehler: Transport für das Medium unbekannt.
func stages(t Transport, b Bridge, nPorts *int) ([]stage, error) {
	w, h := geom(b.Format)
	rn, rd := rate(b.Format)
	raster := func(prefix string) map[string]string {
		return map[string]string{prefix + "WIDTH": itoa(w), prefix + "HEIGHT": itoa(h), prefix + "FPS_NUM": itoa(rn), prefix + "FPS_DEN": itoa(rd)}
	}
	merge := func(a, b map[string]string) map[string]string {
		for k, v := range b {
			a[k] = v
		}
		return a
	}
	switch t {
	case Fabrics:
		return []stage{
			{role: "exit", typ: "omp-fabrics-gateway-target", host: b.ReceiverHost, label: "Bridge (Fabrics, receiver)",
				env: func(*runState) map[string]string { return raster("OMP_FABRICS_") }},
			{role: "entry", typ: "omp-fabrics-gateway-initiator", host: b.SenderHost, label: "Bridge (Fabrics, sender)",
				env: func(st *runState) map[string]string {
					return map[string]string{"OMP_FABRICS_TARGET_URL": st.nodes["exit"].APIBaseURL}
				}},
		}, nil
	case ST2110:
		*nPorts = 1
		return []stage{
			{role: "exit", typ: "omp-2110-gateway-ingest", host: b.ReceiverHost, label: "Bridge (ST 2110, receiver)",
				env: func(st *runState) map[string]string {
					return merge(raster("OMP_2110_GATEWAY_"), map[string]string{"OMP_2110_GATEWAY_LISTEN_PORT": itoa(st.ports[0])})
				}},
			{role: "entry", typ: "omp-2110-gateway-output", host: b.SenderHost, label: "Bridge (ST 2110, sender)",
				env: func(st *runState) map[string]string {
					return merge(raster("OMP_2110_GATEWAY_"), map[string]string{
						"OMP_2110_GATEWAY_DEST_HOST": st.addr[b.ReceiverHost], "OMP_2110_GATEWAY_DEST_PORT": itoa(st.ports[0])})
				}},
		}, nil
	case AES67:
		*nPorts = 1
		ch, sr := b.Format.Channels, b.Format.SampleRate
		if ch <= 0 {
			ch = 2
		}
		if sr <= 0 {
			sr = 48000
		}
		return []stage{
			{role: "exit", typ: "omp-aes67-gateway-sink", host: b.ReceiverHost, label: "Bridge (AES67, receiver)",
				env: func(st *runState) map[string]string {
					return map[string]string{"OMP_AES67_GATEWAY_LISTEN_PORT": itoa(st.ports[0]), "OMP_AES67_GATEWAY_CHANNELS": itoa(ch), "OMP_AES67_GATEWAY_SAMPLE_RATE": itoa(sr)}
				}},
			{role: "entry", typ: "omp-aes67-gateway-source", host: b.SenderHost, label: "Bridge (AES67, sender)",
				env: func(st *runState) map[string]string {
					return map[string]string{"OMP_AES67_GATEWAY_DEST_HOST": st.addr[b.ReceiverHost], "OMP_AES67_GATEWAY_DEST_PORT": itoa(st.ports[0]),
						"OMP_AES67_GATEWAY_CHANNELS": itoa(ch), "OMP_AES67_GATEWAY_SAMPLE_RATE": itoa(sr)}
				}},
		}, nil
	case SRT:
		// MXL → 2110 (lokal) → SRT → 2110 (lokal) → MXL; Ports: 0 = Senderseite lokal, 1 = SRT, 2 = Empfängerseite lokal.
		*nPorts = 3
		srtRaster := map[string]string{"OMP_SRT_GATEWAY_WIDTH": itoa(w), "OMP_SRT_GATEWAY_HEIGHT": itoa(h), "OMP_SRT_GATEWAY_FPS": itoa(rn / maxInt(rd, 1))}
		return []stage{
			{typ: "omp-2110-gateway-ingest", role: "exit", host: b.ReceiverHost, label: "Bridge (SRT, 2110 in)",
				env: func(st *runState) map[string]string {
					return merge(raster("OMP_2110_GATEWAY_"), map[string]string{"OMP_2110_GATEWAY_LISTEN_PORT": itoa(st.ports[2])})
				}},
			{typ: "omp-srt-gateway-downlink", host: b.ReceiverHost, label: "Bridge (SRT, downlink)",
				env: func(st *runState) map[string]string {
					return merge(copyMap(srtRaster), map[string]string{"OMP_SRT_GATEWAY_SRT_URI": "srt://:" + itoa(st.ports[1]) + "?mode=listener",
						"OMP_SRT_GATEWAY_ST2110_HOST": "127.0.0.1", "OMP_SRT_GATEWAY_ST2110_PORT": itoa(st.ports[2])})
				}},
			{typ: "omp-srt-gateway-uplink", host: b.SenderHost, label: "Bridge (SRT, uplink)",
				env: func(st *runState) map[string]string {
					return merge(copyMap(srtRaster), map[string]string{"OMP_SRT_GATEWAY_ST2110_PORT": itoa(st.ports[0]),
						"OMP_SRT_GATEWAY_SRT_URI": "srt://" + st.addr[b.ReceiverHost] + ":" + itoa(st.ports[1]) + "?mode=caller"})
				}},
			{typ: "omp-2110-gateway-output", role: "entry", host: b.SenderHost, label: "Bridge (SRT, 2110 out)",
				env: func(st *runState) map[string]string {
					return merge(raster("OMP_2110_GATEWAY_"), map[string]string{"OMP_2110_GATEWAY_DEST_HOST": "127.0.0.1", "OMP_2110_GATEWAY_DEST_PORT": itoa(st.ports[0])})
				}},
		}, nil
	}
	return nil, fmt.Errorf("hostbridge: unknown transport %q", t)
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func copyMap(m map[string]string) map[string]string {
	o := make(map[string]string, len(m))
	for k, v := range m {
		o[k] = v
	}
	return o
}

// hostOfURL liefert den Host-Teil einer Node-API-URL (Adresse, unter der der Host im Netz erreichbar ist).
func hostOfURL(u string) string {
	p, err := url.Parse(u)
	if err != nil {
		return ""
	}
	return p.Hostname()
}

func (r *Runner) findByInstance(id string) (registry.NodeView, bool) {
	for _, n := range r.Nodes.List() {
		if n.InstanceID == id {
			return n, true
		}
	}
	return registry.NodeView{}, false
}

func (r *Runner) awaitNode(ctx context.Context, id string) (registry.NodeView, error) {
	poll := r.PollInterval
	if poll <= 0 {
		poll = 200 * time.Millisecond
	}
	tick := time.NewTicker(poll)
	defer tick.Stop()
	for {
		if n, ok := r.findByInstance(id); ok {
			return n, nil
		}
		select {
		case <-ctx.Done():
			return registry.NodeView{}, fmt.Errorf("instance %s did not register: %w", id, ctx.Err())
		case <-tick.C:
		}
	}
}

// Build baut die Brücke mit dem ersten Transport aus b.Candidates, der sich aufbauen lässt; scheitert einer
// (Start, Registrierung, Bereitschaft), wird seine Kette wieder entfernt und der nächste versucht.
func (r *Runner) Build(ctx context.Context, b Bridge) (*Built, error) {
	var errs []error
	for _, t := range b.Candidates {
		built, err := r.buildOne(ctx, t, b)
		if err == nil {
			return built, nil
		}
		slog.Warn("hostbridge: transport failed, trying the next one", "transport", t, "error", err)
		errs = append(errs, fmt.Errorf("%s: %w", t, err))
	}
	return nil, fmt.Errorf("%w: %w", ErrBuild, errors.Join(errs...))
}

func (r *Runner) buildOne(ctx context.Context, t Transport, b Bridge) (*Built, error) {
	nPorts := 0
	sts, err := stages(t, b, &nPorts)
	if err != nil {
		return nil, err
	}
	st := &runState{b: b, nodes: map[string]registry.NodeView{}, addr: map[string]string{}}
	for i := 0; i < nPorts; i++ {
		st.ports = append(st.ports, r.port())
	}
	idb := make([]byte, 6)
	_, _ = rand.Read(idb)
	built := &Built{Transport: t, ID: hex.EncodeToString(idb)}
	fail := func(err error) (*Built, error) {
		r.Teardown(built)
		return nil, err
	}
	timeout := r.RegistrationTimeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	for _, sg := range sts {
		env := sg.env(st)
		env[EnvID] = built.ID
		if b.Owner != "" {
			env[EnvOwner] = b.Owner
		}
		if sg.role != "" {
			env[EnvRole] = sg.role
		}
		inst, err := r.Launcher.StartLabeled(sg.typ, "", sg.host, sg.label, env)
		if err != nil {
			return fail(fmt.Errorf("start %s: %w", sg.typ, err))
		}
		built.Instances = append(built.Instances, inst.ID)
		rctx, cancel := context.WithTimeout(ctx, timeout)
		n, err := r.awaitNode(rctx, inst.ID)
		cancel()
		if err != nil {
			return fail(err)
		}
		if r.Ready != nil {
			rctx, cancel := context.WithTimeout(ctx, timeout)
			err := r.Ready(rctx, n, sg.role)
			cancel()
			if err != nil {
				return fail(fmt.Errorf("%s not ready: %w", sg.typ, err))
			}
		}
		if sg.role != "" {
			st.nodes[sg.role] = n
		}
		if a := hostOfURL(n.APIBaseURL); a != "" {
			st.addr[sg.host] = a
		}
		switch sg.role {
		case "entry":
			built.Entry = n
		case "exit":
			built.Exit = n
		}
	}
	if built.EntryReceiver() == "" || built.ExitSender() == "" {
		return fail(errors.New("gateway chain has no entry receiver or exit sender"))
	}
	return built, nil
}

// Teardown stoppt die Kette (umgekehrte Startreihenfolge: erst die Senderseite). Fehler werden nur gemeldet.
func (r *Runner) Teardown(b *Built) {
	if b == nil {
		return
	}
	for i := len(b.Instances) - 1; i >= 0; i-- {
		if err := r.Launcher.Stop(b.Instances[i]); err != nil && !errors.Is(err, launcher.ErrStopDeferred) {
			slog.Warn("hostbridge: bridge node did not stop", "instance", b.Instances[i], "error", err)
		}
	}
	b.Instances = nil
}
