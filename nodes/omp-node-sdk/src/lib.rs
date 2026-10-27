//! `omp-node-sdk` — das Crate, das jeder OpenMediaPlatform-Node (intern oder
//! Drittanbieter) einbindet, um den Node-Contract (`ARCHITECTURE.md` §5) zu
//! erfüllen: IS-04-Registrierung+Heartbeat, Descriptor-Self-Describe
//! (`docs/descriptor-v0.schema.json`), Param-/Method-Dispatch über den
//! [`ParamStore`]-Trait, NATS-Health-Publishing. Rust-Pendant zum
//! Go-Mock-Node (`nodes/mock`), als wiederverwendbares Crate statt
//! kopierbarem Beispielcode — siehe `examples/hello_node.rs` für die
//! minimale Nutzung.

mod https;
pub mod bcp008;
pub mod buildinfo;
pub mod channelmapping;
pub mod connection;
pub mod descriptor;
pub mod diag;
pub mod health;
pub mod idgen;
pub mod is04;
pub mod kpi;
pub mod liveness;
pub mod node;
pub mod nodeauth;
pub mod panicguard;
pub mod peer;
pub mod plugins;
pub mod server;
pub mod tally_giver;
pub mod transports;

pub use bcp008::{HealthLevel, Monitor, MonitorKind};
pub use descriptor::{
    Descriptor, LatencyInfo, LatencyRange, MethodArg, MethodSpec, ParamSpec, ParamType, Range,
};
pub use liveness::LivenessMonitor;
pub use node::{MediaReadySource, NodeConfig, NodeHandle, ReceiverSpec, SenderSpec, run, start};
pub use peer::{PeerClient, resolve_owning_node_href};
pub use plugins::{PluginInfo, PluginRegistry};
pub use server::{InvokeError, ParamStore, RawResponse, RouteRequest, SetError};

/// Inhalt von `GET /https-info` (`{"enabled":bool,"port":N,"url":…}`) für Nodes, die ihre HTTPS-Adresse selbst brauchen.
pub fn https_info() -> serde_json::Value {
    https::info_json()
}
