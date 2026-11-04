package jobwire

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Hängende Mounts (Kapitel 86): Ein NFS-/SMB-Mount, der nicht antwortet, lässt `stat`/`readdir` unbegrenzt blockieren. Dateioperationen laufen
// deshalb in einer eigenen Goroutine mit Frist. Läuft die Frist ab, kommt SOFORT ein Fehler zurück (der Aufrufer wird nie blockiert); die
// blockierte Goroutine bleibt, bis das Dateisystem antwortet. Solange sie hängt, weist jede weitere Operation auf derselben Wurzel sofort ab
// (höchstens eine hängende Goroutine je Wurzel — kein Anhäufen von Threads).

// MountHungText steht in jeder Fehlermeldung eines hängenden Mounts (der Orchestrator erkennt die Art daran, auch über NATS).
const MountHungText = "Mount hängt"

// ErrMountHung: die Operation hat die Frist überschritten oder die Wurzel hängt noch von einer früheren Operation.
var ErrMountHung = errors.New(MountHungText)

// IsMountHung erkennt den Fehler auch dann, wenn er nur als Text (über NATS) ankam.
func IsMountHung(err error) bool {
	return err != nil && (errors.Is(err, ErrMountHung) || strings.Contains(err.Error(), MountHungText))
}

// Fristen je Art der Operation. Lesende Operationen müssen unter der NATS-Frist des Orchestrators (5 s) bleiben.
const (
	ReadOpTimeout  = 3500 * time.Millisecond
	WriteOpTimeout = 25 * time.Second
	// WriteOpNATSTimeout: Frist des Orchestrators für ändernde Operationen über NATS (etwas über WriteOpTimeout).
	WriteOpNATSTimeout = 30 * time.Second
)

// OpTimeout liefert die Frist einer Operation.
func OpTimeout(op string) time.Duration {
	switch op {
	case FileOpTrash, FileOpRestore, FileOpPurge:
		return WriteOpTimeout
	}
	return ReadOpTimeout
}

type stuckState struct {
	since time.Time
	done  chan struct{}
}

var (
	stuckMu sync.Mutex
	stuck   = map[string]*stuckState{}
	// runner: austauschbar für Tests.
	runner = RunFileOp
)

// RunFileOpTimeout führt die Operation mit Frist aus (siehe oben). timeout <= 0: Standardfrist der Operation.
// Gleichzeitige Operationen auf derselben Wurzel sind erlaubt; als hängend gilt erst eine Operation, die ihre Frist überschritten hat.
func RunFileOpTimeout(op FileOp, timeout time.Duration) ([]byte, error) {
	if timeout <= 0 {
		timeout = OpTimeout(op.Op)
	}
	key := op.Root
	stuckMu.Lock()
	if s, ok := stuck[key]; ok {
		select {
		case <-s.done:
			delete(stuck, key)
		default:
			since := s.since
			stuckMu.Unlock()
			return nil, fmt.Errorf("%w: %s seit %s ohne Antwort", ErrMountHung, op.Root, since.Format("15:04:05"))
		}
	}
	stuckMu.Unlock()
	type res struct {
		out []byte
		err error
	}
	ch := make(chan res, 1)
	st := &stuckState{since: time.Now(), done: make(chan struct{})}
	go func() {
		defer func() {
			if p := recover(); p != nil {
				ch <- res{nil, fmt.Errorf("Dateioperation abgestürzt: %v", p)}
			}
			close(st.done)
		}()
		out, err := runner(op)
		ch <- res{out, err}
	}()
	select {
	case r := <-ch:
		return r.out, r.err
	case <-time.After(timeout):
		stuckMu.Lock()
		if _, ok := stuck[key]; !ok {
			stuck[key] = st // erst jetzt gilt die Wurzel als hängend; weitere Operationen werden sofort abgewiesen
		}
		stuckMu.Unlock()
		return nil, fmt.Errorf("%w: %s antwortet nicht innerhalb von %s", ErrMountHung, op.Root, timeout.Round(100*time.Millisecond))
	}
}
