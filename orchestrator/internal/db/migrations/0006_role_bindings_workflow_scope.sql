-- Workflow-Scope-AuthZ (ARCHITECTURE.md §12 Punkt 2, Kapitel 12 Teil 4,
-- docs/END-GOAL-FEATURES.md §12.3e): eine Rollenbindung kann jetzt
-- zusätzlich zum globalen/Node-gescopten Wirkungsbereich (unverändert,
-- workflow_id = '') an einen Workflow gebunden werden. In diesem Fall
-- ist node_id keine Instanz-/Node-ID mehr, sondern der stabile
-- Rollenname aus workflows.Definition.Roles ("*" = der ganze Workflow)
-- — Rollennamen überleben einen Workflow-Neustart, Instanz-IDs nicht
-- (jeder Start()/Resume() vergibt neue).
ALTER TABLE role_bindings ADD COLUMN IF NOT EXISTS workflow_id TEXT NOT NULL DEFAULT '';
