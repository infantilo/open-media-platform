# Patroni-verwaltetes PostgreSQL (ARCHITECTURE.md §19.3, UMSETZUNG.md D15)
# — löst den letzten in D14 offen benannten Control-Plane-SPOF (Postgres
# selbst). Bewusst das ERSTE selbst gebaute Image in diesem Projekt (jeder
# andere Container läuft unverändert von Docker Hub, s. Makefile up) — kein
# vertrauenswürdiges, offiziell gepflegtes "postgres+patroni"-Image
# existiert; Alpines eigenes Repo hat kein `patroni`-Paket (live per `apk
# search` geprüft, 2026-08-18), deshalb `pip install` on top von exakt der
# Basis, die bisher schon lief (`postgres:16-alpine`) — keine neue,
# unbekannte Postgres-Distribution, nur Patroni selbst kommt hinzu.
FROM docker.io/library/postgres:16-alpine

# py3-psycopg2 aus dem Alpine-Repo (vorkompiliert, kein C-Build nötig);
# patroni[etcd3] per pip, da Alpine kein eigenes Paket hat.
# --break-system-packages: dieses Image hat sonst keine Python-Nutzung,
# kein Konflikt mit vom Paketmanager verwalteten Python-Paketen möglich.
RUN apk add --no-cache python3 py3-pip py3-psycopg2 \
    && pip install --break-system-packages --no-cache-dir "patroni[etcd3]==4.1.5" \
    && apk cache clean

COPY bootstrap.yml /home/postgres/bootstrap.yml
COPY post-init.sh /home/postgres/post-init.sh
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /home/postgres/post-init.sh /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/home/postgres/bootstrap.yml"]
