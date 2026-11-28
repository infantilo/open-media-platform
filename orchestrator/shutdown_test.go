package main

import (
	"net"
	"net/http"
	"testing"
	"time"
)

func TestDrainEndsLongLivedRequests(t *testing.T) {
	started, ended := make(chan struct{}), make(chan struct{})
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done() // wie der SSE-Handler
		close(ended)
	})}
	endRequests := cancellableRequests(srv)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = srv.Serve(listener) }()
	resp, err := http.Get("http://" + listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	<-started

	begin := time.Now()
	drain(srv, endRequests, 100*time.Millisecond, 5*time.Second)
	if took := time.Since(begin); took > 2*time.Second {
		t.Fatalf("drain dauerte %s", took)
	}
	select {
	case <-ended:
	case <-time.After(time.Second):
		t.Fatal("Anfrage wurde nicht beendet")
	}
}
