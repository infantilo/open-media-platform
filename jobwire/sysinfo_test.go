package jobwire

import (
	"context"
	"encoding/json"
	"testing"
)

func TestParsers(t *testing.T) {
	tot, av := ParseMeminfo("MemTotal:       16384 kB\nMemFree: 1 kB\nMemAvailable:    8192 kB\n")
	if tot != 16384*1024 || av != 8192*1024 {
		t.Fatal(tot, av)
	}
	if ParseLoad1("0.52 0.40 0.30 1/200 999") != 0.52 {
		t.Fatal("load")
	}
	if ParseFDLimit("Max cpu time  unlimited unlimited seconds\nMax open files            1024                 524288               files\n") != 1024 {
		t.Fatal("fd")
	}
	if ParseFDLimit("Max open files unlimited unlimited files") != 0 {
		t.Fatal("unlimited")
	}
}

func TestCollectSysinfoRoundTrip(t *testing.T) {
	s := CollectSysinfo(context.Background(), []DiskTarget{{"/", "System"}, {"/nonexistent-dir", "x"}})
	if len(s.Disks) != 2 || s.Disks[0].TotalBytes == 0 || s.Disks[1].Err == "" || s.CPUs == 0 || s.MemTotal == 0 {
		t.Fatalf("%+v", s)
	}
	if s.Files["os-release.txt"] == "" || s.Files["meminfo.txt"] == "" {
		t.Fatalf("Textbericht unvollständig: %v", s.Files)
	}
	raw, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	var back Sysinfo
	if err := json.Unmarshal(raw, &back); err != nil || back.MemTotal != s.MemTotal || len(back.Disks) != 2 {
		t.Fatalf("%v %+v", err, back)
	}
}
