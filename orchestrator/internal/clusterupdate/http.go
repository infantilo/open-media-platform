package clusterupdate

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/cluster"
)

// Interne Mitglieds-Routen (Authentisierung: HMAC aus dem gemeinsamen JWT-Geheimnis, dazu Term-Fencing bei Apply).
const (
	PathInfo  = "/api/v1/internal/cluster-update/info"
	PathFetch = "/api/v1/internal/cluster-update/fetch"
	PathApply = "/api/v1/internal/cluster-update/apply"
	// TokenHeader trägt das abgeleitete Token.
	TokenHeader = "X-OMP-Cluster-Update"
)

// DeriveToken leitet das Mitglieds-Token aus dem gemeinsamen Geheimnis ab (eigene Domäne, getrennt vom Node-Token).
func DeriveToken(secret []byte) string {
	if len(secret) == 0 {
		return ""
	}
	m := hmac.New(sha256.New, secret)
	m.Write([]byte("omp-cluster-update-v1"))
	return hex.EncodeToString(m.Sum(nil))
}

// TokenValid vergleicht in konstanter Zeit; ein leeres Soll-Token akzeptiert nichts.
func TokenValid(want, got string) bool {
	return want != "" && hmac.Equal([]byte(want), []byte(got))
}

// Drahtformate.
type InfoResponse struct {
	Version   string         `json:"version"`
	StartedAt time.Time      `json:"startedAt"`
	Status    cluster.Status `json:"status"`
}

type FetchRequest struct {
	PackageID string `json:"packageId"`
	URL       string `json:"url"` // Download beim Koordinator (Einmal-Token)
}

type ApplyRequest struct {
	Kind      Kind   `json:"kind"`
	PackageID string `json:"packageId,omitempty"`
	Version   string `json:"version,omitempty"`
	Term      uint64 `json:"term"`
}

// HTTPMembers spricht die anderen Orchestratoren über die internen Routen an.
type HTTPMembers struct {
	Client *http.Client
	Token  string
	// IssueURL liefert die Download-URL (samt Einmal-Token) des Pakets beim Koordinator.
	IssueURL func(packageID string) string
}

func (h *HTTPMembers) client(timeout time.Duration) *http.Client {
	c := http.DefaultClient
	if h.Client != nil {
		c = h.Client
	}
	cp := *c
	cp.Timeout = timeout
	return &cp
}

func (h *HTTPMembers) do(ctx context.Context, method, base, path string, in, out any, timeout time.Duration) error {
	var body io.Reader
	if in != nil {
		b, _ := json.Marshal(in)
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(base, "/")+path, body)
	if err != nil {
		return err
	}
	req.Header.Set(TokenHeader, h.Token)
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := h.client(timeout).Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode/100 != 2 {
		return fmt.Errorf("%s: %d %s", path, res.StatusCode, strings.TrimSpace(string(data)))
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

// Info implementiert Members.
func (h *HTTPMembers) Info(ctx context.Context, httpAddr string) (Info, error) {
	var raw struct {
		Version   string          `json:"version"`
		StartedAt time.Time       `json:"startedAt"`
		Status    json.RawMessage `json:"status"`
	}
	if err := h.do(ctx, http.MethodGet, httpAddr, PathInfo, nil, &raw, 5*time.Second); err != nil {
		return Info{}, err
	}
	info := Info{Version: raw.Version, StartedAt: raw.StartedAt}
	if err := json.Unmarshal(raw.Status, &info.Status); err != nil {
		return Info{}, err
	}
	return info, nil
}

// Fetch implementiert Members.
func (h *HTTPMembers) Fetch(ctx context.Context, httpAddr, packageID string) error {
	if h.IssueURL == nil {
		return fmt.Errorf("keine Download-URL konfiguriert")
	}
	return h.do(ctx, http.MethodPost, httpAddr, PathFetch, FetchRequest{PackageID: packageID, URL: h.IssueURL(packageID)}, nil, 10*time.Minute)
}

// Apply implementiert Members.
func (h *HTTPMembers) Apply(ctx context.Context, httpAddr string, kind Kind, packageID, version string, term uint64) error {
	return h.do(ctx, http.MethodPost, httpAddr, PathApply, ApplyRequest{Kind: kind, PackageID: packageID, Version: version, Term: term}, nil, 30*time.Second)
}
