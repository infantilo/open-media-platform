-- Kap. 103 (D7): abgeschottete MXL-Domains — Nodes laufen in einer Mount-Sandbox, die nur ihre Domain sieht.
-- Gilt ab dem Anlegen (nachträgliches Umschalten gäbe laufenden Instanzen eine falsche Umgebung).
ALTER TABLE mxl_domains ADD COLUMN IF NOT EXISTS isolated BOOLEAN NOT NULL DEFAULT false;
