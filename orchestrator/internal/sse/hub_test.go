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

// drain liest alle aktuell im Puffer wartenden Events, ohne zu blockieren
// (S2-Tests unten müssen den Puffer gezielt leeren, bevor sie das
// Verhalten nach dem Leerwerden prüfen).
func drain(ch <-chan Event) {
	for {
		select {
		case <-ch:
		default:
			return
		}
	}
}

// registerClient meldet einen Client wie Subscribe an, gibt aber den
// bidirektionalen chan Event statt des nach außen verengten <-chan Event
// zurück — nötig, damit Whitebox-Tests unten sowohl lesen als auch
// h.dropped[ch] direkt prüfen können (Subscribe()s Rückgabetyp erlaubt
// letzteres nicht mehr, <-chan Event kann nicht zurück zu chan Event
// konvertiert werden).
func registerClient(h *Hub) chan Event {
	ch := make(chan Event, 16)
	h.mu.Lock()
	h.clients[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func TestHubBroadcastMarksDroppedOnFullBuffer(t *testing.T) {
	h := NewHub()
	ch := registerClient(h)
	defer h.unsubscribe(ch)

	for i := 0; i < 100; i++ {
		h.Broadcast(Event{Type: "flood"})
	}

	h.mu.Lock()
	dropped := h.dropped[ch]
	h.mu.Unlock()
	if !dropped {
		t.Fatal("dropped[ch] = false after flooding past buffer capacity, want true")
	}
}

func TestHubBroadcastSignalsLostEventsOnNextRoomAvailable(t *testing.T) {
	h := NewHub()
	ch := registerClient(h)
	defer h.unsubscribe(ch)

	for i := 0; i < 100; i++ {
		h.Broadcast(Event{Type: "flood"})
	}
	drain(ch) // Platz schaffen, wie ein Client, der wieder mitliest

	h.Broadcast(Event{Type: "after-drop"})

	select {
	case ev := <-ch:
		if ev.Type != "lost-events" {
			t.Fatalf("first event after drain = %q, want lost-events", ev.Type)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for lost-events event")
	}

	select {
	case ev := <-ch:
		if ev.Type != "after-drop" {
			t.Fatalf("second event after drain = %q, want after-drop", ev.Type)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for after-drop event")
	}

	h.mu.Lock()
	dropped := h.dropped[ch]
	h.mu.Unlock()
	if dropped {
		t.Error("dropped[ch] still true after lost-events was successfully delivered, want false")
	}
}

func TestHubUnsubscribeClearsDroppedState(t *testing.T) {
	h := NewHub()
	ch := registerClient(h)

	for i := 0; i < 100; i++ {
		h.Broadcast(Event{Type: "flood"})
	}
	h.mu.Lock()
	dropped := h.dropped[ch]
	h.mu.Unlock()
	if !dropped {
		t.Fatal("precondition failed: dropped[ch] should be true before unsubscribe")
	}

	h.unsubscribe(ch)

	h.mu.Lock()
	_, stillTracked := h.dropped[ch]
	h.mu.Unlock()
	if stillTracked {
		t.Error("dropped still tracks the channel after unsubscribe, want it removed (leak)")
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
