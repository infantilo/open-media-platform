//! MXF Multichannel Audio Labeling Framework (SMPTE ST 377-4) mit dem
//! kontrollierten Vokabular aus ST 377-41. Siehe docs/ENTWURF-MXF-MCA.md.

pub mod keys;
pub mod klv;
pub mod model;
pub mod mxf;
pub mod read;
pub mod vocab;

pub use model::{McaFile, McaItems, McaLabel, McaSummary, SoundDescriptor};
pub use mxf::MxfError;
pub mod write;
pub mod testkit;
