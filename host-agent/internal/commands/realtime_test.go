package commands

import (
	"reflect"
	"testing"
)

func TestWrapRealtime(t *testing.T) {
	cmd := []string{"/bin/node", "--x"}
	if got := wrapRealtime("t", nil, cmd); !reflect.DeepEqual(got, cmd) {
		t.Fatalf("nil: %v", got)
	}
	got := wrapRealtime("t", &CatalogRealtime{Cpus: "0"}, cmd)
	want := []string{"taskset", "-c", "0", "/bin/node", "--x"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	for _, bad := range []string{"a-b", "0,,1", "99999"} {
		if got := wrapRealtime("t", &CatalogRealtime{Cpus: bad}, cmd); !reflect.DeepEqual(got, cmd) {
			t.Fatalf("%q nicht ignoriert: %v", bad, got)
		}
	}
	t.Setenv("OMP_RT_DISABLE", "1")
	if got := wrapRealtime("t", &CatalogRealtime{Cpus: "0"}, cmd); !reflect.DeepEqual(got, cmd) {
		t.Fatalf("disable: %v", got)
	}
}
