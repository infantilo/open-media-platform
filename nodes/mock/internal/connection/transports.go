package connection

// Transport ist ein Eintrag des NMOS-"Transports"-Parameter-Registers
// (AMWA-TV/nmos-parameter-registers, Abschnitt "transports") — seit
// IS-05 v1.2.0 die kanonische Quelle für Transport-Typ-URNs, statt fest
// in der Spec definiert (docs/decisions.md Nachtrag 189). Transports
// bildet die vier von der Registry aktuell geführten Standard-Einträge
// ab, plus die projekteigene proprietäre MXL-Erweiterung
// (`urn:x-omp:transport:mxl`, s. Rust-Pendant `is04::TRANSPORT_MXL`).
// Kein Node dieses Projekts braucht mqtt/websocket/dash aktiv — diese
// Tabelle ist die eine Stelle, an der ein künftiger echter Bedarf
// ergänzt würde, statt an verstreuten String-Literalen.
type Transport struct {
	URN        string
	Label      string
	Deprecated bool
}

var Transports = []Transport{
	{URN: "urn:x-nmos:transport:rtp", Label: "RTP"},
	{URN: "urn:x-nmos:transport:mqtt", Label: "MQTT"},
	{URN: "urn:x-nmos:transport:websocket", Label: "Websocket"},
	{URN: "urn:x-nmos:transport:dash", Label: "DASH"},
	{URN: "urn:x-omp:transport:mxl", Label: "MXL (OMP-proprietär)"},
}

// IsKnownTransport prüft, ob urn im Register steht — eine Validierungs-
// stelle statt verstreuter String-Vergleiche.
func IsKnownTransport(urn string) bool {
	for _, t := range Transports {
		if t.URN == urn {
			return true
		}
	}
	return false
}

// init verdrahtet das Register tatsächlich in den Mock-Node: die
// `transporttype/`-Antwort muss ein im Register bekannter Eintrag sein.
// Ein Tippfehler in `TransportType` (receiver.go) würde sonst erst beim
// nächsten AMWA-Testlauf auffallen statt beim Programmstart.
func init() {
	if !IsKnownTransport(TransportType) {
		panic("connection.TransportType ist kein bekannter Eintrag im Transports-Register: " + TransportType)
	}
}
