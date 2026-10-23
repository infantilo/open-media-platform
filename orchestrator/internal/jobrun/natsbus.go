package jobrun

import (
	"time"

	"github.com/nats-io/nats.go"
)

// NATSBus legt eine NATS-Verbindung hinter [Bus].
type NATSBus struct{ Conn *nats.Conn }

func (b NATSBus) Request(subject string, data []byte, timeout time.Duration) ([]byte, error) {
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
