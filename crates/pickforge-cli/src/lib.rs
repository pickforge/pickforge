//! Experimental Pickforge CLI internals.
//!
//! The library owns all diagnostics; the `pickforge` binary is a thin adapter
//! that parses arguments, renders a report, and maps readiness to an exit code.

pub mod doctor;
pub mod env;
pub mod project;
pub mod render;
pub mod report;
pub mod state;
mod tools;

pub use doctor::diagnose;
pub use env::Environment;
pub use report::{Check, CheckStatus, DoctorReport, ProjectInfo, SCHEMA_VERSION};
