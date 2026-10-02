-- Kapitel 29: Einstellungen über die UI statt Umgebungsvariablen.
-- node_option_values: Werte der Node-Optionen (deploy/node-options.json) je
-- Node-Typ (scope='type', subject = Typ) oder je Instanz (scope='instance',
-- subject = Instanz-ID). Der Launcher setzt sie beim (Neu-)Start als Umgebung.
-- orchestrator_settings: Betriebswerte des Orchestrators (Aufbewahrung,
-- Schwellwerte, …); sie überschreiben beim Start die Umgebung/Defaults.
CREATE TABLE IF NOT EXISTS node_option_values (
    scope      TEXT NOT NULL CHECK (scope IN ('type', 'instance')),
    subject    TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (scope, subject, key)
);

CREATE TABLE IF NOT EXISTS orchestrator_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
