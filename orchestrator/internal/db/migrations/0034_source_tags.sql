-- Kapitel 27 / P4 (E3 = Orchestrator): manuell gesetzte semantische Tags je
-- Quelle (Spec §24). Schlüssel ist (node_id, sender_label), NICHT die Sender-ID:
-- Sender-IDs werden bei jedem Start neu gewürfelt, Node-IDs von Workflow-Rollen
-- sind dagegen stabil (OMP_ROLE_SEED) und das Sender-Label ebenfalls — so
-- überleben die Tags einen Workflow-Neustart. (Ad-hoc gestartete Instanzen
-- haben eine zufällige Node-ID; ihre Tags gehen mit der Instanz verloren.)
-- Gespeichert wird nur EXPLICIT; abgeleitete (DERIVED) und vom Node gemeldete
-- (DISCOVERED) Tags werden beim Lesen berechnet.
CREATE TABLE IF NOT EXISTS source_tags (
    node_id      TEXT NOT NULL,
    sender_label TEXT NOT NULL,
    tag          TEXT NOT NULL,
    created_by   TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (node_id, sender_label, tag)
);
