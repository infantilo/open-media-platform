-- Sicherheitskopie gesicherter Rollen-Zustaende (Nutzerfund 2026-11-09: "OGraf folgt PIPs (Demo)" verlor beim Start alle
-- Einstellungen). Schrumpft ein gesicherter Zustand (leerer Ist-Stand ueberschreibt einen guten, Loeschen), bleibt der
-- vorherige je Rolle hier erhalten und laesst sich zurueckkopieren.
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS role_state_backup JSONB NOT NULL DEFAULT '{}'::jsonb;
