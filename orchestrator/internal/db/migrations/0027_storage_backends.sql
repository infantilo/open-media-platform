-- Super-admin-verwaltete Storage-Backends (Nutzerauftrag 2026-09-24:
-- "asset folder should be able to be dynamically added/removed
-- without the need of restart the whole orchestrator. only super
-- admins may config this... i dont like hidden configs at all").
--
-- Getrennt von asset.StorageLocation (Provider+URI-Wertpaar auf JEDER
-- einzelnen Representation, s. 0019_assets.sql) — ein Backend ist die
-- dahinterliegende, wiederverwaltete Infrastruktur-Ressource (Endpoint/
-- Bucket/Zugangsdaten) mit eigenem Lebenszyklus, auf die mehrere
-- Representations gleichzeitig verweisen können (Nutzerentscheidung:
-- "mehrere gleichzeitig" statt einer einzelnen austauschbaren Instanz).
--
-- secret_key liegt AES-256-GCM-verschlüsselt vor (internal/
-- storagebackends/crypto.go), nie im Klartext in dieser Tabelle — der
-- Masterschlüssel selbst kommt aus OMP_STORAGE_SECRET_KEY (Env-Var,
-- s. internal/config/config.go-Doku: das eine zwangsläufig außerhalb
-- der UI verbleibende Geheimnis, da es die übrigen Geheimnisse
-- verschlüsselt).
CREATE TABLE IF NOT EXISTS storage_backends (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    -- provider frei wie asset.Type (keine Enum) — "minio"/"s3" heute,
    -- kein geschlossener Satz.
    provider    TEXT NOT NULL,
    endpoint    TEXT NOT NULL,
    bucket      TEXT NOT NULL,
    access_key  TEXT NOT NULL,
    secret_key  BYTEA NOT NULL,
    use_ssl     BOOLEAN NOT NULL DEFAULT false,
    -- status: "active" (nimmt neue Uploads an) | "deprecated" (liefert
    -- bestehende Dateien weiter aus, aber keine neuen Uploads mehr —
    -- der "Schutz-Mechanismus" zwischen "aktiv" und "hart gelöscht",
    -- s. httpapi.handleDeprecateStorageBackend-Doku).
    status      TEXT NOT NULL DEFAULT 'active',
    created_by  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Representations bekommen eine optionale Referenz auf ihr Backend
-- (NULL = älterer/manueller Eintrag ohne echten Objektspeicher-Upload,
-- z. B. ein reiner Dateipfad-Verweis, s. 0019_assets.sql). Bewusst OHNE
-- ON DELETE CASCADE/SET NULL: der Standard-Fremdschlüssel-Schutz
-- (NO ACTION) blockiert ein DELETE auf ein noch referenziertes Backend
-- automatisch mit einem echten Fremdschlüssel-Fehler — derselbe,
-- bereits bewährte Schutz-Mechanismus wie organizations.Store.Delete
-- (Nachtrag 283), kein zusätzlicher Code nötig.
ALTER TABLE representations ADD COLUMN IF NOT EXISTS storage_backend_id TEXT REFERENCES storage_backends(id);
CREATE INDEX IF NOT EXISTS representations_storage_backend_idx ON representations (storage_backend_id);
