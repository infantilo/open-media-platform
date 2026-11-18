-- Kap. 103: getrennte MXL-Domains auf einem Host (docs/ENTWURF-MXL-DOMAIN-TRENNUNG.md, Schritt D1).
-- Die Standarddomain (OMP_MXL_DOMAIN) ist nicht hier gespeichert, sondern implizit "default".
CREATE TABLE IF NOT EXISTS mxl_domains (
    name        TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    created_by  TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
