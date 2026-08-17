//! Executable discovery. Tools are only located on `PATH`, never executed, and
//! never passed through a shell.

use std::path::PathBuf;

use crate::env::Environment;

/// Locate `name` on the supplied `PATH`. Returns `None` when `PATH` is unset,
/// empty, or holds no match.
pub fn find_on_path(env: &Environment, name: &str) -> Option<PathBuf> {
    let path = env.path()?;
    if path.is_empty() {
        return None;
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    which::which_in(name, Some(path), cwd).ok()
}
