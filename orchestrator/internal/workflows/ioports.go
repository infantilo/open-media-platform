package workflows

import (
	"fmt"
	"strconv"
	"strings"
)

// ioPortAssignment ist das Ergebnis eines erfolgreichen I/O-Port-Claims
// für eine Rolle (ARCHITECTURE.md §6.1 Erweiterung 2026-07-10,
// UMSETZUNG.md D13) — anders als der bisherige `map[string]string`
// (nur HostID) wird PortID jetzt mitgeführt, damit runStart/
// executeMigration den tatsächlich geclaimten physischen Port an die
// gestartete Instanz weiterreichen können (s. ioPortExtraEnv-Doku:
// live gefundener Bug, der Claim entschied bislang nur über den
// Ziel-Host, PortID wurde danach verworfen).
type ioPortAssignment struct {
	HostID string
	PortID string
}

// IoPortExtraEnv übersetzt einen erfolgreich geclaimten I/O-Port in die vom Karten-Node gelesenen
// Umgebungsvariablen (Hintergrund: ein direkt gestarteter Karten-Node durchlief nie `Service.Start()` und bekam
// deshalb nie einen Port — Nutzerfund 2026-08-20; der Claim entscheidet über Host UND Anschluss).
//
// Port-Konvention (Kap. 76): `portId` = `<Hersteller>-<Gerätenummer>-in|out`, z. B. `decklink-0-in` — ein
// Duplex-Anschluss ist also zwei Ports derselben Gerätenummer, die einzeln belegt werden können, und gleiche
// Gerätenummern verschiedener Hersteller kollidieren nicht. Kürzere Formen (`0-in`, reine Zahl; alte
// Inventardateien) werden weiter gelesen, eine reine Zahl mit der Richtung der Anforderung.
func IoPortExtraEnv(req *IOPortRequirement, portID string) map[string]string {
	if req == nil {
		return nil
	}
	env, err := CardPortsEnv(req.CardType, strings.Split(portID, ","), req.Direction)
	if err != nil {
		return nil
	}
	return env
}

// CardVendor bildet den `cardType` des Ports auf `OMP_CARD_VENDOR` ab ("" = kein Karten-Port).
func CardVendor(cardType string) string {
	switch cardType {
	case "decklink":
		return "decklink"
	case "aja":
		return "aja"
	case "matrox":
		return "custom"
	}
	return ""
}

// CardPortsEnv baut `OMP_CARD_VENDOR`/`OMP_CARD_PORTS` für die geclaimten Ports einer Karten-Instanz.
// `defaultDir` ("in"/"out") gilt nur für Ports ohne `-in`/`-out`-Endung.
func CardPortsEnv(cardType string, portIDs []string, defaultDir string) (map[string]string, error) {
	vendor := CardVendor(cardType)
	if vendor == "" {
		return nil, fmt.Errorf("cardType %q ist keine Capture-Karte", cardType)
	}
	var parts []string
	for _, id := range portIDs {
		seg := strings.Split(id, "-")
		for _, part := range seg {
			if part == "" {
				return nil, fmt.Errorf("portId %q: leeres Segment", id)
			}
		}
		dev, dir := seg[len(seg)-1], defaultDir
		if len(seg) >= 2 && (seg[len(seg)-1] == "in" || seg[len(seg)-1] == "out") {
			dev, dir = seg[len(seg)-2], seg[len(seg)-1]
		}
		if n, err := strconv.Atoi(dev); err != nil || n < 0 {
			return nil, fmt.Errorf("portId %q: Gerätenummer erwartet ([<Hersteller>-]<N>-in | -out)", id)
		}
		if dir != "in" && dir != "out" {
			return nil, fmt.Errorf("portId %q: Richtung in|out erwartet", id)
		}
		parts = append(parts, dev+":"+dir)
	}
	return map[string]string{"OMP_CARD_VENDOR": vendor, "OMP_CARD_PORTS": strings.Join(parts, ",")}, nil
}
