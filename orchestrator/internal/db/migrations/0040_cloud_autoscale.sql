-- Kapitel 35 / 35.5: Autoscaling-Regeln je Pool und Persistenz der gemieteten Hosts (Kostenbuchführung:
-- ein beendeter Host muss nach einem Orchestrator-Neustart weiter in die Tages-/Monatskosten einfließen).
CREATE TABLE IF NOT EXISTS cloud_policies (
    pool        TEXT PRIMARY KEY,
    doc         JSONB NOT NULL,
    updated_by  TEXT NOT NULL DEFAULT '',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cloud_hosts (
    id          TEXT PRIMARY KEY,
    doc         JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
