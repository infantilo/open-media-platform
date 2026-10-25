// Package hostcmd schickt Kommandos an Host-Agents signiert (Audit 2026-10-23 B2, jobwire/cmdauth.go) und liefert
// Hosts aus der Zeit vor der Signatur ihren Schlüssel einmalig nach.
package hostcmd

import (
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/infantilo/openmediaplatform/jobwire"
)

// KeyStore ist der Schlüsselspeicher (implementiert von *hosts.Store).
type KeyStore interface {
	CommandKey(hostID string) (key string, provisioned bool, err error)
	MarkProvisioned(hostID string) error
	NextKey(hostID string) (string, error)
	SetNextKey(hostID, key string) error
	PromoteNextKey(hostID string) error
}

// Conn ist die benötigte Teilmenge von *nats.Conn.
type Conn interface {
	RequestMsg(msg *nats.Msg, timeout time.Duration) (*nats.Msg, error)
}

// Signer signiert Kommandos auf Subjects der Form omp.host.<id>.cmd; alle anderen gehen unverändert hinaus.
type Signer struct {
	Conn Conn
	Keys KeyStore

	mu       sync.Mutex
	lastTry  map[string]time.Time // Provisionierungsversuche je Host (Alt-Agents nicht bei jedem Kommando erneut behelligen)
	provDone map[string]bool
}

const provisionRetry = 5 * time.Minute

// HostOf liefert die Host-ID eines Kommando-Subjects.
func HostOf(subject string) (string, bool) {
	if !strings.HasPrefix(subject, "omp.host.") || !strings.HasSuffix(subject, ".cmd") {
		return "", false
	}
	id := strings.TrimSuffix(strings.TrimPrefix(subject, "omp.host."), ".cmd")
	if id == "" || strings.Contains(id, ".") {
		return "", false
	}
	return id, true
}

// Request schickt data als Kommando; bei Kommando-Subjects signiert.
func (s *Signer) Request(subject string, data []byte, timeout time.Duration) ([]byte, error) {
	hostID, isCmd := HostOf(subject)
	if !isCmd || s.Keys == nil {
		return s.send(subject, data, nil, timeout)
	}
	key, provisioned, err := s.Keys.CommandKey(hostID)
	if err != nil {
		return nil, errors.New("hostcmd: command key unavailable: " + err.Error())
	}
	if !provisioned {
		s.provision(hostID, subject, key, timeout)
	}
	ts, nonce, sig, err := jobwire.Sign(key, subject, data, time.Now())
	if err != nil {
		return nil, err
	}
	raw, err := s.send(subject, data, signedHeader(ts, nonce, sig), timeout)
	if err != nil {
		return nil, err
	}
	// Brach eine Rotation nach der Übernahme durch den Agent ab, kennt er nur den Folgeschlüssel: einmal damit versuchen.
	if bytesContain(raw, "command signature invalid") {
		if next, nerr := s.Keys.NextKey(hostID); nerr == nil && next != "" {
			ts, nonce, sig, err := jobwire.Sign(next, subject, data, time.Now())
			if err == nil {
				if raw2, err2 := s.send(subject, data, signedHeader(ts, nonce, sig), timeout); err2 == nil && !bytesContain(raw2, "unauthorized") {
					if perr := s.Keys.PromoteNextKey(hostID); perr != nil {
						slog.Warn("hostcmd: promote next key failed", "host", hostID, "error", perr)
					}
					return raw2, nil
				}
			}
		}
	}
	return raw, nil
}

func signedHeader(ts, nonce, sig string) nats.Header {
	h := nats.Header{}
	h.Set(jobwire.HeaderTs, ts)
	h.Set(jobwire.HeaderNonce, nonce)
	h.Set(jobwire.HeaderSig, sig)
	return h
}

func bytesContain(b []byte, sub string) bool { return strings.Contains(string(b), sub) }

// Rotate ersetzt den Schlüssel des Hosts: Folgeschlüssel vormerken, mit dem bisherigen signiert an den Agent senden, nach der
// Bestätigung übernehmen. Der Host muss seinen Schlüssel schon haben.
func (s *Signer) Rotate(hostID string, timeout time.Duration) error {
	if s.Keys == nil {
		return errors.New("hostcmd: no key store")
	}
	_, provisioned, err := s.Keys.CommandKey(hostID)
	if err != nil {
		return err
	}
	if !provisioned {
		return errors.New("hostcmd: host has no command key yet (it is provisioned automatically once the host is online)")
	}
	next, err := jobwire.NewKey()
	if err != nil {
		return err
	}
	if err := s.Keys.SetNextKey(hostID, next); err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]string{"action": jobwire.ActionRotateKey, "commandKey": next})
	raw, err := s.Request(jobwire.CommandSubject(hostID), payload, timeout)
	if err != nil {
		return err
	}
	var resp struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if json.Unmarshal(raw, &resp) != nil || !resp.OK {
		return errors.New("hostcmd: host refused the rotation: " + resp.Error)
	}
	// Request hat den Folgeschlüssel schon übernommen, falls der Agent ihn bereits benutzt hat; sonst jetzt.
	return s.Keys.PromoteNextKey(hostID)
}

func (s *Signer) send(subject string, data []byte, h nats.Header, timeout time.Duration) ([]byte, error) {
	msg := &nats.Msg{Subject: subject, Data: data, Header: h}
	resp, err := s.Conn.RequestMsg(msg, timeout)
	if err != nil {
		return nil, err
	}
	return resp.Data, nil
}

// EnsureProvisioned liefert dem Host seinen Schlüssel, falls er ihn noch nicht hat (ohne auf das erste Kommando zu warten —
// verkürzt das Zeitfenster, in dem ein Alt-Host unsignierte Kommandos und eine fremde Erstprovisionierung annimmt).
func (s *Signer) EnsureProvisioned(hostID string, timeout time.Duration) {
	if s.Keys == nil {
		return
	}
	key, provisioned, err := s.Keys.CommandKey(hostID)
	if err != nil || provisioned {
		return
	}
	s.provision(hostID, jobwire.CommandSubject(hostID), key, timeout)
}

// provision übergibt dem Agent den Schlüssel (unsigniert, der Agent nimmt ihn nur ohne eigenen an). Antwort „already
// provisioned“ heißt: der Agent hat einen Schlüssel — es gilt der in der Datenbank (stimmt er nicht, scheitern Kommandos sichtbar
// mit „unauthorized“; Abhilfe: Host neu registrieren). Ein Alt-Agent kennt die Aktion nicht und bleibt unsigniert erreichbar.
func (s *Signer) provision(hostID, subject, key string, timeout time.Duration) {
	s.mu.Lock()
	if s.lastTry == nil {
		s.lastTry = map[string]time.Time{}
	}
	if time.Since(s.lastTry[hostID]) < provisionRetry {
		s.mu.Unlock()
		return
	}
	s.lastTry[hostID] = time.Now()
	s.mu.Unlock()
	payload, _ := json.Marshal(map[string]string{"action": jobwire.ActionProvisionKey, "commandKey": key})
	raw, err := s.send(subject, payload, nil, timeout)
	if err != nil {
		return // Host nicht erreichbar: beim nächsten Kommando erneut
	}
	var resp struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if json.Unmarshal(raw, &resp) != nil {
		return
	}
	if resp.OK || resp.Error == "already provisioned" {
		if err := s.Keys.MarkProvisioned(hostID); err != nil {
			slog.Warn("hostcmd: mark provisioned failed", "host", hostID, "error", err)
		}
		if resp.OK {
			slog.Info("hostcmd: command key delivered to host agent", "host", hostID)
		}
		return
	}
	slog.Info("hostcmd: host agent did not accept a command key (older agent?) — commands stay unauthenticated on that host", "host", hostID, "reply", resp.Error)
}
