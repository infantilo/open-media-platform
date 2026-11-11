-- Active-Directory-/LDAP-Anbindung (Nutzerauftrag 2026-11-11).
--
-- users.source: 'local' (Passwort-Hash in OMP) oder 'ldap' (Anmeldung per Bind gegen das
-- Verzeichnis; password_hash ist dann das unbrauchbare Zeichen '!' und passt auf keinen bcrypt-Hash).
-- Bestandsnutzer sind 'local'.
ALTER TABLE users ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'local';

-- Abbildung Verzeichnisgruppe -> OMP-Gruppe. ldap_group ist ein DN oder ein CN (Vergleich ohne
-- Groß-/Kleinschreibung). Bei jeder Anmeldung eines Verzeichnisnutzers werden seine Mitgliedschaften
-- in genau den hier abgebildeten OMP-Gruppen nachgeführt (nur diese; von Hand gepflegte Mitgliedschaften
-- in anderen Gruppen bleiben unberührt).
CREATE TABLE IF NOT EXISTS ldap_group_map (
    ldap_group TEXT NOT NULL,
    group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (ldap_group, group_id)
);
