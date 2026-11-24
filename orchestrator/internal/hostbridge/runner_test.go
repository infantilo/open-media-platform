package hostbridge

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

type fakeEnv struct {
	mu       sync.Mutex
	seq      int
	started  []string
	envs     map[string]map[string]string
	stopped  []string
	nodes    []registry.NodeView
	failType map[string]bool
}

func newFake() *fakeEnv {
	return &fakeEnv{envs: map[string]map[string]string{}, failType: map[string]bool{}}
}

func (f *fakeEnv) StartLabeled(typ, ver, host, label string, env map[string]string) (launcher.Instance, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failType[typ] {
		return launcher.Instance{}, errors.New("no binary")
	}
	f.seq++
	id := fmt.Sprintf("i%d", f.seq)
	f.started = append(f.started, typ+"@"+host)
	f.envs[typ] = env
	n := registry.NodeView{ID: "n" + id, InstanceID: id, APIBaseURL: "http://10.0.0." + host + ":9000",
		Senders: []registry.SenderView{{ID: "s-" + id}}, Receivers: []registry.ReceiverView{{ID: "r-" + id}}}
	f.nodes = append(f.nodes, n)
	return launcher.Instance{ID: id, Type: typ}, nil
}
func (f *fakeEnv) Stop(id string) error {
	f.mu.Lock()
	f.stopped = append(f.stopped, id)
	f.mu.Unlock()
	return nil
}
func (f *fakeEnv) List() []registry.NodeView {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]registry.NodeView(nil), f.nodes...)
}

func runner(f *fakeEnv) *Runner {
	return &Runner{Launcher: f, Nodes: f, PollInterval: time.Millisecond, RegistrationTimeout: time.Second, Ports: func() int { return 25000 }}
}

func bridge(c ...Transport) Bridge {
	return Bridge{Medium: Video, Format: Format{Width: 1280, Height: 720, RateNum: 50, RateDen: 1}, SenderHost: "2", ReceiverHost: "1", Candidates: c}
}

func TestFabricsChainStartsReceiverFirstAndPassesTargetURL(t *testing.T) {
	f := newFake()
	b, err := runner(f).Build(context.Background(), bridge(Fabrics))
	if err != nil {
		t.Fatal(err)
	}
	if len(f.started) != 2 || !strings.HasPrefix(f.started[0], "omp-fabrics-gateway-target@1") || !strings.HasPrefix(f.started[1], "omp-fabrics-gateway-initiator@2") {
		t.Fatalf("order = %v", f.started)
	}
	if got := f.envs["omp-fabrics-gateway-initiator"]["OMP_FABRICS_TARGET_URL"]; got != "http://10.0.0.1:9000" {
		t.Fatalf("target url = %q", got)
	}
	if e := f.envs["omp-fabrics-gateway-target"]; e["OMP_FABRICS_WIDTH"] != "1280" || e["OMP_FABRICS_HEIGHT"] != "720" || e["OMP_FABRICS_FPS_NUM"] != "50" {
		t.Fatalf("raster env = %v", e)
	}
	if b.EntryReceiver() != "r-i2" || b.ExitSender() != "s-i1" {
		t.Fatalf("entry/exit = %q %q", b.EntryReceiver(), b.ExitSender())
	}
	runner(f).Teardown(b)
	if len(f.stopped) != 2 || f.stopped[0] != "i2" || f.stopped[1] != "i1" {
		t.Fatalf("teardown order = %v", f.stopped)
	}
}

func TestFallbackToNextTransportRemovesFailedChain(t *testing.T) {
	f := newFake()
	f.failType["omp-fabrics-gateway-initiator"] = true // Ziel startet, Sender nicht
	b, err := runner(f).Build(context.Background(), bridge(Fabrics, ST2110))
	if err != nil {
		t.Fatal(err)
	}
	if b.Transport != ST2110 {
		t.Fatalf("transport = %s", b.Transport)
	}
	if len(f.stopped) != 1 || f.stopped[0] != "i1" {
		t.Fatalf("failed chain not removed: %v", f.stopped)
	}
	if e := f.envs["omp-2110-gateway-output"]; e["OMP_2110_GATEWAY_DEST_HOST"] != "10.0.0.1" || e["OMP_2110_GATEWAY_DEST_PORT"] != "25000" {
		t.Fatalf("2110 env = %v", e)
	}
}

func TestNotReadyCountsAsFailure(t *testing.T) {
	f := newFake()
	r := runner(f)
	r.Ready = func(_ context.Context, _ registry.NodeView, role string) error {
		if role == "entry" {
			return errors.New("no libfabric")
		}
		return nil
	}
	_, err := r.Build(context.Background(), bridge(Fabrics))
	if !errors.Is(err, ErrBuild) || len(f.stopped) != 2 {
		t.Fatalf("err=%v stopped=%v", err, f.stopped)
	}
}

func TestAudioAndSRTChains(t *testing.T) {
	f := newFake()
	a := Bridge{Medium: Audio, Format: Format{Channels: 8, SampleRate: 48000}, SenderHost: "2", ReceiverHost: "1", Candidates: []Transport{AES67}}
	if _, err := runner(f).Build(context.Background(), a); err != nil {
		t.Fatal(err)
	}
	if e := f.envs["omp-aes67-gateway-source"]; e["OMP_AES67_GATEWAY_CHANNELS"] != "8" || e["OMP_AES67_GATEWAY_DEST_HOST"] != "10.0.0.1" {
		t.Fatalf("aes67 env = %v", e)
	}
	f2 := newFake()
	b, err := runner(f2).Build(context.Background(), bridge(SRT))
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Instances) != 4 || !strings.HasPrefix(f2.started[0], "omp-2110-gateway-ingest@1") || !strings.HasPrefix(f2.started[3], "omp-2110-gateway-output@2") {
		t.Fatalf("srt chain = %v", f2.started)
	}
	if !strings.Contains(f2.envs["omp-srt-gateway-uplink"]["OMP_SRT_GATEWAY_SRT_URI"], "mode=caller") {
		t.Fatalf("uplink env = %v", f2.envs["omp-srt-gateway-uplink"])
	}
}
