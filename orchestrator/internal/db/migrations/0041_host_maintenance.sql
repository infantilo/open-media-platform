-- Wartungsmodus für Hosts: gesetzt = Host bekommt keine neue Last und wird
-- per Make-before-break geleert (internal/maintenance). Überlebt einen
-- Orchestrator-Neustart.
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS maintenance_since TIMESTAMPTZ;
