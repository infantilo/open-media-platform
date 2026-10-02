//go:build !linux && !darwin

package nodeoptions

func diskSpace(string) (free, total uint64) { return 0, 0 }
