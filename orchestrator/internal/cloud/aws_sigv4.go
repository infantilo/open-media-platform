package cloud

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"sort"
	"strings"
	"time"
)

// awsCreds sind statische Zugangsdaten (optional mit Sitzungstoken). Sie werden nie geloggt oder serialisiert.
type awsCreds struct {
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
}

func hmacSHA256(key []byte, data string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(data))
	return m.Sum(nil)
}

func sha256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// signV4 signiert die Anfrage nach AWS Signature Version 4 (nur Standardbibliothek, kein SDK) und setzt die
// Header `X-Amz-Date`, optional `X-Amz-Security-Token` und `Authorization`. Signiert werden host, x-amz-date,
// content-type, x-amz-target und das Sitzungstoken, sofern vorhanden.
func signV4(req *http.Request, body []byte, c awsCreds, region, service string, now time.Time) {
	amzDate := now.UTC().Format("20060102T150405Z")
	date := amzDate[:8]
	req.Header.Set("X-Amz-Date", amzDate)
	if c.SessionToken != "" {
		req.Header.Set("X-Amz-Security-Token", c.SessionToken)
	}
	host := req.URL.Host
	signed := map[string]string{"host": host, "x-amz-date": amzDate}
	for _, h := range []string{"Content-Type", "X-Amz-Target", "X-Amz-Security-Token"} {
		if v := req.Header.Get(h); v != "" {
			signed[strings.ToLower(h)] = strings.TrimSpace(v)
		}
	}
	names := make([]string, 0, len(signed))
	for k := range signed {
		names = append(names, k)
	}
	sort.Strings(names)
	var canonHeaders strings.Builder
	for _, k := range names {
		canonHeaders.WriteString(k + ":" + signed[k] + "\n")
	}
	signedHeaders := strings.Join(names, ";")
	uri := req.URL.EscapedPath()
	if uri == "" {
		uri = "/"
	}
	canonical := strings.Join([]string{req.Method, uri, req.URL.RawQuery, canonHeaders.String(), signedHeaders, sha256Hex(body)}, "\n")
	scope := date + "/" + region + "/" + service + "/aws4_request"
	toSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + sha256Hex([]byte(canonical))
	k := hmacSHA256([]byte("AWS4"+c.SecretAccessKey), date)
	k = hmacSHA256(k, region)
	k = hmacSHA256(k, service)
	k = hmacSHA256(k, "aws4_request")
	sig := hex.EncodeToString(hmacSHA256(k, toSign))
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+c.AccessKeyID+"/"+scope+", SignedHeaders="+signedHeaders+", Signature="+sig)
}
