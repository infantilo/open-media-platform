package jobrun

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

var errTimeout = errors.New("Zeitlimit überschritten")

const maxStdout = 32 << 20

// startLocal startet den Job als Prozess des Orchestrators (nice/ionice, eigene Prozessgruppe für Pause/Abbruch).
func (d *Dispatcher) startLocal(e *entry, gen int, args []string, parts [][2]string, cfg Config) error {
	bin := ""
	if d.LocalTool != nil {
		bin = d.LocalTool(e.spec.Tool)
	}
	if bin == "" {
		return fmt.Errorf("%s ist auf dem Orchestrator-Rechner nicht installiert", e.spec.Tool)
	}
	nice := cfg.Local.Nice
	if nice <= 0 {
		nice = 10
	}
	argv := []string{bin}
	argv = append(argv, args...)
	if p, err := exec.LookPath("ionice"); err == nil {
		argv = append([]string{p, "-c3"}, argv...)
	}
	if p, err := exec.LookPath("nice"); err == nil {
		argv = append([]string{p, "-n", fmt.Sprint(nice)}, argv...)
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	out := &limitBuffer{max: maxStdout}
	cmd.Stdout = out
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	pgid := cmd.Process.Pid
	var mu sync.Mutex
	timedOut := false
	kill := func() {
		_ = syscall.Kill(-pgid, syscall.SIGCONT)
		_ = syscall.Kill(-pgid, syscall.SIGTERM)
		time.AfterFunc(3*time.Second, func() { _ = syscall.Kill(-pgid, syscall.SIGKILL) })
	}
	var timer *time.Timer
	if e.spec.TimeoutS > 0 {
		timer = time.AfterFunc(time.Duration(e.spec.TimeoutS)*time.Second, func() {
			mu.Lock()
			timedOut = true
			mu.Unlock()
			kill()
		})
	}
	if !d.markStarted(e, gen, kill,
		func(on bool) error {
			sig := syscall.SIGCONT
			if on {
				sig = syscall.SIGSTOP
			}
			return syscall.Kill(-pgid, sig)
		},
		func(n int) error { return syscall.Setpriority(syscall.PRIO_PGRP, pgid, n) },
	) {
		kill()
	}
	go func() {
		var tail []string
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 64<<10), 1<<20)
		sc.Split(splitCRLF)
		last := time.Time{}
		for sc.Scan() {
			l := sc.Text()
			if l == "" {
				continue
			}
			tail = append(tail, l)
			if len(tail) > 40 {
				tail = tail[len(tail)-40:]
			}
			if e.spec.OnStderr != nil {
				e.spec.OnStderr(l)
			}
			if time.Since(last) >= time.Second {
				last = time.Now()
				d.setProgress(e, gen, l)
			}
		}
		_, _ = io.Copy(io.Discard, stderr)
		waitErr := cmd.Wait()
		if timer != nil {
			timer.Stop()
		}
		mu.Lock()
		to := timedOut
		mu.Unlock()
		exit := 0
		var execErr error
		var ee *exec.ExitError
		switch {
		case to:
			exit, execErr = -1, errTimeout
		case errors.As(waitErr, &ee):
			exit = ee.ExitCode()
			if ee.ExitCode() < 0 { // Signal
				exit, execErr = -1, errors.New("durch Signal beendet")
			}
		case waitErr != nil:
			exit, execErr = -1, waitErr
		}
		d.completed(e, gen, LocalHostID, exit, out.b, tail, execErr, parts, cfg)
	}()
	return nil
}

func splitCRLF(data []byte, atEOF bool) (int, []byte, error) {
	if atEOF && len(data) == 0 {
		return 0, nil, nil
	}
	if i := bytes.IndexAny(data, "\r\n"); i >= 0 {
		return i + 1, data[:i], nil
	}
	if atEOF {
		return len(data), data, nil
	}
	return 0, nil, nil
}
