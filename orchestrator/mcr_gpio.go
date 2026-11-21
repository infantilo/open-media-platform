package main

import (
	"context"
	"fmt"
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

// mcrGPIO setzt einen Kontaktausgang eines `omp-gpio`-Nodes (Methode `setOutput`, CONTRACT-GPIO.md). Das Ziel ist die Instanz-ID, die
// Node-ID oder die Bezeichnung eines laufenden Nodes.
type mcrGPIO struct {
	nodes interface{ List() []registry.NodeView }
	do    func(ctx context.Context, method, url string, body any) ([]byte, int, error)
}

func (g mcrGPIO) Set(ctx context.Context, target string, pin int, level bool) error {
	for _, n := range g.nodes.List() {
		if !n.Online || n.APIBaseURL == "" {
			continue
		}
		if n.InstanceID != target && n.ID != target && n.Label != target {
			continue
		}
		b, code, err := g.do(ctx, http.MethodPost, n.APIBaseURL+"/methods/setOutput", map[string]any{"pin": pin, "level": level})
		if err != nil {
			return err
		}
		if code >= 300 {
			return fmt.Errorf("setOutput: HTTP %d %s", code, b)
		}
		return nil
	}
	return fmt.Errorf("Kontaktausgang: kein laufender Node „%s“", target)
}
