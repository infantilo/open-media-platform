package subtitlegen

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/asset"
)

// Slug macht aus einem Namen einen Dateinamen: Buchstaben, Ziffern, - _ ., Umlaute umgeschrieben, höchstens 80 Zeichen.
func Slug(s string) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			b.WriteRune(r)
		case r == 'ä', r == 'Ä':
			b.WriteString("ae")
		case r == 'ö', r == 'Ö':
			b.WriteString("oe")
		case r == 'ü', r == 'Ü':
			b.WriteString("ue")
		case r == 'ß':
			b.WriteString("ss")
		default:
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), "-.")
	for strings.Contains(out, "--") {
		out = strings.ReplaceAll(out, "--", "-")
	}
	if len(out) > 80 {
		out = out[:80]
	}
	return out
}

// UniqueName liefert einen Namen, den in keinem der Verzeichnisse schon eine .srt-Datei trägt (Name, Name-2, …).
func UniqueName(name string, dirs ...string) string {
	taken := func(n string) bool {
		for _, d := range dirs {
			if d == "" {
				continue
			}
			if _, err := os.Stat(filepath.Join(d, n+".srt")); err == nil {
				return true
			}
		}
		return false
	}
	if !taken(name) {
		return name
	}
	for i := 2; ; i++ {
		if c := fmt.Sprintf("%s-%d", name, i); !taken(c) {
			return c
		}
	}
}

// Placed beschreibt, wohin das Ergebnis gelegt wurde.
type Placed struct {
	Name string
	// Path: Datei im Asset-Ordner (gehört zum Asset/Versionsverlauf).
	Path string
	// PlayoutPath: Kopie in dem Verzeichnis, aus dem das Kind-Event SUBTITLE abspielt (leer, wenn nicht angelegt).
	PlayoutPath string
	// RepID: Darstellung vom Typ „subtitle“ in der neuen Asset-Version (leer ohne Asset).
	RepID string
	// Warning: etwas, das nicht geklappt hat, ohne dass das Ergebnis unbrauchbar wäre.
	Warning string
}

// Place legt eine fertige SRT ab: `<assetDir>/<Name>.srt`, Kopie nach `playDir` (nur wenn gesetzt) und — wenn `assets` und `assetID` gegeben
// sind — als Darstellung „subtitle“ am Asset. Die aktuelle Asset-Version ist nach dem Import veröffentlicht und damit unveränderlich;
// deshalb entsteht eine **neue Version** („Untertitel: <Name>“), die die vorhandenen Darstellungen übernimmt und die SRT ergänzt.
func Place(assets *asset.Store, assetID, name, srt, assetDir, playDir string) (Placed, error) {
	name = UniqueName(Slug(name), assetDir, playDir)
	if name == "" {
		name = UniqueName("untertitel", assetDir, playDir)
	}
	p := Placed{Name: name}
	if err := os.MkdirAll(assetDir, 0o755); err != nil {
		return p, err
	}
	p.Path = filepath.Join(assetDir, name+".srt")
	if err := os.WriteFile(p.Path, []byte(srt), 0o644); err != nil {
		return p, err
	}
	if strings.TrimSpace(playDir) != "" {
		if err := os.MkdirAll(playDir, 0o755); err == nil {
			pp := filepath.Join(playDir, name+".srt")
			if os.WriteFile(pp, []byte(srt), 0o644) == nil {
				p.PlayoutPath = pp
			}
		}
		if p.PlayoutPath == "" {
			p.Warning = "Kopie für das Playout nicht angelegt."
		}
	}
	if assets != nil && assetID != "" {
		id, err := attach(assets, assetID, name, p.Path, srt)
		if err != nil {
			p.Warning = strings.TrimSpace(p.Warning + " Darstellung am Asset nicht angelegt: " + err.Error()) // die Datei bleibt abrufbar
		}
		p.RepID = id
	}
	return p, nil
}

func attach(assets *asset.Store, assetID, name, path, srt string) (string, error) {
	a, err := assets.GetAsset(assetID)
	if err != nil {
		return "", err
	}
	v, err := assets.CreateVersion(assetID, a.CurrentVersionID, "Untertitel: "+name, "system")
	if err != nil {
		return "", err
	}
	if a.CurrentVersionID != "" {
		old, err := assets.ListRepresentations(a.CurrentVersionID)
		if err != nil {
			return "", err
		}
		for _, r := range old {
			r.AssetVersionID = v.ID
			if _, err := assets.CreateRepresentation(r); err != nil {
				return "", fmt.Errorf("Darstellung %s übernehmen: %w", r.Type, err)
			}
		}
	}
	sum := sha256.Sum256([]byte(srt))
	size := int64(len(srt))
	rep, err := assets.CreateRepresentation(asset.Representation{
		AssetVersionID: v.ID, Type: "subtitle", Format: "srt", Container: "srt", SizeBytes: &size,
		Checksum: hex.EncodeToString(sum[:]), Storage: asset.StorageLocation{Provider: "filesystem", URI: path},
	})
	if err != nil {
		return "", err
	}
	if _, err := assets.PublishVersion(v.ID); err != nil {
		return "", err
	}
	return rep.ID, nil
}
