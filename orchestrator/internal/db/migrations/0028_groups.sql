-- Gruppenbasierte Rechteverwaltung (Nutzerauftrag 2026-09-24, im
-- Anschluss an die Storage-Backend-Arbeit: "dann gruppen basierte
-- rechteverwaltung", auch als Vorbereitung für eine spätere Windows-
-- Active-Directory-Anbindung — AD synchronisiert typischerweise
-- Gruppenmitgliedschaft, nicht Einzelrechte).
--
-- BEWUSST unabhängig von organizations (Kapitel 21 B14): Organisation
-- ist eine reine Sichtbarkeits-/Mandanten-Grenze (welche Objekte sieht
-- ein Nutzer überhaupt, s. org_enforcement.go), Gruppe ist eine reine
-- Rechte-Bündelung (welche Verben hat ein Nutzer, über role_bindings
-- statt Einzelbindungen). Beide Mechanismen bleiben unabhängig
-- nebeneinander bestehen, keiner ersetzt den anderen.
CREATE TABLE IF NOT EXISTS groups (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    created_by  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mitgliedschaft mit echtem Fremdschlüssel auf users(username) — anders
-- als role_bindings.subject (das TEXT ohne FK bleibt, weil es sowohl
-- Nutzernamen als auch Gruppen-IDs als auch Service-Token-Subjects wie
-- Instanz-IDs tragen kann, s. authz.Store.Create-Doku) kann hier echte
-- referenzielle Integrität durchgesetzt werden: kein Mitglied ohne
-- existierenden Nutzer, und ein gelöschter Nutzer verschwindet
-- automatisch aus jeder Gruppe (ON DELETE CASCADE) statt eine
-- verwaiste Mitgliedschaft zu hinterlassen.
CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, username)
);
CREATE INDEX IF NOT EXISTS group_members_username_idx ON group_members (username);

-- role_bindings.subject_type unterscheidet, ob `subject` einen
-- Nutzernamen/Service-Token-Subject ("user", unverändertes Verhalten,
-- Default für jede Bestandszeile) oder eine groups.id ("group", neu)
-- trägt. KEIN Fremdschlüssel auf groups(id) — dieselbe Spalte trägt je
-- nach subject_type unterschiedliche Referenzräume (Nutzername vs.
-- Gruppen-ID vs. Instanz-ID für Service-Tokens), ein bedingter
-- Fremdschlüssel ist in Postgres nicht ausdrückbar. Löschschutz für
-- Gruppen läuft deshalb auf Anwendungsebene (internal/groups.Store,
-- CountBindings vor DELETE — gleiches Muster wie storagebackends).
ALTER TABLE role_bindings ADD COLUMN IF NOT EXISTS subject_type TEXT NOT NULL DEFAULT 'user';
CREATE INDEX IF NOT EXISTS role_bindings_group_subject_idx ON role_bindings (subject) WHERE subject_type = 'group';
