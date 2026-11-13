-- Kap. 86: Alarm-Ereignisse der Dateiverwaltung (Ort nicht erreichbar / Mount hängt) wurden mit dem Subject
-- omp.file.root.unreachable bzw. omp.file.mount.hung eingereiht. Der Stream OMP_EVENTS deckt nur omp.files.> ab, JetStream
-- nahm sie nie an, die Outbox versuchte sie endlos. Unversendete Altzeilen auf die richtigen Subjects umschreiben.
UPDATE outbox_events SET subject = 'omp.files.root-unreachable' WHERE dispatched_at IS NULL AND subject = 'omp.file.root.unreachable';
UPDATE outbox_events SET subject = 'omp.files.mount-hung'       WHERE dispatched_at IS NULL AND subject = 'omp.file.mount.hung';
