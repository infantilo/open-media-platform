-- Kapitel 21 Phase 3 Teil 1 (Runtime, internal/process/engine.go):
-- die Engine legt pro (Execution, Step) genau eine StepExecution-Zeile
-- an ("get-or-create", A3: idempotente Schritt-Ausführung). Ohne eine
-- Unique-Constraint könnten zwei gleichzeitig laufende Engine-Polls
-- (z. B. während einer Wiederanlauf-Überschneidung, RecoverAll) je
-- einen eigenen INSERT ausführen und die Zeile verdoppeln — die
-- Constraint macht "get-or-create" per `INSERT … ON CONFLICT DO
-- NOTHING` atomar statt eines racy Check-dann-Insert.
ALTER TABLE process_step_executions
    ADD CONSTRAINT process_step_executions_execution_step_unique
    UNIQUE (process_execution_id, step_id);
