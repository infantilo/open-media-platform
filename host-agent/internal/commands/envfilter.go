package commands

import "strings"

// Umgebung der Nodes als Freigabeliste (HAERTUNG-PLAN.md M1, Schritt 98.1).
//
// Vorher erbte jeder Node die komplette Umgebung des Orchestrators — samt
// Plattform-Geheimnissen (OMP_STORAGE_SECRET_KEY, OMP_POSTGRES_URL mit
// Passwort, Cloud-Zugang, Sicherungs-Passphrase, Alarm-Zugangsdaten). Ein
// übernommener Node konnte sie aus /proc/self/environ lesen. Jetzt erbt ein
// Node nur noch, was er für Betrieb und Medienpfad braucht:
//   - exakt benannte Werte (PATH, HOME, LD_LIBRARY_PATH, …),
//   - Präfixe für Medien-/Grafik-/Audio-Stacks (GST_, XDG_, MESA_, …),
//   - OMP_* (Betriebswerte der Plattform) ABER OHNE Geheimnisse (envDenied).
//
// Erweiterung ohne Neubau: OMP_ENV_PASS (Komma-Liste exakter Namen oder
// Präfixe mit Stern, z. B. "FOO,BAR_*") — für Sonderfälle am Host.
// Katalog-env{} und extraEnv kommen NACH dem Filter und sind unverändert.
// Duplikat: orchestrator/internal/launcher/envfilter.go (bewusste kleine
// Duplikation wie bei buildEnv) — beide gleichzeitig ändern.

var envAllowExact = map[string]bool{
	"PATH": true, "HOME": true, "USER": true, "LOGNAME": true, "SHELL": true,
	"LANG": true, "LANGUAGE": true, "TZ": true, "TERM": true, "TMPDIR": true,
	"LD_LIBRARY_PATH": true, "DISPLAY": true, "WAYLAND_DISPLAY": true,
	"DBUS_SESSION_BUS_ADDRESS": true, "SSL_CERT_FILE": true, "SSL_CERT_DIR": true,
	"http_proxy": true, "https_proxy": true, "no_proxy": true,
	"HTTP_PROXY": true, "HTTPS_PROXY": true, "NO_PROXY": true, "NO_COLOR": true,
	"RUST_LOG": true, "RUST_BACKTRACE": true, "LIBVA_DRIVER_NAME": true,
}

var envAllowPrefix = []string{
	"OMP_", "MXL_", "GST_", "G_", "GIO_", "GDK_", "GTK_", "LC_", "XDG_", "PULSE_",
	"PIPEWIRE_", "ALSA_", "VK_", "LIBVA_", "VDPAU_", "EGL_", "MESA_", "LIBGL_",
	"__GL", "__NV", "NVIDIA_", "CUDA_", "WPE", "WEBKIT", "RUST_",
}

// envDeniedExact/-Suffix/-Prefix: auch innerhalb von OMP_* nie an Nodes.
var envDeniedExact = map[string]bool{
	"OMP_POSTGRES_URL": true, "OMP_HOST_AGENT_BOOTSTRAP_TOKEN": true,
	"OMP_ALERT_WEBHOOK_TOKEN": true,
}

var envDeniedSuffix = []string{
	"_SECRET", "_SECRET_KEY", "_ACCESS_KEY", "_PASSWORD", "_PASSPHRASE",
	"_PASSPHRASE_FILE", "_PRIVATE_KEY", "_DSN",
}

var envDeniedPrefix = []string{"OMP_CLOUD_"}

// envInherited filtert eine os.Environ()-Liste auf das, was Nodes erben dürfen.
func envInherited(environ []string) map[string]string {
	var extra []string
	for _, kv := range environ {
		if strings.HasPrefix(kv, "OMP_ENV_PASS=") {
			extra = strings.Split(kv[len("OMP_ENV_PASS="):], ",")
		}
	}
	out := map[string]string{}
	for _, kv := range environ {
		i := strings.IndexByte(kv, '=')
		if i <= 0 {
			continue
		}
		k, v := kv[:i], kv[i+1:]
		if envAllowedName(k, extra) {
			out[k] = v
		}
	}
	return out
}

// envAllowedName: die Sperrliste gilt immer, auch gegen OMP_ENV_PASS — ein
// Geheimnis darf nie durch einen Tippfehler dort durchrutschen.
func envAllowedName(k string, extra []string) bool {
	if envDenied(k) {
		return false
	}
	if envAllowExact[k] {
		return true
	}
	for _, p := range envAllowPrefix {
		if strings.HasPrefix(k, p) {
			return true
		}
	}
	for _, p := range extra {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if p == k || strings.HasSuffix(p, "*") && strings.HasPrefix(k, strings.TrimSuffix(p, "*")) {
			return true
		}
	}
	return false
}

func envDenied(k string) bool {
	if envDeniedExact[k] {
		return true
	}
	for _, p := range envDeniedPrefix {
		if strings.HasPrefix(k, p) {
			return true
		}
	}
	for _, s := range envDeniedSuffix {
		if strings.HasSuffix(k, s) {
			return true
		}
	}
	return false
}
