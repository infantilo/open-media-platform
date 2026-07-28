package registry

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func strPtr(s string) *string { return &s }

func TestBuildSnapshotAssemblesHierarchy(t *testing.T) {
	nodes := []is04Node{{ID: "node-1", Label: "Node 1"}}
	devices := []is04Device{{ID: "dev-1", Label: "Device 1", NodeID: "node-1"}}
	senders := []is04Sender{{ID: "send-1", Label: "Sender 1", DeviceID: "dev-1", FlowID: strPtr("flow-1")}}
	receivers := []is04Receiver{{ID: "recv-1", Label: "Receiver 1", DeviceID: "dev-1", Format: "urn:x-nmos:format:video"}}
	flows := []is04Flow{{ID: "flow-1", Format: "urn:x-nmos:format:video"}}

	views := buildSnapshot(nodes, devices, senders, receivers, flows)

	if len(views) != 1 {
		t.Fatalf("len(views) = %d, want 1", len(views))
	}
	v := views[0]
	if v.ID != "node-1" || v.Label != "Node 1" {
		t.Errorf("node id/label = %q/%q, want node-1/Node 1", v.ID, v.Label)
	}
	if !v.Online {
		t.Error("expected node to be marked online")
	}
	if len(v.Devices) != 1 || v.Devices[0].ID != "dev-1" {
		t.Errorf("devices = %+v, want one device dev-1", v.Devices)
	}
	if len(v.Senders) != 1 || v.Senders[0].Format != "urn:x-nmos:format:video" {
		t.Errorf("senders = %+v, want one sender with resolved flow format", v.Senders)
	}
	if len(v.Receivers) != 1 || v.Receivers[0].Format != "urn:x-nmos:format:video" {
		t.Errorf("receivers = %+v, want one receiver with format", v.Receivers)
	}
}

func TestBuildSnapshotSenderWithoutFlowHasEmptyFormat(t *testing.T) {
	nodes := []is04Node{{ID: "node-1", Label: "Node 1"}}
	devices := []is04Device{{ID: "dev-1", NodeID: "node-1"}}
	senders := []is04Sender{{ID: "send-1", DeviceID: "dev-1", FlowID: nil}}

	views := buildSnapshot(nodes, devices, senders, nil, nil)

	if len(views[0].Senders) != 1 {
		t.Fatalf("expected one sender")
	}
	if views[0].Senders[0].Format != "" {
		t.Errorf("format = %q, want empty (no flow registered)", views[0].Senders[0].Format)
	}
}

func TestBuildSnapshotNodeWithoutDevicesHasEmptySlices(t *testing.T) {
	nodes := []is04Node{{ID: "node-1", Label: "Lonely Node"}}

	views := buildSnapshot(nodes, nil, nil, nil, nil)

	if len(views) != 1 {
		t.Fatalf("len(views) = %d, want 1", len(views))
	}
	if views[0].Devices == nil || len(views[0].Devices) != 0 {
		t.Errorf("Devices = %v, want empty non-nil slice", views[0].Devices)
	}
	if views[0].Senders == nil || len(views[0].Senders) != 0 {
		t.Errorf("Senders = %v, want empty non-nil slice", views[0].Senders)
	}
}

func TestApiBaseURLFromNodeEndpoint(t *testing.T) {
	n := is04Node{
		ID: "node-1",
		API: is04NodeAPI{
			Endpoints: []is04NodeEndpoint{{Host: "127.0.0.1", Port: 9001, Protocol: "http"}},
		},
	}
	if got := apiBaseURL(n); got != "http://127.0.0.1:9001" {
		t.Errorf("apiBaseURL() = %q, want http://127.0.0.1:9001", got)
	}
}

func TestApiBaseURLWithoutEndpointsIsEmpty(t *testing.T) {
	n := is04Node{ID: "node-1"}
	if got := apiBaseURL(n); got != "" {
		t.Errorf("apiBaseURL() = %q, want empty string", got)
	}
}

func TestBuildSnapshotIncludesAPIBaseURL(t *testing.T) {
	nodes := []is04Node{{
		ID: "node-1", Label: "Node 1",
		API: is04NodeAPI{Endpoints: []is04NodeEndpoint{{Host: "127.0.0.1", Port: 9001, Protocol: "http"}}},
	}}

	views := buildSnapshot(nodes, nil, nil, nil, nil)

	if views[0].APIBaseURL != "http://127.0.0.1:9001" {
		t.Errorf("APIBaseURL = %q, want http://127.0.0.1:9001", views[0].APIBaseURL)
	}
}

// TestFetchSnapshotFillsDeviceMissingFromBulkSendersList deckt den
// Nutzerfund 2026-07-28 ab (Regieplatz-1-Start scheiterte mit "role
// omp-video-mixer-me has no sender", obwohl der Sender real registriert
// war): nmos-cpp's ungefilterte Bulk-Liste `GET .../senders` kann eine
// real vorhandene Ressource dauerhaft auslassen, während
// `GET .../senders?device_id=X` sie korrekt liefert. FetchSnapshot muss
// für ein Device, das im Bulk-Ergebnis mit null Sendern/Empfängern
// dasteht, die gezielte Device-gescopte Nachfrage stellen und deren
// Ergebnis übernehmen.
func TestFetchSnapshotFillsDeviceMissingFromBulkSendersList(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/x-nmos/query/v1.3/nodes":
			_, _ = w.Write([]byte(`[{"id":"node-1","label":"Mixer"}]`))
		case r.URL.Path == "/x-nmos/query/v1.3/devices":
			_, _ = w.Write([]byte(`[{"id":"dev-1","label":"Mixer Device","node_id":"node-1"}]`))
		case r.URL.Path == "/x-nmos/query/v1.3/senders" && r.URL.RawQuery == "":
			// Bulk-Liste lässt den Sender dieses Device bewusst aus (der
			// live beobachtete Bug) — leer statt des echten Eintrags.
			_, _ = w.Write([]byte(`[]`))
		case r.URL.Path == "/x-nmos/query/v1.3/senders" && r.URL.RawQuery == "device_id=dev-1":
			_, _ = w.Write([]byte(`[{"id":"send-1","label":"PGM","device_id":"dev-1","flow_id":"flow-1"}]`))
		case r.URL.Path == "/x-nmos/query/v1.3/receivers":
			_, _ = w.Write([]byte(`[]`))
		case r.URL.Path == "/x-nmos/query/v1.3/flows":
			_, _ = w.Write([]byte(`[{"id":"flow-1","format":"urn:x-nmos:format:video"}]`))
		default:
			t.Errorf("unexpected request: %s?%s", r.URL.Path, r.URL.RawQuery)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, nil)
	views, err := client.FetchSnapshot(context.Background())
	if err != nil {
		t.Fatalf("FetchSnapshot() error = %v", err)
	}
	if len(views) != 1 {
		t.Fatalf("len(views) = %d, want 1", len(views))
	}
	senders := views[0].Senders
	if len(senders) != 1 || senders[0].ID != "send-1" || senders[0].Format != "urn:x-nmos:format:video" {
		t.Fatalf("Senders = %+v, want the device-scoped fallback sender with resolved flow format", senders)
	}
}

// TestFetchSnapshotDoesNotQueryDevicesAlreadyInBulkResult stellt sicher,
// dass die Device-gescopte Zusatzabfrage NUR für tatsächlich leer
// erscheinende Devices läuft, nicht pauschal für jedes — sonst würde
// jeder Poll-Zyklus unnötige Zusatzlast für jedes Control-Plane-Device
// ohne Medien-Ressourcen erzeugen.
func TestFetchSnapshotDoesNotQueryDevicesAlreadyInBulkResult(t *testing.T) {
	scopedQueryCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/x-nmos/query/v1.3/nodes":
			_, _ = w.Write([]byte(`[{"id":"node-1","label":"Source"}]`))
		case r.URL.Path == "/x-nmos/query/v1.3/devices":
			_, _ = w.Write([]byte(`[{"id":"dev-1","label":"Source Device","node_id":"node-1"}]`))
		case r.URL.Path == "/x-nmos/query/v1.3/senders" && r.URL.RawQuery == "":
			_, _ = w.Write([]byte(`[{"id":"send-1","label":"Sender 1","device_id":"dev-1"}]`))
		case r.URL.Path == "/x-nmos/query/v1.3/senders" && r.URL.RawQuery == "device_id=dev-1":
			scopedQueryCount++
			_, _ = w.Write([]byte(`[]`))
		case r.URL.Path == "/x-nmos/query/v1.3/receivers":
			_, _ = w.Write([]byte(`[]`))
		case r.URL.Path == "/x-nmos/query/v1.3/flows":
			_, _ = w.Write([]byte(`[]`))
		default:
			t.Errorf("unexpected request: %s?%s", r.URL.Path, r.URL.RawQuery)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, nil)
	views, err := client.FetchSnapshot(context.Background())
	if err != nil {
		t.Fatalf("FetchSnapshot() error = %v", err)
	}
	if len(views[0].Senders) != 1 {
		t.Fatalf("Senders = %+v, want the one bulk sender untouched", views[0].Senders)
	}
	if scopedQueryCount != 0 {
		t.Errorf("device-scoped sender query ran %d times, want 0 (device already had a bulk sender)", scopedQueryCount)
	}
}
