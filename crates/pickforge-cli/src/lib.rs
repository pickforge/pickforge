//! Experimental Pickforge CLI internals.
//!
//! The library owns all diagnostics; the `pickforge` binary is a thin adapter
//! that parses arguments, renders a report, and maps readiness to an exit code.

pub mod adapters;
pub mod doctor;
pub mod env;
pub mod evidence;
pub mod init;
pub mod project;
pub mod render;
pub mod report;
pub mod state;
mod tools;
pub mod transaction;

pub use doctor::diagnose;
pub use env::Environment;
pub use evidence::{record, EvidenceError, RecordResult};
pub use init::{apply_init, plan_init, ApplyReport, InitPlan, InitPlanReport, InitRequest};
pub use report::{Check, CheckStatus, DoctorReport, ProjectInfo, SCHEMA_VERSION};
