# Making a node diagnosable

- `media_ready`: use `MediaReadySource::Probe` when flow can be measured, `Unknown` when not, `NotApplicable` for control-plane nodes. Never report ready by default.
- Rate KPI: `handle.register_rate_kpi("video_fps", counter)` with a monotonic `Arc<AtomicU64>`; the health beat publishes events per second.
- Pipeline snapshot (feature `mxl` of `omp-mediaio`): `omp_node_sdk::diag::register("main", Arc::new(move || omp_mediaio::diag::snapshot(&pipeline)))`; served at `GET /diag/pipelines`.
- Errors: wrap pipeline error messages with `omp_node_sdk::errcode::tag(msg)` so they carry `[OMP-nnnn]`; the catalog is `docs/FEHLERCODES.md`.
- Link, sync and standard health: BCP-008 monitors in `omp_node_sdk::bcp008`.
- Check the result in the GUI: node tile, diagnosis button (stethoscope).
