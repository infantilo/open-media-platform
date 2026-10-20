package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestDetectsFacesInSample(t *testing.T) {
	data, err := os.ReadFile("testdata/sample.jpg")
	if err != nil {
		t.Fatal(err)
	}
	det, err := NewDetector(5)
	if err != nil {
		t.Fatal(err)
	}
	faces, err := det.DetectJPEG(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(faces) == 0 {
		t.Fatal("kein Gesicht im Beispielbild erkannt")
	}
	for _, f := range faces {
		if f.CenterX < 0 || f.CenterX > 1 || f.CenterY < 0 || f.CenterY > 1 || f.SizePercent <= 0 || f.SizePercent > 100 {
			t.Errorf("Wert außerhalb des Bereichs: %+v", f)
		}
	}
	t.Logf("%d Gesichter: %+v", len(faces), faces)
}

func TestPreviewSource(t *testing.T) {
	data, _ := os.ReadFile("testdata/sample.jpg")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/preview" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		w.Write(data)
	}))
	defer srv.Close()
	got, err := newPreviewSource(srv.URL + "/preview").Frame(context.Background())
	if err != nil || len(got) != len(data) {
		t.Fatalf("Frame: %v, %d Bytes", err, len(got))
	}
	if _, err := newPreviewSource(srv.URL + "/nope").Frame(context.Background()); err == nil {
		t.Fatal("404 muss Fehler sein")
	}
}

func TestParseCameras(t *testing.T) {
	m := parseCameras("cam-1=http://a:1/preview, cam-2=http://b:2/preview,kaputt")
	if len(m) != 2 || m["cam-2"] != "http://b:2/preview" {
		t.Fatalf("%v", m)
	}
}

func BenchmarkDetect(b *testing.B) {
	data, _ := os.ReadFile("testdata/sample.jpg")
	det, _ := NewDetector(5)
	for i := 0; i < b.N; i++ {
		det.DetectJPEG(data)
	}
}
