package httpapi

import (
	"reflect"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sourcetags"
)

func TestBuildSourcesMergesTagOriginsPerSender(t *testing.T) {
	nodes := []registry.NodeView{{
		ID: "n1", Label: "Remote Feed", Online: true,
		Senders: []registry.SenderView{
			{ID: "s-video", Label: "Video", Format: "urn:x-nmos:format:video"},
			{ID: "s-a1", Label: "Audio 1", Format: "urn:x-nmos:format:audio", ChannelCount: 1, DiscoveredTags: []string{"role.program", "audio.stereo"}},
		},
	}}
	explicit := map[sourcetags.Key][]string{
		{NodeID: "n1", SenderLabel: "Audio 1"}: {"role.commentator", "audio.mono"},
	}
	roles := func(id string) (string, string, string, bool) { return "wf1", "Regie", "remote", id == "n1" }

	got := buildSources(nodes, explicit, roles)
	if len(got) != 2 {
		t.Fatalf("len = %d", len(got))
	}
	byID := map[string]SourceInfo{}
	for _, s := range got {
		byID[s.SenderID] = s
	}
	if v := byID["s-video"]; v.MediaType != "video" || v.WorkflowID != "wf1" || v.Role != "remote" ||
		!reflect.DeepEqual(v.Tags, []sourcetags.Tag{{Tag: "media.video", Origin: "DERIVED"}}) {
		t.Fatalf("video = %+v", v)
	}
	a := byID["s-a1"]
	want := []sourcetags.Tag{
		{Tag: "audio.mono", Origin: "EXPLICIT"},     // explizit vor abgeleitet
		{Tag: "audio.stereo", Origin: "DISCOVERED"}, // Node behauptet stereo, bei 1 Kanal NICHT abgeleitet → bleibt DISCOVERED
		{Tag: "media.audio", Origin: "DERIVED"},
		{Tag: "role.commentator", Origin: "EXPLICIT"},
		{Tag: "role.program", Origin: "DISCOVERED"},
	}
	if !reflect.DeepEqual(a.Tags, want) {
		t.Fatalf("audio tags = %+v\nwant %+v", a.Tags, want)
	}
}

func TestSourceTagFilterRequiresAllTags(t *testing.T) {
	s := SourceInfo{Tags: []sourcetags.Tag{{Tag: "media.audio"}, {Tag: "role.commentator"}}}
	if !hasAllTags(s, nil) || !hasAllTags(s, []string{"media.audio"}) || !hasAllTags(s, []string{"media.audio", "role.commentator"}) {
		t.Fatal("should match")
	}
	if hasAllTags(s, []string{"media.audio", "audio.mono"}) {
		t.Fatal("must require ALL tags")
	}
}
