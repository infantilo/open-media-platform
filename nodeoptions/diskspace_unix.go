//go:build linux || darwin

package nodeoptions

import "syscall"

// diskSpace liefert freien und gesamten Platz des Dateisystems von p (0,0 wenn unbekannt).
func diskSpace(p string) (free, total uint64) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(p, &st); err != nil {
		return 0, 0
	}
	bs := uint64(st.Bsize)
	return uint64(st.Bavail) * bs, uint64(st.Blocks) * bs
}
