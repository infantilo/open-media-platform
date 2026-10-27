package support

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"regexp"
	"strings"
	"time"
)

// File ist ein Teil des Support-Pakets.
type File struct {
	Name string
	Data []byte
}

const redacted = "[entfernt]"

// Schlüsselnamen, deren Werte nie ins Paket gehören.
var secretKey = regexp.MustCompile(`(?i)(password|passwort|passwd|secret|token|apikey|api_key|private|credential|authorization|cookie|signingkey|launchsecret|accesskey|sessionid|dsn|connectionstring|postgresurl)`)

var (
	reKeyValue = regexp.MustCompile(`(?i)\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api_?key|private_?key|credential|access_?key)[A-Za-z0-9_.-]*)(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)`)
	reBearer   = regexp.MustCompile(`(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}`)
	reURLCred  = regexp.MustCompile(`(?i)\b([a-z][a-z0-9+.-]*://[^\s/:@]+):([^\s/@]+)@`)
	reFlag     = regexp.MustCompile(`(?i)(\s--?[a-z0-9_-]*(?:password|passwd|secret|token|api-?key|private-?key|credential|access-?key)[a-z0-9_-]*)(\s+|=)(\S+)`)
	rePEM      = regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`)
)

// RedactText entfernt Geheimnisse aus Text (Logzeilen, Umgebung, Kommandoausgaben).
func RedactText(s string) string {
	s = rePEM.ReplaceAllString(s, redacted)
	s = reURLCred.ReplaceAllString(s, "${1}:"+redacted+"@")
	s = reBearer.ReplaceAllString(s, "${1} "+redacted)
	s = reFlag.ReplaceAllString(s, "${1}${2}"+redacted)
	s = reKeyValue.ReplaceAllString(s, "${1}${2}"+redacted)
	return s
}

// RedactJSON ersetzt Werte unter geheimnisverdächtigen Schlüsseln und bereinigt alle Zeichenketten.
// Ist die Eingabe kein JSON, wird sie als Text behandelt.
func RedactJSON(data []byte) []byte {
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		return []byte(RedactText(string(data)))
	}
	out, err := json.MarshalIndent(redactValue(v), "", "  ")
	if err != nil {
		return []byte(RedactText(string(data)))
	}
	return out
}

func redactValue(v any) any {
	switch x := v.(type) {
	case map[string]any:
		for k, val := range x {
			if secretKey.MatchString(k) {
				if val != nil && val != "" && val != false {
					x[k] = redacted
				}
				continue
			}
			x[k] = redactValue(val)
		}
		return x
	case []any:
		for i := range x {
			x[i] = redactValue(x[i])
		}
		return x
	case string:
		return RedactText(x)
	}
	return v
}

// Redact wählt je nach Dateiendung JSON- oder Textschwärzung.
func Redact(name string, data []byte) []byte {
	if strings.HasSuffix(name, ".json") {
		return RedactJSON(data)
	}
	return []byte(RedactText(string(data)))
}

// Manifest beschreibt das Paket.
type Manifest struct {
	CreatedAt time.Time         `json:"createdAt"`
	Window    string            `json:"window"`
	Files     []string          `json:"files"`
	Failed    map[string]string `json:"failed,omitempty"`
}

// WriteZip schreibt die Dateien (schon geschwärzt) als ZIP.
func WriteZip(w io.Writer, files []File, now time.Time) error {
	zw := zip.NewWriter(w)
	for _, f := range files {
		h := &zip.FileHeader{Name: f.Name, Method: zip.Deflate, Modified: now}
		fw, err := zw.CreateHeader(h)
		if err != nil {
			return err
		}
		if _, err := io.Copy(fw, bytes.NewReader(f.Data)); err != nil {
			return err
		}
	}
	return zw.Close()
}
