//! Where Pickforge keeps its per-project state, and who owns what inside it.
//!
//! Path resolution here creates nothing: `doctor` only reports paths. The one
//! writing entry point is [`claim_layout`], which stamps the shared ownership
//! marker.

use std::io::Write;
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

/// The project-state layout this build reads and writes. Version 1 is the
/// layout alpha.1 and alpha.2 already wrote; it is described here rather than
/// changed, so no existing state needs migrating. See `README.md`
/// ("Project state ownership") for the ownership table.
pub const LAYOUT_VERSION: u32 = 1;

/// Discriminator for the marker, so an unrelated `layout.json` is not mistaken
/// for ours.
pub const LAYOUT_KIND: &str = "pickforge-project-state";

/// The shared ownership marker inside a project state directory.
pub const LAYOUT_MARKER: &str = "layout.json";

/// Rust-owned entries: the integration receipt and its backups.
const RECEIPT: &str = "project.json";
const RECEIPT_BACKUP_PREFIX: &str = "project.json.pickforge-backup-";

/// In-flight writes by either tool, always uniquely named.
const TMP_PREFIX: &str = ".pickforge-tmp-";

/// TypeScript-owned entries: the lab's run tree.
const LAB_RUNS: &str = "runs";

/// Who owns one entry directly inside a project state directory. Ownership is
/// by entry name and is exhaustive: an entry that matches no owner is
/// [`Owner::Foreign`] and neither tool may write, move, or delete it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Owner {
    /// The shared layout marker, written once by whichever tool arrives first.
    Shared,
    /// The Rust integration CLI: receipts and their backups.
    Integration,
    /// The TypeScript lab: runs and sessions.
    Lab,
    /// An in-flight write by either tool. Uniquely named, so one left behind
    /// by a crash is inert and safe for its creator to clean up.
    Transient,
    /// Nobody. Refused rather than adopted, migrated, or removed.
    Foreign,
}

/// Classify one entry name inside `<state root>/projects/<project id>`.
/// Must stay in sync with PickLab's TypeScript `classifyEntry`.
pub fn classify_entry(name: &str) -> Owner {
    if name == LAYOUT_MARKER {
        Owner::Shared
    } else if name.starts_with(TMP_PREFIX) {
        Owner::Transient
    } else if name == RECEIPT || name.starts_with(RECEIPT_BACKUP_PREFIX) {
        Owner::Integration
    } else if name == LAB_RUNS {
        Owner::Lab
    } else {
        Owner::Foreign
    }
}

/// The exact bytes of the marker. Both tools write this, so whichever claims a
/// directory first leaves the same content.
pub fn layout_marker_bytes() -> Vec<u8> {
    format!("{{\n  \"layout\": \"{LAYOUT_KIND}\",\n  \"layoutVersion\": {LAYOUT_VERSION}\n}}\n")
        .into_bytes()
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum LayoutError {
    #[error(
        "project state directory {dir} uses layout version {found}, but this \
         Pickforge build only understands version {LAYOUT_VERSION}. \
         Upgrade Pickforge, or run with a different PICKFORGE_HOME."
    )]
    UnsupportedVersion { dir: String, found: u32 },
    #[error(
        "{path} is not a Pickforge layout marker. Move it aside and re-run, \
         or run with a different PICKFORGE_HOME."
    )]
    Unrecognized { path: String },
    #[error("project state layout marker {path} could not be read: {message}")]
    Unreadable { path: String, message: String },
    #[error("project state layout marker {path} could not be written: {message}")]
    Unwritable { path: String, message: String },
}

#[derive(serde::Deserialize)]
struct LayoutMarker {
    layout: String,
    #[serde(rename = "layoutVersion")]
    layout_version: u32,
}

/// Validate an existing marker's bytes against what this build supports.
fn validate_marker(path: &Path, bytes: &[u8]) -> Result<(), LayoutError> {
    let marker: LayoutMarker =
        serde_json::from_slice(bytes).map_err(|_| LayoutError::Unrecognized {
            path: path.display().to_string(),
        })?;
    if marker.layout != LAYOUT_KIND {
        return Err(LayoutError::Unrecognized {
            path: path.display().to_string(),
        });
    }
    if marker.layout_version != LAYOUT_VERSION {
        return Err(LayoutError::UnsupportedVersion {
            dir: path.parent().unwrap_or(path).display().to_string(),
            found: marker.layout_version,
        });
    }
    Ok(())
}

/// Read the marker in `state_dir` when there is one. `Ok(None)` means the
/// directory predates the marker (alpha.1/alpha.2) or does not exist yet;
/// callers treat that as version 1 by adoption, never as a reason to rewrite.
pub fn read_layout(state_dir: &Path) -> Result<Option<u32>, LayoutError> {
    let path = state_dir.join(LAYOUT_MARKER);
    match std::fs::read(&path) {
        Ok(bytes) => {
            validate_marker(&path, &bytes)?;
            Ok(Some(LAYOUT_VERSION))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(LayoutError::Unreadable {
            path: path.display().to_string(),
            message: error.to_string(),
        }),
    }
}

/// Claim `state_dir` for the shared layout, atomically and at most once.
///
/// The marker is written to a private temp file first and published with
/// `link(2)`, which fails with `EEXIST` when the marker already exists. That
/// gives both exclusivity *and* full content in one step: the loser of a race
/// with the TypeScript lab always reads a complete marker, never the empty
/// file an `O_EXCL` create would expose between creation and write. Because
/// the marker is the only thing claimed, a crash before publication leaves at
/// most a `.pickforge-tmp-` file — which `init` already tolerates — rather
/// than partial ownership, and the next run claims the directory. An existing
/// marker is never rewritten.
///
/// Returns whether this call created the marker.
pub fn claim_layout(state_dir: &Path) -> Result<bool, LayoutError> {
    let path = state_dir.join(LAYOUT_MARKER);
    let unwritable = |error: std::io::Error| LayoutError::Unwritable {
        path: path.display().to_string(),
        message: error.to_string(),
    };
    std::fs::create_dir_all(state_dir).map_err(unwritable)?;

    let temp = state_dir.join(format!(
        "{TMP_PREFIX}layout-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let published = publish_marker(&temp, &path);
    // The temp file is ours either way; a failure to remove it is not a
    // reason to fail the claim, since `init` tolerates a stray one.
    let _ = std::fs::remove_file(&temp);

    match published {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            read_layout(state_dir).map(|_| false)
        }
        Err(error) => Err(unwritable(error)),
    }
}

/// Write the marker bytes to `temp`, then publish them at `path` with a link.
fn publish_marker(temp: &Path, path: &Path) -> std::io::Result<()> {
    {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(temp)?;
        file.write_all(&layout_marker_bytes())?;
        file.sync_all()?;
    }
    std::fs::hard_link(temp, path)
}
