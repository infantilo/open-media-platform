package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"time"
)

// FrameSource liefert ein JPEG-Einzelbild einer Kamera. Gesichter werden aus
// der Vorschau der Quell-Node gelesen (`GET /preview`, 1 Bild pro Request):
// reines Go ohne CGO, kein Eingriff in den MXL-Fluss, und die Vorschau läuft
// ohnehin mit niedriger Auflösung.
type FrameSource interface {
	Frame(ctx context.Context) ([]byte, error)
}

type previewSource struct {
	url    string
	client *http.Client
}

func newPreviewSource(url string) *previewSource {
	return &previewSource{url: url, client: &http.Client{Timeout: 2 * time.Second}}
}

func (p *previewSource) Frame(ctx context.Context) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("vorschau %s: HTTP %d", p.url, resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 4<<20))
}
