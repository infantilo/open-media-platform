-- Transactional Outbox (Kapitel 21 Phase 4 Teil 1, UMSETZUNG.md §6b/21.4
-- Punkt 4 + A8/B9): löst das "Dual-Write"-Problem für zuverlässige
-- Domain-Events (AssetCreated/AssetPublished/ProcessExecutionCompleted/…)
-- — ein Statuswechsel und das zugehörige Event werden in DERSELBEN
-- Postgres-Transaktion geschrieben (internal/outbox.Store.Enqueue nimmt
-- bewusst ein *sql.Tx, keine *sql.DB), sodass ein Absturz zwischen
-- Commit und Event-Veröffentlichung das Event nie verlieren kann — es
-- steht so oder so bereits durabel in dieser Tabelle. Ein separater
-- Relay-Prozess (internal/outbox.Relay, DB-zustandsgetriebenes Polling,
-- gleiches Entwurfsmuster wie internal/process.Engine) veröffentlicht
-- unversendete Zeilen zu NATS JetStream (bereits als Infrastruktur
-- vorhanden — die NATS-Container laufen seit D14 mit `-js`, bisher nur
-- ungenutzt) für die zuverlässige ZUSTELLSEITE (Replay, Dedup über
-- dedup_key/Nats-Msg-Id, mehrere unabhängige Consumer).
CREATE TABLE IF NOT EXISTS outbox_events (
    id            TEXT PRIMARY KEY,
    subject       TEXT NOT NULL,
    payload       JSONB NOT NULL,
    dedup_key     TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    dispatched_at TIMESTAMPTZ
);

-- Partieller Index nur über unversendete Zeilen — die Tabelle wächst
-- dauerhaft (kein Cleanup in dieser Runde, s. Moduldoku
-- internal/outbox), aber der Relay fragt bei jedem Poll-Zyklus nur
-- "WHERE dispatched_at IS NULL", das soll auch bei vielen bereits
-- versendeten Altzeilen schnell bleiben.
CREATE INDEX IF NOT EXISTS outbox_events_undispatched_idx
    ON outbox_events (created_at) WHERE dispatched_at IS NULL;
