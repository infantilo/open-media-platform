-- Nutzer-/Rollenmodell (ARCHITECTURE.md §12, UMSETZUNG.md D3 Teil 2).
-- Ersetzt die bisherige, handgepflegte data/role-bindings.json (C13-Stub)
-- durch role_bindings; die Bindungs-Semantik (subject/node_id/verb)
-- bleibt bitgleich zum bisherigen consoles.Binding, nur die Quelle
-- wechselt von Datei zu Tabelle, damit sie über eine echte Admin-API
-- (statt Handbearbeitung) verwaltet werden kann.
--
-- users.password_hash ist bcrypt (golang.org/x/crypto/bcrypt, s.
-- docs/decisions.md) — kein Klartext, kein selbstgebautes KDF.
--
-- role_bindings.subject ist der Nutzername (kein user_id-Fremdschlüssel):
-- gleiche Semantik wie das bisherige consoles.Binding.UserID, admin-
-- lesbar/-schreibbar ohne Nutzer-ID nachschlagen zu müssen. AD-Gruppen
-- als zweite Subject-Art (§12 Punkt 1) sind expliziter D3-Restscope
-- (docs/decisions.md) — kein Namespace-Präfix vorab eingebaut, ohne
-- konkrete Anforderung dieser Runde nur Komplexität ohne Test.

CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_bindings (
    id         TEXT PRIMARY KEY,
    subject    TEXT NOT NULL,
    node_id    TEXT NOT NULL,
    verb       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS role_bindings_subject_idx ON role_bindings (subject);

-- Audit-Log (§12 Punkt 4: "Jede schreibende Aktion wird mit Nutzer-
-- Identität protokolliert"). node_id ist nullable, weil nicht jeder
-- geloggte Request node-gescoped ist (z. B. Graph-Edges, Snapshots).
CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGSERIAL PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    username    TEXT NOT NULL,
    method      TEXT NOT NULL,
    path        TEXT NOT NULL,
    node_id     TEXT,
    status      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_log_occurred_at_idx ON audit_log (occurred_at);
