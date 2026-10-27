// Package clocksync liest und stellt die Systemuhr (Audit 2026-10-23 M1): MXL und die Schaltzeitpunkte (takeAt) rechnen in TAI; ohne gesetzten
// TAI-Versatz fällt CLOCK_TAI mit UTC zusammen (derzeit 37 s daneben), ohne Synchronisation laufen die Uhren der Hosts auseinander.
//
// Run stellt beides von selbst, wenn nichts anderes es tut: ist der Versatz 0, setzt es ihn (adjtimex ADJ_TAI); meldet der Kernel die
// Uhr als unsynchronisiert (kein chrony/ntpd/timesyncd/ptp4l hat sie im Griff), fragt es per SNTP die Server aus OMP_CLOCK_NTP_SERVERS
// und gleicht ab — kleine Abweichungen langsam (Slew), große mit einem Sprung (Step). Das braucht CAP_SYS_TIME (root oder
// AmbientCapabilities=CAP_SYS_TIME); ohne die Berechtigung bleibt es bei einer Meldung (Fix = "no-permission"). Ein laufender
// Zeitdienst hat Vorrang: ist die Uhr synchron, rührt Run sie nicht an (nur den TAI-Versatz, falls 0).
package clocksync

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// State ist der Zustand der Systemuhr.
type State struct {
	// Synced: der Kernel meldet die Uhr als synchronisiert (kein STA_UNSYNC).
	Synced bool `json:"synced"`
	// MaxErrorUs/EstErrorUs: obere Grenze und Schätzung des Zeitfehlers in µs.
	MaxErrorUs int64 `json:"maxErrorUs"`
	EstErrorUs int64 `json:"estErrorUs"`
	// TAIOffsetS: TAI − UTC in Sekunden; 0 = nicht gesetzt.
	TAIOffsetS int `json:"taiOffsetS"`
}

const (
	staUnsync = 0x0040 // STA_UNSYNC
	staNano   = 0x2000 // STA_NANO (Offset in ns statt µs)
	timeError = 5      // TIME_ERROR

	admOffset    = 0x0001
	admMaxError  = 0x0004
	admEstError  = 0x0008
	admStatus    = 0x0010
	admTAI       = 0x0080
	admSetOffset = 0x0100
	admNano      = 0x2000

	// stepThreshold: ab dieser Abweichung wird gesprungen statt gestellt.
	stepThreshold = 128 * time.Millisecond
	// maxSlew: größter Wert für ADJ_OFFSET (Kernel begrenzt auf ±500 ms).
	maxSlew = 500 * time.Millisecond
)

var adjtimex = syscall.Adjtimex

// Read liest den Uhrzustand, ohne die Uhr zu verändern. ok=false, wenn der Aufruf scheitert.
func Read() (State, bool) {
	var tx syscall.Timex
	state, err := adjtimex(&tx)
	if err != nil {
		return State{}, false
	}
	return stateFrom(state, int(tx.Status), int64(tx.Maxerror), int64(tx.Esterror), int(tx.Tai)), true
}

func stateFrom(state, status int, maxErr, estErr int64, tai int) State {
	return State{Synced: state != timeError && status&staUnsync == 0, MaxErrorUs: maxErr, EstErrorUs: estErr, TAIOffsetS: tai}
}

var (
	fixMu sync.Mutex
	fix   string
)

// Fix beschreibt, was Run zuletzt getan hat oder warum nicht: "" (nichts nötig/noch nichts versucht), "tai-set", "stepped", "slewed",
// "no-permission" (CAP_SYS_TIME fehlt), "no-server" (kein NTP-Server antwortete), "off" (abgeschaltet).
func Fix() string {
	fixMu.Lock()
	defer fixMu.Unlock()
	return fix
}

func setFix(f string) {
	fixMu.Lock()
	fix = f
	fixMu.Unlock()
}

// Config steuert Run.
type Config struct {
	Servers   []string      // NTP-Server (host oder host:port)
	TAIOffset int           // Sekunden; 0 = nicht setzen
	Interval  time.Duration // Prüfabstand
	Off       bool
}

// ConfigFromEnv: OMP_CLOCK_DISCIPLINE (auto|off), OMP_CLOCK_NTP_SERVERS (Komma-Liste, Standard pool.ntp.org), OMP_CLOCK_TAI_OFFSET (Standard 37).
func ConfigFromEnv() Config {
	c := Config{Servers: []string{"pool.ntp.org"}, TAIOffset: 37, Interval: time.Minute}
	if strings.EqualFold(os.Getenv("OMP_CLOCK_DISCIPLINE"), "off") {
		c.Off = true
	}
	if v, ok := os.LookupEnv("OMP_CLOCK_NTP_SERVERS"); ok {
		c.Servers = nil
		for _, s := range strings.Split(v, ",") {
			if s = strings.TrimSpace(s); s != "" {
				c.Servers = append(c.Servers, s)
			}
		}
	}
	if v, err := strconv.Atoi(os.Getenv("OMP_CLOCK_TAI_OFFSET")); err == nil && v >= 0 {
		c.TAIOffset = v
	}
	return c
}

// Run prüft sofort und dann alle cfg.Interval, bis ctx endet.
func Run(ctx context.Context, cfg Config) {
	if cfg.Off {
		setFix("off")
		return
	}
	if cfg.Interval <= 0 {
		cfg.Interval = time.Minute
	}
	t := time.NewTicker(cfg.Interval)
	defer t.Stop()
	warned := false
	for {
		if err := Once(cfg); err != nil && !warned {
			warned = true
			slog.Warn("clocksync: Uhr nicht gestellt", "error", err, "hint", "CAP_SYS_TIME nötig: root, AmbientCapabilities=CAP_SYS_TIME oder einen Zeitdienst (chrony) einsetzen")
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Once führt einen Prüf- und Stellschritt aus.
func Once(cfg Config) error {
	st, ok := Read()
	if !ok {
		return errors.New("adjtimex nicht lesbar")
	}
	if st.TAIOffsetS == 0 && cfg.TAIOffset > 0 {
		tx := syscall.Timex{Modes: admTAI, Constant: int64(cfg.TAIOffset)}
		if _, err := adjtimex(&tx); err != nil {
			return permission(err)
		}
		setFix("tai-set")
		slog.Info("clocksync: TAI-Versatz gesetzt", "seconds", cfg.TAIOffset)
	}
	if st.Synced || len(cfg.Servers) == 0 {
		return nil
	}
	off, rtt, err := Query(cfg.Servers, 2*time.Second)
	if err != nil {
		setFix("no-server")
		return err
	}
	return apply(off, rtt)
}

func permission(err error) error {
	if errors.Is(err, syscall.EPERM) {
		setFix("no-permission")
	}
	return err
}

// apply stellt die Uhr um off (Server − lokal) und markiert sie als synchron.
func apply(off, rtt time.Duration) error {
	abs := off
	if abs < 0 {
		abs = -abs
	}
	if abs >= stepThreshold {
		sec, nsec := int64(off/time.Second), int64(off%time.Second)
		if nsec < 0 {
			sec--
			nsec += int64(time.Second)
		}
		tx := syscall.Timex{Modes: admSetOffset | admNano}
		tx.Time.Sec, tx.Time.Usec = sec, nsec // mit ADJ_NANO: Nanosekunden
		if _, err := adjtimex(&tx); err != nil {
			return permission(err)
		}
		setFix("stepped")
	} else {
		if abs > maxSlew {
			abs = maxSlew
		}
		tx := syscall.Timex{Modes: admOffset}
		tx.Offset = int64(off / time.Microsecond)
		if _, err := adjtimex(&tx); err != nil {
			return permission(err)
		}
		setFix("slewed")
	}
	// Als synchron markieren (STA_UNSYNC löschen) und den Fehlerrahmen auf das setzen, was die Messung hergibt.
	bound := int64(abs/time.Microsecond) + int64(rtt/time.Microsecond)/2 + 1000
	var cur syscall.Timex
	if _, err := adjtimex(&cur); err != nil {
		return err
	}
	tx := syscall.Timex{Modes: admStatus | admMaxError | admEstError, Status: cur.Status &^ staUnsync, Maxerror: bound, Esterror: bound / 2}
	if _, err := adjtimex(&tx); err != nil {
		return permission(err)
	}
	slog.Info("clocksync: Uhr abgeglichen", "fix", Fix(), "offset", off.String(), "rtt", rtt.String())
	return nil
}

// Query fragt die Server der Reihe nach und liefert Abweichung (Server − lokal) und Laufzeit des ersten brauchbaren.
func Query(servers []string, timeout time.Duration) (offset, rtt time.Duration, err error) {
	var last error
	for _, s := range servers {
		if !strings.Contains(s, ":") || strings.HasSuffix(s, "]") {
			s = net.JoinHostPort(strings.Trim(s, "[]"), "123")
		}
		off, r, e := queryOne(s, timeout)
		if e == nil {
			return off, r, nil
		}
		last = fmt.Errorf("%s: %w", s, e)
	}
	if last == nil {
		last = errors.New("kein NTP-Server konfiguriert")
	}
	return 0, 0, last
}

func queryOne(addr string, timeout time.Duration) (time.Duration, time.Duration, error) {
	conn, err := net.DialTimeout("udp", addr, timeout)
	if err != nil {
		return 0, 0, err
	}
	defer conn.Close()
	req := make([]byte, 48)
	req[0] = 0<<6 | 4<<3 | 3 // LI 0, VN 4, Mode 3 (Client)
	t1 := time.Now()
	binary.BigEndian.PutUint64(req[40:], toNTP(t1))
	_ = conn.SetDeadline(time.Now().Add(timeout))
	if _, err := conn.Write(req); err != nil {
		return 0, 0, err
	}
	resp := make([]byte, 48)
	n, err := conn.Read(resp)
	t4 := time.Now()
	if err != nil {
		return 0, 0, err
	}
	return parseSNTP(resp[:n], t1, t4)
}

// parseSNTP wertet eine Serverantwort aus; t1 = Sendezeit, t4 = Empfangszeit (lokal).
func parseSNTP(resp []byte, t1, t4 time.Time) (offset, rtt time.Duration, err error) {
	if len(resp) < 48 {
		return 0, 0, errors.New("antwort zu kurz")
	}
	li, mode, stratum := resp[0]>>6, resp[0]&7, resp[1]
	switch {
	case mode != 4 && mode != 5:
		return 0, 0, errors.New("keine Serverantwort")
	case li == 3 || stratum == 0 || stratum > 15:
		return 0, 0, errors.New("server nicht synchron")
	}
	if binary.BigEndian.Uint64(resp[24:]) != toNTP(t1) {
		return 0, 0, errors.New("antwort gehört zu keiner Anfrage")
	}
	t2, t3 := fromNTP(binary.BigEndian.Uint64(resp[32:])), fromNTP(binary.BigEndian.Uint64(resp[40:]))
	if t3.IsZero() {
		return 0, 0, errors.New("server ohne Sendezeit")
	}
	offset = (t2.Sub(t1) + t3.Sub(t4)) / 2
	rtt = t4.Sub(t1) - t3.Sub(t2)
	return offset, rtt, nil
}

const ntpEpochOffset = 2208988800 // Sekunden 1900 → 1970

func toNTP(t time.Time) uint64 {
	sec := uint64(t.Unix() + ntpEpochOffset)
	frac := uint64(t.Nanosecond()) << 32 / uint64(time.Second)
	return sec<<32 | frac
}

func fromNTP(v uint64) time.Time {
	sec, frac := int64(v>>32), int64(v&0xffffffff)
	if sec == 0 && frac == 0 {
		return time.Time{}
	}
	return time.Unix(sec-ntpEpochOffset, frac*int64(time.Second)>>32)
}
