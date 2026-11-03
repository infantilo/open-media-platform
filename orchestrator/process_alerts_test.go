package main

import (
	"testing"
	"time"
)

type recPub struct{ subjects []string }

func (r *recPub) Publish(subject string, _ []byte) error {
	r.subjects = append(r.subjects, subject)
	return nil
}

func TestProcessAlertPublisherOnlyFailedAlerts(t *testing.T) {
	inner := &recPub{}
	got := make(chan string, 4)
	p := processAlertPublisher{inner: inner, onFailed: func(id string) { got <- id }}
	for _, s := range []string{"omp.process.e1.completed", "omp.process.e2.failed", "omp.asset.x.failed"} {
		if err := p.Publish(s, []byte(`{}`)); err != nil {
			t.Fatal(err)
		}
	}
	select {
	case id := <-got:
		if id != "e2" {
			t.Fatalf("Ausführung %q", id)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("kein Alarm für failed")
	}
	select {
	case id := <-got:
		t.Fatalf("unerwarteter Alarm für %q", id)
	case <-time.After(200 * time.Millisecond):
	}
	if len(inner.subjects) != 3 {
		t.Fatalf("Ereignisse müssen unverändert weitergehen: %v", inner.subjects)
	}
	if err := (processAlertPublisher{}).Publish("omp.process.e.failed", nil); err != nil {
		t.Fatal(err)
	}
}
