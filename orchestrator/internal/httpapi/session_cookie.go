package httpapi

import (
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Sitzungs-Cookie (Audit 2026-10-23 H1): Node-Oberflächen laufen als JavaScript im Ursprung der Shell, und das Token lag in localStorage — ein
// kompromittiertes oder fehlerhaftes Node-Bundle konnte es lesen und wegschicken. Jetzt trägt ein HttpOnly-Cookie die Sitzung: Skripte sehen sie nicht,
// und sie geht nur an denselben Ursprung. Dazu entfallen die `?access_token=`-Umwege für Bilder, Streams und `import()`, die nur existierten, weil
// diese Anfragen keinen Authorization-Header senden können. Bearer-Header (API-Clients, Dienste) bleiben unverändert gültig.
const sessionCookieName = "omp_session"

// sessionCookieTTL entspricht auth.TokenTTL.
const sessionCookieTTL = 12 * time.Hour

func secureRequest(r *http.Request) bool {
	return r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

func setSessionCookie(w http.ResponseWriter, r *http.Request, token string) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookieName, Value: token, Path: "/", HttpOnly: true, Secure: secureRequest(r), SameSite: http.SameSiteStrictMode,
		MaxAge: int(sessionCookieTTL.Seconds()), Expires: time.Now().Add(sessionCookieTTL),
	})
}

func clearSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookieName, Value: "", Path: "/", HttpOnly: true, Secure: secureRequest(r), SameSite: http.SameSiteStrictMode, MaxAge: -1})
}

// cookieRequestAllowed: ein Cookie wird vom Browser „von selbst“ mitgeschickt, deshalb darf es verändernde Anfragen (POST/PUT/PATCH/DELETE) nur
// tragen, wenn sie erkennbar aus der eigenen Seite kommen (Origin gleich Host bzw. Sec-Fetch-Site same-origin/none). Lesende Anfragen genügen
// SameSite=Strict. Ohne Origin- und Sec-Fetch-Site-Header (kein Browser) gilt die Anfrage als zulässig — ein Angreifer ohne Browser besitzt das Cookie nicht.
func cookieRequestAllowed(r *http.Request) bool {
	switch r.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	}
	if s := r.Header.Get("Sec-Fetch-Site"); s != "" && s != "same-origin" && s != "none" {
		return false
	}
	if o := r.Header.Get("Origin"); o != "" && o != "null" {
		u, err := url.Parse(o)
		return err == nil && strings.EqualFold(u.Host, r.Host)
	} else if o == "null" {
		return false
	}
	return true
}

// shellCSP (Audit H1): die Shell und die in sie geladenen Node-Oberflächen dürfen nur Skripte, Bilder und Verbindungen des eigenen Ursprungs verwenden.
// Das hindert ein kompromittiertes Bundle, Daten an fremde Server zu schicken oder fremden Code nachzuladen (es kann in der Anwendung weiter als der Nutzer handeln —
// vollständige Isolation brächte erst eine eigene Sandbox je Node-Oberfläche). `style-src 'unsafe-inline'`: die Oberfläche setzt Stile per style-Attribut.
const shellCSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; " +
	"connect-src 'self'; font-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

// withShellSecurityHeaders setzt CSP und Begleitkopfzeilen auf die ausgelieferte Shell (nicht auf die API: Antworten von Nodes können eigene Seiten tragen).
func withShellSecurityHeaders(uiPort string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		csp := shellCSP
		if uiPort != "" {
			// Isolierte Node-Oberflächen (internal/uiorigin) dürfen als iframe auf dem zweiten Ursprung eingebettet werden — nur dort.
			if strings.HasPrefix(uiPort, "origin:") {
				csp += "; frame-src 'self' " + strings.TrimPrefix(uiPort, "origin:")
			} else {
				host := r.Host
				if u, err := url.Parse("//" + r.Host); err == nil {
					host = u.Hostname()
				}
				csp += "; frame-src 'self' http://" + host + ":" + uiPort + " https://" + host + ":" + uiPort
			}
		}
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}
