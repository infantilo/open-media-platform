package launcher

import (
	"strings"
	"testing"
)

func TestParseDefaultRouteIface(t *testing.T) {
	in := "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\n" +
		"wlan0\t00000000\t0100A8C0\t0003\t0\t0\t600\t00000000\n" +
		"eth0\t00000000\t0100A8C0\t0003\t0\t0\t100\t00000000\n" +
		"eth0\t0000A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\n"
	if got := parseDefaultRouteIface(strings.NewReader(in)); got != "eth0" {
		t.Fatalf("got %q", got)
	}
	if resolveLocalNetIface("off") != "" || resolveLocalNetIface("enp1s0") != "enp1s0" {
		t.Fatal("explicit spec")
	}
}

func TestLocalHostSampleSecondCallHasRates(t *testing.T) {
	var s localHostState
	first := s.sample("auto")
	if first.Net != nil {
		t.Fatal("erste Messung hat keine Rate")
	}
	if first.MemPercent <= 0 {
		t.Fatalf("RAM erwartet: %+v", first)
	}
	second := s.sample("auto")
	if second.CPUPercent < 0 || second.CPUPercent > 100 {
		t.Fatalf("CPU außerhalb 0..100: %v", second.CPUPercent)
	}
}
