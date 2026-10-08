package playout

import (
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/nodeoptions"
)

// optLauncher: Launcher-Attrappe mit Instanzen und dem Optionsschema des MXF-Players.
type optLauncher struct{ instances []launcher.Instance }

func (o optLauncher) List() []launcher.Instance { return o.instances }

func (o optLauncher) NodeOptions(t string) []nodeoptions.Option {
	if t != "omp-mxf-player" {
		return nil
	}
	return []nodeoptions.Option{
		{Key: "OMP_MEDIA_DIR", Label: "Medien", Type: nodeoptions.TypePath, PathKind: nodeoptions.PathDir, MustExist: true, Default: "data/media"},
	}
}

// memValues: gesetzte Optionswerte, Schlüssel "scope|subject|key".
type memValues struct{ m map[string]string }

func (v *memValues) Values(scope, subject string) (map[string]string, error) {
	out := map[string]string{}
	for k, val := range v.m {
		p := strings.SplitN(k, "|", 3)
		if p[0] == scope && p[1] == subject {
			out[p[2]] = val
		}
	}
	return out, nil
}

func (v *memValues) Set(scope, subject, key, value, _ string) error {
	k := scope + "|" + subject + "|" + key
	if value == "" {
		delete(v.m, k)
	} else {
		v.m[k] = value
	}
	return nil
}
