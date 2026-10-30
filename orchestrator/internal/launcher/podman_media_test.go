package launcher

import (
	"reflect"
	"testing"
)

func TestMediaMountPaths(t *testing.T) {
	t.Setenv("OMP_MEDIA_MOUNTS", "/srv/media: rel/x::/data/in/")
	if got, want := mediaMountPaths(), []string{"/srv/media", "/data/in"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	t.Setenv("OMP_MEDIA_MOUNTS", "")
	if len(mediaMountPaths()) != 0 {
		t.Fatal("leer erwartet")
	}
}
