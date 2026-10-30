package telemetry

import (
	"os"
	"path/filepath"
	"testing"
)

func writeFile(t *testing.T, p, c string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(c), 0o644); err != nil {
		t.Fatal(err)
	}
}

// fixtureNIC baut /sys/devices/pci…/<pci> + class/net/<name>/device-Link nach.
func fixtureNIC(t *testing.T, root, name, pci, vendor, driver, oper, speed string) string {
	t.Helper()
	dev := filepath.Join(root, "devices/pci0000:00", pci)
	writeFile(t, filepath.Join(dev, "vendor"), vendor+"\n")
	writeFile(t, filepath.Join(dev, "device"), "0x1017\n")
	writeFile(t, filepath.Join(dev, "numa_node"), "1\n")
	if err := os.MkdirAll(filepath.Join(root, "bus/pci/drivers", driver), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "bus/pci/drivers", driver), filepath.Join(dev, "driver")); err != nil {
		t.Fatal(err)
	}
	nd := filepath.Join(root, "class/net", name)
	writeFile(t, filepath.Join(nd, "operstate"), oper+"\n")
	writeFile(t, filepath.Join(nd, "speed"), speed+"\n")
	if err := os.Symlink(dev, filepath.Join(nd, "device")); err != nil {
		t.Fatal(err)
	}
	return dev
}

func TestScanNICs(t *testing.T) {
	root := t.TempDir()
	cx := fixtureNIC(t, root, "ens1f0", "0000:3b:00.0", "0x15b3", "mlx5_core", "up", "100000")
	writeFile(t, filepath.Join(cx, "ptp/ptp2/clock_name"), "x\n")
	writeFile(t, filepath.Join(cx, "infiniband/mlx5_0/node_type"), "1\n")
	fixtureNIC(t, root, "eno1", "0000:00:1f.6", "0x8086", "e1000e", "down", "-1")
	writeFile(t, filepath.Join(root, "class/net/lo/operstate"), "unknown\n") // virtuell: kein device

	got := ScanNICs(root)
	if len(got) != 2 {
		t.Fatalf("erwartet 2 physische NICs, bekam %d: %+v", len(got), got)
	}
	var mlx, intel NicInfo
	for _, n := range got {
		if n.Name == "ens1f0" {
			mlx = n
		} else {
			intel = n
		}
	}
	if mlx.Vendor != "NVIDIA Mellanox" || mlx.Driver != "mlx5_core" || !mlx.Up || mlx.SpeedMbps != 100000 {
		t.Errorf("ConnectX falsch erkannt: %+v", mlx)
	}
	if mlx.PTPClock == nil || *mlx.PTPClock != 2 || mlx.RDMA != "mlx5_0" || mlx.NUMA != 1 {
		t.Errorf("PTP/RDMA/NUMA falsch: %+v", mlx)
	}
	if len(mlx.Bypass) != 2 || mlx.Bypass[0] != "dpdk" || mlx.Bypass[1] != "afxdp" {
		t.Errorf("Bypass ConnectX: %v", mlx.Bypass)
	}
	if intel.Vendor != "Intel" || intel.Up || intel.SpeedMbps != 0 || intel.PTPClock != nil {
		t.Errorf("Intel falsch erkannt (Link unten, speed=-1): %+v", intel)
	}
	if len(intel.Bypass) != 1 || intel.Bypass[0] != "afxdp" {
		t.Errorf("e1000e ist nicht DPDK-fähig: %v", intel.Bypass)
	}
}
