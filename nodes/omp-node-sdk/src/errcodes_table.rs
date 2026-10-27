// GENERIERT aus orchestrator/internal/errcodes/catalog.go — nicht von Hand ändern:
//   cd orchestrator && go run ./cmd/errcodedoc -rust > ../nodes/omp-node-sdk/src/errcodes_table.rs
// Reihenfolge = Reihenfolge der Zuordnung; Schlüsselwörter sind klein geschrieben (Teilstring-Suche).

pub(crate) const TABLE: &[(&str, &[&str])] = &[
    ("OMP-1005", &["no space left on device"]),
    ("OMP-1006", &["permission denied"]),
    ("OMP-1007", &["address already in use"]),
    ("OMP-1010", &["out of memory", "cannot allocate memory"]),
    ("OMP-1011", &["too many open files"]),
    ("OMP-3001", &["no such flow", "flow_def.json"]),
    ("OMP-3002", &["/dev/shm"]),
    ("OMP-3009", &["failed to find element factory", "no such element", "missing plugin", "could not create element"]),
    ("OMP-3010", &["[writer] open_grain", "[writer] commit"]),
    ("OMP-3003", &["not-negotiated", "not negotiated", "could not link", "link failed"]),
    ("OMP-3004", &["internal data stream error", "streaming stopped, reason"]),
    ("OMP-3005", &["no such device", "cannot open video", "cannot open audio", "device is busy", "v4l2", "karte/treiber prüfen"]),
    ("OMP-3006", &["kein video-buffer", "kein audio-buffer", "no video buffer", "no audio buffer"]),
];
