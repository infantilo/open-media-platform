package telemetry

import (
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Physische Netzwerkkarten des Hosts aus /sys (Kap. 76): Hersteller, Treiber, Link, PTP-Hardware-
// Uhr, RDMA und welche Kernel-Bypass-Wege (Intel MTL/DPDK, AF_XDP) die Karte
// grundsätzlich zulässt. Es ist eine Fähigkeitsangabe aus Treiber/Gerätekennung — ob
// DPDK eingerichtet ist, prüft die Karte nicht (siehe omp-mediaio::kbypass).
// Die Datei steht bewusst nur im host-agent; der Orchestrator bekommt das Ergebnis per Telemetrie.

// NicInfo beschreibt eine physische Netzwerkschnittstelle.
type NicInfo struct {
	Name      string `json:"name"`
	Vendor    string `json:"vendor"` // "NVIDIA Mellanox", "Intel", "" = unbekannt
	Driver    string `json:"driver,omitempty"`
	PCI       string `json:"pci,omitempty"`
	DeviceID  string `json:"deviceId,omitempty"`
	Up        bool   `json:"up"`
	SpeedMbps int    `json:"speedMbps,omitempty"` // 0 = unbekannt/Link unten
	// PTPClock: Index der PTP-Hardware-Uhr (/dev/ptpN), nil = keine Hardware-Zeitstempel.
	PTPClock *int `json:"ptpClock,omitempty"`
	// RDMA: Name des RDMA-Geräts (z. B. mlx5_0, irdma0), leer = keins.
	RDMA string `json:"rdma,omitempty"`
	NUMA int    `json:"numa"`
	// Bypass: erlaubte Wege, geordnet nach Eignung. "afxdp" geht fast überall, "dpdk" braucht
	// einen DPDK-fähigen Treiber.
	Bypass []string `json:"bypass,omitempty"`
}

var (
	mellanoxDrivers = map[string]bool{"mlx5_core": true, "mlx4_core": true, "mlx4_en": true}
	intelDrivers    = map[string]bool{"ice": true, "i40e": true, "ixgbe": true, "igc": true, "igb": true, "e1000e": true, "iavf": true}
	dpdkDrivers     = map[string]bool{"mlx5_core": true, "ice": true, "i40e": true, "ixgbe": true, "igc": true, "igb": true, "iavf": true}
)

func nicVendor(pciVendor, driver string) string {
	switch {
	case pciVendor == "0x15b3" || mellanoxDrivers[driver]:
		return "NVIDIA Mellanox"
	case pciVendor == "0x8086" || intelDrivers[driver]:
		return "Intel"
	}
	return ""
}

func nicBypass(vendor, driver string) []string {
	var out []string
	if dpdkDrivers[driver] {
		out = append(out, "dpdk")
	}
	return append(out, "afxdp")
}

// ScanNICs liest die physischen Schnittstellen unter root ("" = "/sys"). Virtuelle (lo, Bridges,
// veth, tun …) haben kein `device`-Verzeichnis und fallen weg.
func ScanNICs(root string) []NicInfo {
	if root == "" {
		root = "/sys"
	}
	entries, err := os.ReadDir(filepath.Join(root, "class/net"))
	if err != nil {
		return nil
	}
	var out []NicInfo
	for _, e := range entries {
		dev := filepath.Join(root, "class/net", e.Name(), "device")
		real, err := filepath.EvalSymlinks(dev)
		if err != nil {
			continue
		}
		n := NicInfo{Name: e.Name(), PCI: filepath.Base(real), NUMA: -1}
		n.DeviceID = readTrim(filepath.Join(real, "device"))
		if d, err := os.Readlink(filepath.Join(real, "driver")); err == nil {
			n.Driver = filepath.Base(d)
		}
		n.Vendor = nicVendor(readTrim(filepath.Join(real, "vendor")), n.Driver)
		n.Up = readTrim(filepath.Join(root, "class/net", e.Name(), "operstate")) == "up"
		if v, err := strconv.Atoi(readTrim(filepath.Join(root, "class/net", e.Name(), "speed"))); err == nil && v > 0 {
			n.SpeedMbps = v
		}
		if v, err := strconv.Atoi(readTrim(filepath.Join(real, "numa_node"))); err == nil {
			n.NUMA = v
		}
		if ps, _ := filepath.Glob(filepath.Join(real, "ptp", "ptp*")); len(ps) > 0 {
			if idx, err := strconv.Atoi(strings.TrimPrefix(filepath.Base(ps[0]), "ptp")); err == nil {
				n.PTPClock = &idx
			}
		}
		if rs, _ := os.ReadDir(filepath.Join(real, "infiniband")); len(rs) > 0 {
			n.RDMA = rs[0].Name()
		}
		n.Bypass = nicBypass(n.Vendor, n.Driver)
		out = append(out, n)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// TakeNICs ist ScanNICs auf dem echten /sys.
func TakeNICs() []NicInfo { return ScanNICs("") }
