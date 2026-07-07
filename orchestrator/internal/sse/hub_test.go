package sse

import (
	"testing"
	"time"
)

func TestHubBroadcastDeliversToSubscriber(t *testing.T) {
	h := NewHub()
	ch, cancel := h.Subscribe()
	defer cancel()

	h.Broadcast(Event{Type: "test.event", Data: []byte(`{"ok":true}`)})

	select {
	case ev := <-ch:
		if ev.Type != "test.event" {
			t.Errorf("Type = %q, want test.event", ev.Type)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for broadcast event")
	}
}

func TestHubBroadcastFansOutToMultipleSubscribers(t *testing.T) {
	h := NewHub()
	ch1, cancel1 := h.Subscribe()
	defer cancel1()
	ch2, cancel2 := h.Subscribe()
	defer cancel2()

	h.Broadcast(Event{Type: "test.event"})

	for i, ch := range []<-chan Event{ch1, ch2} {
		select {
		case <-ch:
		case <-time.After(time.Second):
			t.Fatalf("subscriber %d did not receive event", i)
		}
	}
}

func TestHubCancelStopsDelivery(t *testing.T) {
	h := NewHub()
	ch, cancel := h.Subscribe()
	cancel()

	h.Broadcast(Event{Type: "test.event"})

	if _, ok := <-ch; ok {
		t.Fatal("expected channel to be closed after cancel")
	}
}

func TestHubBroadcastDoesNotBlockOnFullBuffer(t *testing.T) {
	h := NewHub()
	_, cancel := h.Subscribe()
	defer cancel()

	done := make(chan struct{})
	go func() {
		for i := 0; i < 100; i++ {
			h.Broadcast(Event{Type: "flood"})
		}
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Broadcast blocked on a slow/unread subscriber")
	}
}
