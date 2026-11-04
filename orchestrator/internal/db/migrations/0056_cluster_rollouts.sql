-- Cluster-Rolling-Update (Kap. 84): Zustand des Rollouts liegt in Postgres, damit er einen Leader-Wechsel
-- (der Leader wird selbst neu gestartet) übersteht. Höchstens ein aktiver Rollout zugleich.
CREATE TABLE IF NOT EXISTS cluster_rollouts (
    id             TEXT PRIMARY KEY,
    kind           TEXT NOT NULL,             -- 'update' | 'restart'
    package_id     TEXT NOT NULL DEFAULT '',
    target_version TEXT NOT NULL DEFAULT '',
    state          TEXT NOT NULL,             -- running | failed | done | cancelled
    error          TEXT NOT NULL DEFAULT '',
    steps          JSONB NOT NULL DEFAULT '[]',
    created_by     TEXT NOT NULL DEFAULT '',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS cluster_rollouts_one_active
    ON cluster_rollouts ((true)) WHERE state IN ('running', 'failed');
