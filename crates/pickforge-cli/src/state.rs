//! Where Pickforge keeps its per-project state. Nothing here creates
//! directories: `doctor` only reports paths.

use std::path::{Path, PathBuf};

use thiserror::Error;

/// The only state-root override in this PR.
pub const HOME_ENV_VAR: &str = "PICKFORGE_HOME";

#[derive(Debug, Error, PartialEq, Eq)]
pub enum StateError {
    #[error("{HOME_ENV_VAR} must be an absolute path, got \"{0}\"")]
    RelativeOverride(String),
    #[error("no home directory could be resolved")]
    NoHomeDirectory,
}

/// The state root: `PICKFORGE_HOME` when set to a non-empty absolute path,
/// otherwise `<home>/.pickforge/pickforge`. An empty override behaves as unset.
pub fn state_root(env: &crate::env::Environment) -> Result<PathBuf, StateError> {
    if let Some(raw) = env.var(HOME_ENV_VAR) {
        if !raw.is_empty() {
            let path = PathBuf::from(raw);
            if !path.is_absolute() {
                return Err(StateError::RelativeOverride(
                    path.to_string_lossy().to_string(),
                ));
            }
            return Ok(path);
        }
    }

    env.home_dir()
        .map(|home| home.join(".pickforge").join("pickforge"))
        .ok_or(StateError::NoHomeDirectory)
}

/// `<state root>/projects/<project id>`.
pub fn project_state_dir(root: &Path, project_id: &str) -> PathBuf {
    root.join("projects").join(project_id)
}
