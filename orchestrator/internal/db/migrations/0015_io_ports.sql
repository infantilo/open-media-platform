-- I/O-Karten als erstklassige Host-Ressource (ARCHITECTURE.md §6.1
-- Erweiterung 2026-07-10, UMSETZUNG.md D13) — diskrete, exklusive
-- Ressourcen (ein Port ist belegt oder frei), im Unterschied zu den
-- kontinuierlichen CPU/RAM-Metriken (internal/hosts.Metrics, ephemer
-- über NATS, nicht in Postgres).
--
-- Zwei getrennte Tabellen statt einer Erweiterung von hosts.capabilities
-- (dort ursprünglich als künftiger Platz vorgesehen, s. 0003_hosts.sql-
-- Kommentar): capabilities ist ein opakes, nur beim Registrieren
-- geschriebenes Blob ohne Query-/Constraint-Fähigkeit — ein atomarer
-- Claim ("genau ein Aufrufer bekommt einen bestimmten freien Port")
-- braucht echte Zeilen mit einem PRIMARY KEY, den Postgres selbst gegen
-- gleichzeitige Aufrufer schützt (s. ioports.Store.Claim), nicht das
-- übliche Read-JSON-Modify-Write-JSON-Muster eines Blobs.
--
-- host_io_ports: das vom Host-Agent beim Registrieren gemeldete
-- statische Geräte-Inventar (welche Ports existieren überhaupt) — s.
-- ARCHITECTURE.md §18.4 Punkt 1 ("Kartentyp, Port-Anzahl/-Richtung").
-- port_id ist vom Host-Agent vergeben und muss nur innerhalb EINES
-- Hosts eindeutig/stabil sein (z. B. "decklink-0-in").
CREATE TABLE IF NOT EXISTS host_io_ports (
    host_id    TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    port_id    TEXT NOT NULL,
    card_type  TEXT NOT NULL,
    direction  TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    label      TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (host_id, port_id)
);

-- io_port_claims: die dynamische Belegung — welche Workflow-Rolle hält
-- diesen Port gerade (ARCHITECTURE.md §18.4 Punkt 2 "frei / belegt durch
-- Instanz X"). Der PRIMARY KEY (host_id, port_id) IST der
-- Exklusivitäts-Mechanismus: ein zweiter gleichzeitiger Claim-Versuch
-- auf denselben Port scheitert an genau diesem Constraint (bzw. wird
-- durch `... ON CONFLICT DO NOTHING` in ioports.Store.Claim sauber als
-- "0 Zeilen betroffen" statt eines SQL-Fehlers sichtbar) — funktioniert
-- unverändert korrekt, egal wie viele Orchestrator-Instanzen (D12)
-- gleichzeitig einen Start anstoßen, ohne eigene Anwendungs-Sperre.
-- workflow_id+role statt einer Fremdschlüssel-Beziehung auf workflows.id
-- (workflows.data ist ein opakes JSONB-Blob ohne pro-Rolle-Zeilen, s.
-- 0001_layouts_snapshots.sql-Konvention) — Freigabe erfolgt gezielt über
-- (workflow_id, role), s. ioports.Store.Release.
CREATE TABLE IF NOT EXISTS io_port_claims (
    host_id     TEXT NOT NULL,
    port_id     TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    role        TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    claimed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (host_id, port_id),
    FOREIGN KEY (host_id, port_id) REFERENCES host_io_ports(host_id, port_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS io_port_claims_workflow_role_idx ON io_port_claims (workflow_id, role);
