-- Prozess-Engine-Domäne (Kapitel 21 Phase 2, UMSETZUNG.md §6b/21.3+21.4)
-- — bewusst NICHT die bestehende `workflows`-Tabelle erweitert: ein
-- Workflow dort ist ein Deployment-Bündel aus Node-Rollen (Regieplatz),
-- ein "Process" hier ist ein Business-Prozess-Schritt-Graph. Zwei fachlich
-- grundverschiedene Konzepte, siehe die dortige Namenskollisions-Analyse
-- (vom Nutzer bestätigt, 2026-09-22) — getrennte Tabellen, getrenntes
-- Go-Paket (internal/process), getrennter künftiger API-Namensraum.
--
-- Anders als `workflows` (ein Blob pro Aggregat, s. 0004_workflows.sql)
-- sind Executions/StepExecutions/HumanTasks hier eigenständig relational
-- statt in einem JSONB-Blob verschachtelt: sie müssen unabhängig gelistet/
-- gefiltert werden (laufende Executions, Tasks je Assignee, Historie je
-- Execution — A9: "GET .../history", "GET .../tasks", "GET /human-tasks"),
-- was ein Blob-Scan nicht effizient leisten könnte. Nur der Schritt-Graph
-- selbst (Definition.Steps/Triggers) bleibt JSONB, weil er immer als
-- Ganzes gelesen/versioniert wird (wie eine Workflow-Definition).

CREATE TABLE IF NOT EXISTS process_definitions (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category    TEXT NOT NULL DEFAULT '',
    created_by  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Eine ProcessVersion ist nach dem Publish unveränderlich (A7: "Eine
-- laufende Instance muss mit ihrer ursprünglichen Version weiterlaufen
-- können") — durchgesetzt in internal/process.Store (kein UPDATE auf
-- definition nach status=published), nicht per SQL-Constraint (dieselbe
-- Ebene wie die Publish-Semantik der Katalog-Versionierung, §17 Teil 5).
CREATE TABLE IF NOT EXISTS process_versions (
    id                    TEXT PRIMARY KEY,
    process_definition_id TEXT NOT NULL REFERENCES process_definitions(id) ON DELETE CASCADE,
    version_number        INTEGER NOT NULL,
    status                TEXT NOT NULL DEFAULT 'draft',
    definition            JSONB NOT NULL,
    created_by            TEXT NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at          TIMESTAMPTZ,
    UNIQUE (process_definition_id, version_number)
);

CREATE INDEX IF NOT EXISTS process_versions_definition_idx ON process_versions (process_definition_id);

-- row_version = optimistisches Locking (A3: "optimistic concurrency bzw.
-- geeignete Locking-Mechanismen") — jedes UPDATE erhöht es und prüft den
-- zuvor gelesenen Wert per WHERE-Klausel (Store.UpdateExecutionStatus),
-- damit zwei gleichzeitige Schreiber (z. B. Timeout-Ticker und
-- Nutzer-Cancel) einander nicht stillschweigend überschreiben.
CREATE TABLE IF NOT EXISTS process_executions (
    id                    TEXT PRIMARY KEY,
    process_definition_id TEXT NOT NULL REFERENCES process_definitions(id),
    process_version_id    TEXT NOT NULL REFERENCES process_versions(id),
    status                TEXT NOT NULL DEFAULT 'pending',
    correlation_id        TEXT NOT NULL,
    causation_id          TEXT,
    parent_execution_id   TEXT REFERENCES process_executions(id),
    trace_id              TEXT,
    input                 JSONB NOT NULL DEFAULT '{}',
    output                JSONB NOT NULL DEFAULT '{}',
    error                 TEXT NOT NULL DEFAULT '',
    created_by            TEXT NOT NULL,
    row_version           INTEGER NOT NULL DEFAULT 1,
    started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS process_executions_definition_idx ON process_executions (process_definition_id);
CREATE INDEX IF NOT EXISTS process_executions_status_idx ON process_executions (status);
CREATE INDEX IF NOT EXISTS process_executions_correlation_idx ON process_executions (correlation_id);
CREATE INDEX IF NOT EXISTS process_executions_parent_idx ON process_executions (parent_execution_id);

CREATE TABLE IF NOT EXISTS process_step_executions (
    id                  TEXT PRIMARY KEY,
    process_execution_id TEXT NOT NULL REFERENCES process_executions(id) ON DELETE CASCADE,
    step_id             TEXT NOT NULL,
    step_type           TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending',
    attempt             INTEGER NOT NULL DEFAULT 1,
    input               JSONB NOT NULL DEFAULT '{}',
    output              JSONB NOT NULL DEFAULT '{}',
    error                TEXT NOT NULL DEFAULT '',
    row_version          INTEGER NOT NULL DEFAULT 1,
    started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS process_step_executions_execution_idx ON process_step_executions (process_execution_id);

CREATE TABLE IF NOT EXISTS human_tasks (
    id                   TEXT PRIMARY KEY,
    process_execution_id TEXT NOT NULL REFERENCES process_executions(id) ON DELETE CASCADE,
    step_execution_id    TEXT REFERENCES process_step_executions(id) ON DELETE CASCADE,
    title                TEXT NOT NULL,
    description          TEXT NOT NULL DEFAULT '',
    assignee             TEXT NOT NULL DEFAULT '',
    role                 TEXT NOT NULL DEFAULT '',
    priority             TEXT NOT NULL DEFAULT 'normal',
    status               TEXT NOT NULL DEFAULT 'pending',
    decision             TEXT NOT NULL DEFAULT '',
    comment              TEXT NOT NULL DEFAULT '',
    row_version          INTEGER NOT NULL DEFAULT 1,
    deadline             TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS human_tasks_execution_idx ON human_tasks (process_execution_id);
CREATE INDEX IF NOT EXISTS human_tasks_assignee_idx ON human_tasks (assignee);
CREATE INDEX IF NOT EXISTS human_tasks_status_idx ON human_tasks (status);
