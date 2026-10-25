#!/usr/bin/env bash
# Hält die Image-Digests aktuell (Audit 2026-10-23): liest deploy/images.env, löst jedes `repo:tag` in der Registry neu auf und
# schreibt den Digest dorthin zurück — in images.env selbst und in die Dateien, die den Bezug nicht aus images.env lesen können
# (Quadlets, GitHub-Workflows). Tags ändern sich dabei nie; eine neue Version wird zuerst in images.env als Tag eingetragen.
#
#   ./deploy/dev/update-image-pins.sh           Digests neu auflösen und eintragen
#   ./deploy/dev/update-image-pins.sh --check   nur prüfen (Exit 1, wenn ein Digest abweicht oder fehlt)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENVF="$ROOT/deploy/images.env"
MODE=write; [ "${1:-}" = "--check" ] && MODE=check
EXTERNAL=("$ROOT"/deploy/quadlets/*.container "$ROOT"/.github/workflows/ci.yml "$ROOT"/deploy/patroni/Dockerfile)
bad=0
while IFS='=' read -r name val; do
  case "$name" in ''|\#*) continue ;; esac
  base="${val%%@*}"                       # repo:tag
  old="${val#*@}"; [ "$old" = "$val" ] && old=""
  new="$("$ROOT/deploy/dev/resolve-image-digest.sh" "$base")"
  if [ "$new" != "$old" ]; then
    echo "$name: $base  ${old:-(ohne Digest)} → $new"
    bad=1
  fi
  [ "$MODE" = write ] || continue
  repl="$base@$new"
  esc_base="$(printf '%s' "$base" | sed 's/[.[\*^$/]/\\&/g')"
  sed -i -E "s#^$name=.*#$name=$repl#" "$ENVF"
  for f in "${EXTERNAL[@]}"; do
    [ -f "$f" ] || continue
    sed -i -E "s#${esc_base}(@sha256:[0-9a-f]{64})?#${repl}#g" "$f"
  done
done < "$ENVF"
if [ "$MODE" = check ]; then
  [ "$bad" = 0 ] && echo "Alle Digests aktuell." || { echo "Digests weichen ab — ./deploy/dev/update-image-pins.sh ausführen." >&2; exit 1; }
else
  [ "$bad" = 0 ] && echo "Keine Änderungen." || echo "Aktualisiert. Danach make preflight/up prüfen und committen."
fi
