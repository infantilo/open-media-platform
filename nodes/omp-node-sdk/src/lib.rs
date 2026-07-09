//! `omp-node-sdk` — das Crate, das jeder OpenMediaPlatform-Node (intern oder
//! Drittanbieter) einbindet, um den Node-Contract (`ARCHITECTURE.md` §5) zu
//! erfüllen: IS-04-Registrierung+Heartbeat, Descriptor-Self-Describe
//! (`docs/descriptor-v0.schema.json`), Param-/Method-Dispatch über den
//! [`ParamStore`]-Trait, NATS-Health-Publishing. Rust-Pendant zum
//! Go-Mock-Node (`nodes/mock`), als wiederverwendbares Crate statt
//! kopierbarem Beispielcode — siehe `examples/hello_node.rs` für die
//! minimale Nutzung.

pub mod descriptor;
pub mod health;
pub mod idgen;
pub mod is04;
pub mod node;
pub mod server;

pub use descriptor::{Descriptor, MethodArg, MethodSpec, ParamSpec, ParamType, Range};
pub use node::{NodeConfig, NodeHandle, run, start};
pub use server::{InvokeError, ParamStore, SetError};
