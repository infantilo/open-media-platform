package jobrun

import (
	"time"

	"github.com/nats-io/nats.go"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/hostcmd"
)

// NATSBus legt eine NATS-Verbindung hinter [Bus].
type NATSBus struct {
	Conn *nats.Conn
	// Signer signiert Kommandos an Host-Agents (nil = unsigniert).
	Signer *hostcmd.Signer
}

func (b NATSBus) Request(subject string, data []byte, timeout time.Duration) ([]byte, error) {
	if b.Signer != nil {
		return b.Signer.Request(subject, data, timeout)
	}
	msg, err := b.Conn.Request(subject, data, timeout)
	if err != nil {
		return nil, err
	}
	return msg.Data, nil
}

func (b NATSBus) Subscribe(subject string, cb func([]byte)) (func(), error) {
	sub, err := b.Conn.Subscribe(subject, func(m *nats.Msg) { cb(m.Data) })
	if err != nil {
		return nil, err
	}
	return func() { _ = sub.Unsubscribe() }, nil
}
