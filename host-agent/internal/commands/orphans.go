package commands

import (
	"bytes"
	"log/slog"
	"os"
	"strconv"
	"syscall"
	"time"
)

// orphanPIDs sucht Prozesse, die mit OMP_INSTANCE_ID=<instanceID> gestartet wurden, aber nicht (mehr) von diesem
// Agent geführt werden. Das passiert, wenn der Agent ohne seine Kindprozesse beendet wurde (Start ohne systemd,
// SIGKILL): der neue Agent kennt sie nicht, ein erneuter Start derselben Instanz liefe dann doppelt — zwei Nodes
// mit derselben Instanz-ID und denselben Flow-IDs. procRoot ist "/proc" (Parameter nur für Tests).
func orphanPIDs(procRoot, instanceID string) []int {
	if instanceID == "" {
		return nil
	}
	entries, err := os.ReadDir(procRoot)
	if err != nil {
		return nil
	}
	needle := []byte("OMP_INSTANCE_ID=" + instanceID)
	self := os.Getpid()
	var out []int
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == self {
			continue
		}
		env, err := os.ReadFile(procRoot + "/" + e.Name() + "/environ") // fremde Benutzer: nicht lesbar, übersprungen
		if err != nil {
			continue
		}
		for _, kv := range bytes.Split(env, []byte{0}) {
			if bytes.Equal(kv, needle) {
				out = append(out, pid)
				break
			}
		}
	}
	return out
}

// reapOrphans beendet verwaiste Prozesse einer Instanz, bevor sie neu gestartet wird (SIGTERM, nach grace SIGKILL).
// Kindprozesse eines Nodes erben dessen Umgebung und werden mit erfasst.
func reapOrphans(instanceID string, grace time.Duration) {
	pids := orphanPIDs("/proc", instanceID)
	if len(pids) == 0 {
		return
	}
	slog.Warn("host-agent: orphaned processes of this instance found, stopping them before the start", "instance_id", instanceID, "pids", pids)
	for _, pid := range pids {
		_ = syscall.Kill(pid, syscall.SIGTERM)
	}
	deadline := time.Now().Add(grace)
	for time.Now().Before(deadline) {
		alive := false
		for _, pid := range pids {
			if syscall.Kill(pid, 0) == nil {
				alive = true
			}
		}
		if !alive {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	for _, pid := range pids {
		_ = syscall.Kill(pid, syscall.SIGKILL)
	}
	time.Sleep(100 * time.Millisecond)
}
