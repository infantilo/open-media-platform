-- Kapitel 14 Teil 3 (docs/END-GOAL-FEATURES.md §14.3c): Verbrauchsprofile
-- pro Node-Typ, aggregiert aus den seit Teil 2 vorhandenen Pro-Instanz-
-- Samples. host_id = '*' ist ein reservierter Sentinel-Wert für das
-- Typ-Fallback-Profil über alle Hosts hinweg (§14.3c: "ein neuer Host
-- ohne eigene Messhistorie erbt das Typ-Profil") — echte Host-IDs können
-- diesen Wert nicht annehmen (host-agent-generierte IDs), '' ist bereits
-- durch die bestehende Konvention "lokal gestartete Instanz" belegt
-- (launcher.Instance.HostID) und bleibt deshalb ein eigener, echter
-- Eintrag statt des globalen Fallbacks.
CREATE TABLE IF NOT EXISTS node_type_profiles (
    node_type    TEXT NOT NULL,
    host_id      TEXT NOT NULL,
    cpu_min      DOUBLE PRECISION NOT NULL,
    cpu_avg      DOUBLE PRECISION NOT NULL,
    cpu_max      DOUBLE PRECISION NOT NULL,
    cpu_p95      DOUBLE PRECISION NOT NULL,
    rss_min      BIGINT NOT NULL,
    rss_avg      BIGINT NOT NULL,
    rss_max      BIGINT NOT NULL,
    sample_count INTEGER NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (node_type, host_id)
);
