-- Kapitel 27 / P1c: Channel optional an eine Workflow-ROLLE binden statt nur
-- an eine Instanz-ID. Die Instanz-ID wechselt bei jedem Workflow-Neustart,
-- die Rolle (workflow_id + Rollenname) bleibt stabil — gleiches Prinzip wie
-- die workflow-gescopten Rollenbindungen in authz (Kapitel 12 Teil 4).
ALTER TABLE playout_channels ADD COLUMN IF NOT EXISTS workflow_id TEXT NOT NULL DEFAULT '';
ALTER TABLE playout_channels ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS playout_channels_role_uniq ON playout_channels (workflow_id, role) WHERE workflow_id <> '';
