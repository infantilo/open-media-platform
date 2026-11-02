package review

import "fmt"

// HDR-Kennzeichnung einer Datei (Kapitel 79). ffprobe liefert color_transfer/color_primaries/color_space; abgebildet
// wird auf die Begriffe von NMOS IS-04 v1.3 (`transfer_characteristic`: SDR, HLG, PQ):
//
//	color_transfer smpte2084   → PQ   (ITU-R BT.2100 / SMPTE ST 2084)
//	color_transfer arib-std-b67 → HLG  (ITU-R BT.2100 / ARIB STD-B67)
//	sonst (bt709, smpte170m, …)  → SDR; fehlt die Angabe → „nicht gekennzeichnet“ (kein Fehler, aber Hinweis)
//
// Geprüft wird: (1) Kennzeichnung gegen die Profilerwartung `expect.transfer`, (2) Plausibilität: HDR braucht
// mindestens 10 Bit und BT.2020-Primärfarben. Mastering-Display-Daten und MaxCLL/MaxFALL sind nicht Teil dieser
// Prüfung (ffprobe liefert sie nur aus den Bild-Metadaten).

// TransferOf bildet ffprobes color_transfer auf SDR/HLG/PQ ab; known=false, wenn die Angabe fehlt.
func TransferOf(colorTransfer string) (transfer string, known bool) {
	switch colorTransfer {
	case "smpte2084":
		return "PQ", true
	case "arib-std-b67":
		return "HLG", true
	case "", "unknown", "unspecified":
		return "SDR", false
	}
	return "SDR", true
}

func (q *qcCtx) colorimetry(v map[string]any, depth int) {
	ct, prim, space := gs(v, "color_transfer"), gs(v, "color_primaries"), gs(v, "color_space")
	tr, known := TransferOf(ct)
	measured := map[string]any{"transfer": tr, "colorTransfer": ct, "colorPrimaries": prim, "colorSpace": space, "bitDepth": depth, "labelled": known}
	msg := fmt.Sprintf("Kennzeichnung %s (color_transfer=%s, primaries=%s)", tr, orDash(ct), orDash(prim))
	if !known {
		msg = "Übertragungsfunktion nicht gekennzeichnet (SDR angenommen)"
	}
	status, sev := CheckPass, SevInfo
	if !known {
		status, sev = CheckWarning, SevMinor
	}
	if tr != "SDR" {
		if depth > 0 && depth < 10 {
			status, sev = CheckFail, SevMajor
			msg += fmt.Sprintf(" — HDR braucht mindestens 10 Bit, die Datei hat %d Bit", depth)
		}
		if prim != "bt2020" {
			if status == CheckPass {
				status, sev = CheckWarning, SevMinor
			}
			msg += fmt.Sprintf(" — HDR erwartet BT.2020-Primärfarben, gekennzeichnet ist %s", orDash(prim))
		}
	}
	e := q.prof.Expect.Transfer
	thr := map[string]any{}
	if e != "" && e != "any" {
		thr["transfer"] = e
		if !equalFold(tr, e) {
			status, sev = CheckFail, SevMajor
			msg += fmt.Sprintf(" — erwartet: %s", e)
		}
	}
	q.add(Finding{CheckID: "video.colorimetry", Category: CatVideo, Status: status, Severity: sev, Message: msg, Measured: measured, Threshold: thr})
}

func orDash(s string) string {
	if s == "" {
		return "–"
	}
	return s
}

func equalFold(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		x, y := a[i], b[i]
		if x >= 'A' && x <= 'Z' {
			x += 'a' - 'A'
		}
		if y >= 'A' && y <= 'Z' {
			y += 'a' - 'A'
		}
		if x != y {
			return false
		}
	}
	return true
}
