-- Kapitel 21 B14 (Mandantenfähigkeit, Nachtrag 283) — Nutzerentscheidung
-- 2026-09-23 (UMSETZUNG.md §21.6, Nachtrag 282): (A) reine Zugriffs-
-- Scope-Erweiterung (KEINE echte Daten-Isolation), eine Organisation
-- pro Nutzer, globale Bindungen werden organisationsweit statt wörtlich
-- global.
--
-- `role_bindings` bekommt BEWUSST KEINE eigene `org_id`-Spalte — bei
-- "eine Organisation pro Nutzer" ist die Organisation einer Bindung
-- immer exakt die ihres `subject`-Nutzers, per Join über
-- `users.org_id` ableitbar. Eine zusätzliche Spalte wäre reine
-- Duplikation mit Drift-Risiko (Nutzer wechselt die Organisation, alte
-- Bindungen zeigen die falsche).
--
-- Node-/Instanz-Ressourcen (Launcher) bekommen BEWUSST KEINE
-- Organisationszugehörigkeit — geteilte Infrastruktur (analog
-- Rechenknoten in einem Cluster), kein persistentes Fachobjekt. Welche
-- Workflows/Assets darauf laufen, ist bereits über deren eigene
-- `owner_org_id` unten gescopt.
CREATE TABLE IF NOT EXISTS organizations (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Alle bestehenden Nutzer/Fachobjekte wandern automatisch in diese
-- Default-Organisation — kein Bruch des heutigen Single-Tenant-
-- Verhaltens, bis bewusst eine zweite Organisation angelegt wird
-- (`ADD COLUMN ... DEFAULT 'default'` unten befüllt jede bestehende
-- Zeile automatisch, ohne die Tabelle umzuschreiben, s. Vorbild
-- 0014_session_revocation.sql).
INSERT INTO organizations (id, name) VALUES ('default', 'Default')
    ON CONFLICT (id) DO NOTHING;

ALTER TABLE users ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'default' REFERENCES organizations(id);

-- Persistente, vom Nutzer angelegte Fachobjekte bekommen eine schlanke
-- `owner_org_id` — rein für Sichtbarkeits-/Verwaltungsfilterung
-- (durchgesetzt in internal/httpapi, s. dortige Handler), KEINE
-- Query-seitige Zwangsfilterung in JEDER Store-Methode (das wäre die
-- nicht gewählte Option (B), echte Daten-Isolation).
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS owner_org_id TEXT NOT NULL DEFAULT 'default' REFERENCES organizations(id);
ALTER TABLE process_definitions ADD COLUMN IF NOT EXISTS owner_org_id TEXT NOT NULL DEFAULT 'default' REFERENCES organizations(id);
ALTER TABLE assets ADD COLUMN IF NOT EXISTS owner_org_id TEXT NOT NULL DEFAULT 'default' REFERENCES organizations(id);
ALTER TABLE collections ADD COLUMN IF NOT EXISTS owner_org_id TEXT NOT NULL DEFAULT 'default' REFERENCES organizations(id);

CREATE INDEX IF NOT EXISTS users_org_id_idx ON users (org_id);
CREATE INDEX IF NOT EXISTS workflows_owner_org_id_idx ON workflows (owner_org_id);
CREATE INDEX IF NOT EXISTS process_definitions_owner_org_id_idx ON process_definitions (owner_org_id);
CREATE INDEX IF NOT EXISTS assets_owner_org_id_idx ON assets (owner_org_id);
CREATE INDEX IF NOT EXISTS collections_owner_org_id_idx ON collections (owner_org_id);
