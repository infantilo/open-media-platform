package logbus

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// RunProjector liest neue Log-Zeilen vom JetStream-Stream (Publisher
// schreibt sie dorthin) und projiziert sie in store — Aufrufer gatet
// dies auf den aktuellen Raft-Leader (main.go: runWhileLeader, gleiche
// Überlegung wie placementEngine.Run, docs/decisions.md Nachtrag 149:
// ohne Gating würde jede Cluster-Instanz unabhängig dieselben Zeilen
// projizieren). Durable-Consumer-Name (logbus.consumerName) sorgt
// dafür, dass ein Leader-Wechsel am zuletzt bestätigten Offset
// weiterliest statt Zeilen zu verlieren oder zu duplizieren.
//
// nc == nil (kein NATS erreichbar) ist ein stiller No-Op — derselbe
// additive "darf fehlen"-Grundsatz wie beim Publisher.
func RunProjector(ctx context.Context, nc *nats.Conn, store *Store) {
	if nc == nil {
		return
	}
	js, err := jetstream.New(nc)
	if err != nil {
		slog.Error("logbus: jetstream init failed", "error", err)
		return
	}

	// Der Stream selbst wird vom Publisher angelegt (main.go konstruiert
	// den Publisher vor dem Projector) — hier nur abonniert, kein
	// zweiter CreateOrUpdateStream-Aufruf nötig.
	stream, err := js.Stream(ctx, StreamName)
	if err != nil {
		slog.Error("logbus: stream not available", "error", err, "stream", StreamName)
		return
	}
	consumer, err := stream.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{
		Durable:       consumerName,
		AckPolicy:     jetstream.AckExplicitPolicy,
		FilterSubject: SubjectPrefix + ">",
	})
	if err != nil {
		slog.Error("logbus: consumer setup failed", "error", err)
		return
	}

	for {
		if ctx.Err() != nil {
			return
		}
		batch, err := consumer.Fetch(50, jetstream.FetchMaxWait(2*time.Second))
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return
			}
			slog.Warn("logbus: fetch failed", "error", err)
			time.Sleep(time.Second)
			continue
		}
		for msg := range batch.Messages() {
			var e Entry
			if err := json.Unmarshal(msg.Data(), &e); err != nil {
				slog.Warn("logbus: dropping invalid entry", "error", err)
				_ = msg.Ack()
				continue
			}
			if err := store.Insert(e); err != nil {
				slog.Warn("logbus: insert failed, will redeliver", "error", err)
				_ = msg.Nak()
				continue
			}
			_ = msg.Ack()
		}
		// Ein leerer Batch nach Ablauf der Fetch-Wartezeit ist der
		// Normalfall (keine neuen Zeilen) — Fetch selbst liefert dafür
		// keinen Fehler zurück (nats.go v1.52), nur batch.Error() nach
		// Verbrauch des Kanals kann einen echten Server-/Netzwerkfehler
		// tragen, der es wert ist, geloggt zu werden.
		if err := batch.Error(); err != nil {
			slog.Warn("logbus: batch error", "error", err)
		}
	}
}
