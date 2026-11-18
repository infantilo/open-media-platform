#!/usr/bin/env bash
# Issue-Vorsortierung (CONTRIBUTING.md). Eingaben nur über Umgebungsvariablen, nie als Shell-Text eingesetzt:
#   GH_TOKEN, REPO, ISSUE (Nummer), TITLE, BODY_FILE, AUTHOR_ASSOC. Das Issue ist nicht vertrauenswürdig:
#   Der Anhang wird nur gelesen und ausgewertet (bundlereport), nie ausgeführt.
set -euo pipefail

body=$(cat "$BODY_FILE")
add=()

# Wert eines Formularfelds (### Überschrift, Text bis zur nächsten Überschrift)
field() { awk -v h="### $1" '$0==h{f=1;next} /^### /{f=0} f' "$BODY_FILE" | sed '/^[[:space:]]*$/d' | head -1; }

area=$(field "Bereich"); sev=$(field "Auswirkung")
case "$area" in
  "Orchestrator / Cluster") add+=("area:orchestrator");;
  "Web-Oberfläche") add+=("area:ui");;
  "Videomischer / Switcher") add+=("area:video-mixer");;
  "Audiomischer") add+=("area:audio-mixer");;
  "Playout / Automation") add+=("area:playout");;
  "Grafik (OGraf)") add+=("area:graphics");;
  "Aufnahme / Ingest / Dateien") add+=("area:ingest");;
  "Gateways (ST 2110, SRT, MXL, NMOS)") add+=("area:gateways");;
  "Host-Agent / Update / Installation") add+=("area:host-install");;
  "Dokumentation") add+=("area:docs");;
esac
case "$sev" in
  "Sendeausfall oder Datenverlust") add+=("severity:critical");;
  "Funktion fällt aus, Umgehung möglich") add+=("severity:major");;
  "Kleinigkeit / kosmetisch") add+=("severity:minor");;
esac

# Hinweis auf Zugangsdaten im Text: nur markieren, nie den Inhalt zitieren
if printf '%s' "$body" | grep -qiE '(password|passwort|token|secret|api[_-]?key)[[:space:]]*[=:][[:space:]]*[^[:space:]]{6,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'; then
  add+=("possible-secret")
  gh issue comment "$ISSUE" --repo "$REPO" --body "⚠️ Der Text sieht nach Zugangsdaten aus (Passwort, Token oder Schlüssel). Bitte prüfe das Issue, entferne sie und ändere sie vorsorglich. Ein Maintainer kann den Text ausblenden."
fi

# Support-Paket suchen, laden, auswerten
url=$(printf '%s' "$body" | grep -oE 'https://github\.com/user-attachments/files/[0-9]+/[A-Za-z0-9._%-]+\.zip' | head -1 || true)
comment=""
if [ -n "$url" ]; then
  tmp=$(mktemp -d)
  (cd orchestrator && go build -o "$tmp/bundlereport" ./cmd/bundlereport)
  if curl -fsSL --max-filesize 52428800 --max-time 120 -o "$tmp/bundle.zip" "$url"; then
    if verdict=$("$tmp/bundlereport" -verdict "$tmp/bundle.zip" 2>"$tmp/err"); then
      add+=("bundle:$verdict")
      gh issue edit "$ISSUE" --repo "$REPO" --remove-label "needs-info" >/dev/null 2>&1 || true
      report=$("$tmp/bundlereport" "$tmp/bundle.zip" | head -c 30000)
      # keine @-Erwähnungen und keine automatischen Verweise aus Paketinhalt auslösen
      report=$(printf '%s' "$report" | sed 's/@/@\xe2\x80\x8b/g; s/\(^\|[^A-Za-z0-9]\)#\([0-9]\)/\1#\xe2\x80\x8b\2/g')
      comment=$(printf '<!-- omp-triage -->\n**Automatische Auswertung des Support-Pakets** (Ampel: `%s`). Eine Hilfe für die Bearbeitung, kein Urteil.\n\n<details><summary>Bericht</summary>\n\n%s\n\n</details>\n' "$verdict" "$report")
    else
      add+=("bundle:unreadable")
      comment=$(printf '<!-- omp-triage -->\nDas Support-Paket konnte nicht ausgewertet werden (kein gültiges Paket oder beschädigt). Bitte ein neues erstellen und die ZIP-Datei unverändert hochladen.')
    fi
  else
    add+=("bundle:unreadable")
    comment=$(printf '<!-- omp-triage -->\nDer Anhang konnte nicht geladen werden (zu groß, über 50 MB, oder nicht erreichbar). Bitte ein kleineres Paket anhängen.')
  fi
  rm -rf "$tmp"
elif printf '%s' "$(field "Bereich")" | grep -q .; then
  # Bug-Formular ohne Paket
  add+=("needs-info")
  comment=$(printf '<!-- omp-triage -->\nDanke für die Meldung. Es fehlt das **Support-Paket** (Support-Tab → „Support-Paket erstellen“, ZIP hier hineinziehen). Ohne Paket ist die Ursache oft nicht zu finden. Wenn es nicht möglich ist, schreibe bitte kurz warum. Ohne Rückmeldung wird das Issue nach 14 Tagen geschlossen.')
fi

# mögliche Duplikate (nur Hinweis, Titelsuche in offenen Issues)
words=$(printf '%s' "$TITLE" | tr -c '[:alnum:]äöüÄÖÜß' ' ' | tr -s ' ' | cut -c1-80)
if [ -n "$words" ]; then
  dups=$(gh issue list --repo "$REPO" --state open --search "$words in:title" --limit 4 --json number,title \
         --jq "[.[]|select(.number != $ISSUE)|\"- #\(.number) \(.title|gsub(\"[\\\\r\\\\n@]\";\" \"))\"]|join(\"\\n\")" || true)
  if [ -n "$dups" ]; then
    add+=("possible-duplicate")
    comment=$(printf '%s\n\nMögliche ähnliche Issues:\n%s\n' "$comment" "$dups")
  fi
fi

# Labels anlegen (idempotent) und setzen
for l in "${add[@]}"; do
  gh label create "$l" --repo "$REPO" --force >/dev/null 2>&1 || true
done
if [ "${#add[@]}" -gt 0 ]; then
  gh issue edit "$ISSUE" --repo "$REPO" --add-label "$(IFS=,; echo "${add[*]}")"
fi
gh issue edit "$ISSUE" --repo "$REPO" --remove-label "needs-triage" >/dev/null 2>&1 || true

# Kommentar: vorhandenen Bot-Kommentar ersetzen statt neu anhängen (Bearbeitungen des Issues)
if [ -n "$comment" ]; then
  old=$(gh api "repos/$REPO/issues/$ISSUE/comments" --jq '[.[]|select(.body|startswith("<!-- omp-triage -->"))|.id][0] // empty' || true)
  if [ -n "$old" ]; then
    gh api -X PATCH "repos/$REPO/issues/comments/$old" -f body="$comment" >/dev/null
  else
    gh issue comment "$ISSUE" --repo "$REPO" --body "$comment"
  fi
fi
