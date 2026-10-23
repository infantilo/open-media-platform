package jobrun

import (
	"context"
	"path/filepath"
	"strings"
	"time"
)

// Runner adaptiert den Dispatcher an die Aufrufe der Form Run(ctx, programm, args, onStderr) (review.Runner).
type Runner struct {
	D      *Dispatcher
	Caller string
	Class  Class
	Target string // "" = Standard aus der Konfiguration
}

// Run führt ffmpeg/ffprobe über den Dispatcher aus. Ein Exit-Code ≠ 0 ist ein Ergebnis, err ≠ nil ein Ausführungsfehler.
func (r *Runner) Run(ctx context.Context, name string, args []string, onStderr func(line string)) ([]byte, int, error) {
	tool := filepath.Base(name)
	in, out := InferPaths(tool, args)
	res := r.D.Run(ctx, Spec{Caller: r.Caller, Tool: tool, Args: args, Class: r.Class, Target: r.Target, Inputs: in, Outputs: out, OnStderr: onStderr})
	if res.Err != nil {
		return res.Stdout, -1, res.Err
	}
	return res.Stdout, res.ExitCode, nil
}

// InferPaths liest Ein- und Ausgabedateien aus einem Argumentvektor (für Sichtbarkeitsprüfung und Pfadumschreibung):
// ffmpeg: Werte nach -i, Ausgabe = letztes Argument, wenn es ein Dateipfad ist; ffprobe: letztes Argument.
func InferPaths(tool string, args []string) (inputs, outputs []string) {
	isPath := func(s string) bool {
		return s != "" && !strings.HasPrefix(s, "-") && s != "/dev/null" && !strings.HasPrefix(s, "pipe:") && !strings.Contains(s, "://") && (filepath.IsAbs(s))
	}
	switch tool {
	case "ffprobe":
		if n := len(args); n > 0 && isPath(args[n-1]) {
			inputs = append(inputs, args[n-1])
		}
	default:
		for i := 0; i+1 < len(args); i++ {
			if args[i] == "-i" && isPath(args[i+1]) {
				inputs = append(inputs, args[i+1])
			}
		}
		if n := len(args); n > 0 && isPath(args[n-1]) && !(n >= 2 && args[n-2] == "-i") {
			outputs = append(outputs, args[n-1])
		}
	}
	return
}

// RunTool erfüllt process.JobRunner: führt ffmpeg/ffprobe als Job der Klasse batch aus.
func (d *Dispatcher) RunTool(ctx context.Context, caller, tool string, args []string, target string, timeout time.Duration) ([]byte, []string, int, string, error) {
	in, out := InferPaths(tool, args)
	res := d.Run(ctx, Spec{Caller: caller, Tool: tool, Args: args, Target: target, Class: ClassBatch, Inputs: in, Outputs: out, TimeoutS: int(timeout.Seconds())})
	if res.Err != nil {
		return res.Stdout, res.Tail, -1, res.Host, res.Err
	}
	return res.Stdout, res.Tail, res.ExitCode, res.Host, nil
}
