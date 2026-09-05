//! Where Pickforge keeps its per-project state, and who owns what inside it.
//!
//! Path resolution here creates nothing: `doctor` only reports paths. The one
//! writing entry point is [`claim_layout`], which validates the directory and
//! stamps the shared ownership marker. Every Rust writer of project state —
//! `pickforge init` and `pickforge evidence record` — goes through it, so the
//! layout version, the marker's shape, and the direct-entry ownership rule are
//! enforced on exactly one path.

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
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

/// The run tree. The lab creates and manages it, and `pickforge evidence
/// record` writes its own run directories into it, so it is shared.
const RUNS: &str = "runs";

/// A marker larger than this is not one of ours; refuse it without reading it.
const MAX_MARKER_BYTES: u64 = 64 * 1024;

/// A marker is briefly multiply linked while its writer publishes it with
/// `link(2)` and unlinks the staging entry. Readers wait out that window
/// before concluding a marker is a planted hard link.
const LINK_SETTLE_ATTEMPTS: usize = 40;
const LINK_SETTLE_PAUSE: std::time::Duration = std::time::Duration::from_millis(5);

/// Who owns one entry directly inside a project state directory. Ownership is
/// by entry name and is exhaustive: an entry that matches no owner is
/// [`Owner::Foreign`] and neither tool may write, move, or delete it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Owner {
    /// Written by both tools: the layout marker, and the run tree that the lab
    /// manages and `pickforge evidence record` also writes into. Neither tool
    /// deletes or rewrites what the other put there.
    Shared,
    /// The Rust integration CLI: receipts and their backups.
    Integration,
    /// An in-flight write by either tool. Uniquely named, so one left behind
    /// by a crash is inert and never adopted as another invocation's staging
    /// entry.
    Transient,
    /// Nobody. Refused rather than adopted, migrated, or removed.
    Foreign,
}

/// Classify one entry name inside `<state root>/projects/<project id>`.
/// Must stay in sync with PickLab's TypeScript `classifyEntry`;
/// `test/fixtures/state-layout.json` is the one table both suites check.
pub fn classify_entry(name: &str) -> Owner {
    if name == LAYOUT_MARKER || name == RUNS {
        Owner::Shared
    } else if name.starts_with(TMP_PREFIX) {
        Owner::Transient
    } else if name == RECEIPT || name.starts_with(RECEIPT_BACKUP_PREFIX) {
        Owner::Integration
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
    /// The marker or a directory entry exists but has a shape Pickforge will
    /// not adopt. Carries the exact manual action.
    #[error("{action}")]
    Refused { action: String },
    #[error("project state layout marker {path} could not be read: {message}")]
    Unreadable { path: String, message: String },
    #[error("project state layout marker {path} could not be written: {message}")]
    Unwritable { path: String, message: String },
}

// --- the manual action ---------------------------------------------------

/// Quote one argument for POSIX `sh`, or `None` when it cannot be rendered as
/// a shell word safely (control or bidi-control characters would be mangled by
/// the terminal-safe escaping every message goes through).
fn shell_quote(value: &Path) -> Option<String> {
    let text = value.to_str()?;
    if text.chars().any(|character| {
        character.is_control()
            || matches!(
                character,
                '\u{061c}'
                    | '\u{200e}'
                    | '\u{200f}'
                    | '\u{202a}'..='\u{202e}'
                    | '\u{2066}'..='\u{2069}'
            )
    }) {
        return None;
    }
    Some(format!("'{}'", text.replace('\'', r"'\''")))
}

/// A `.bak` destination beside `path` that does not exist yet. `mv -n` is what
/// actually guarantees no clobber; this only keeps the suggestion useful when
/// an earlier `.bak` is already there.
fn unused_backup_path(path: &Path) -> PathBuf {
    let name = path.file_name().unwrap_or_default().to_os_string();
    for attempt in 1..=64u32 {
        let mut candidate = name.clone();
        candidate.push(if attempt == 1 {
            ".bak".to_string()
        } else {
            format!(".bak-{attempt}")
        });
        let candidate = path.with_file_name(candidate);
        if std::fs::symlink_metadata(&candidate).is_err() {
            return candidate;
        }
    }
    let mut name = name;
    name.push(".bak-new");
    path.with_file_name(name)
}

/// The exact manual action offered for anything Pickforge will not adopt. The
/// CLI never moves or deletes state it does not own, so the remedy is always
/// the user's to take. The command is shell-quoted and never clobbers; a path
/// that cannot be rendered as a safe shell word is described instead.
pub fn manual_action(path: &Path, reason: &str) -> String {
    let remedy = match (shell_quote(path), shell_quote(&unused_backup_path(path))) {
        (Some(source), Some(destination)) => {
            format!("Move it aside (`mv -n -- {source} {destination}`)")
        }
        _ => "Move it aside yourself — its name cannot be shown as a safe shell \
              command — "
            .to_string(),
    };
    format!(
        "{} {reason}. Pickforge will not move or delete it. {remedy} and re-run \
         `pickforge init`, or run with a different PICKFORGE_HOME.",
        path.display()
    )
}

// --- pinned directories --------------------------------------------------

/// A project state directory pinned to the identity verified when it was
/// opened.
///
/// On Linux every child lookup goes through the directory's own descriptor via
/// a `/proc/self/fd` capability path, so swapping an ancestor — or the state
/// directory itself — after the open cannot redirect the marker, the staging
/// entry, or the cleanup that follows them. Elsewhere the open still refuses a
/// symlinked or non-directory final component, and lookups fall back to the
/// pathname.
struct PinnedDir {
    /// Logical path, used in messages.
    path: PathBuf,
    /// What child names are resolved against.
    base: PathBuf,
    /// Held open for as long as `base` is used; dropping it invalidates the
    /// capability path.
    _handle: Option<File>,
}

impl PinnedDir {
    fn open(path: &Path) -> io::Result<Self> {
        let handle = open_dir_nofollow(path)?;
        let base = handle
            .as_ref()
            .and_then(capability_path)
            .unwrap_or_else(|| path.to_path_buf());
        Ok(Self {
            path: path.to_path_buf(),
            base,
            _handle: handle,
        })
    }

    fn child(&self, name: &str) -> PathBuf {
        self.base.join(name)
    }

    /// The marker's logical path, for messages only.
    fn marker_display(&self) -> PathBuf {
        self.path.join(LAYOUT_MARKER)
    }
}

#[cfg(unix)]
fn open_dir_nofollow(path: &Path) -> io::Result<Option<File>> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(path)
        .map(Some)
}

#[cfg(not(unix))]
fn open_dir_nofollow(path: &Path) -> io::Result<Option<File>> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Err(io::Error::other(
            "project state directory is a symbolic link",
        ));
    }
    if !metadata.is_dir() {
        return Err(io::Error::other("project state path is not a directory"));
    }
    Ok(None)
}

#[cfg(target_os = "linux")]
fn capability_path(handle: &File) -> Option<PathBuf> {
    use std::os::unix::io::AsRawFd;
    let path = PathBuf::from(format!("/proc/self/fd/{}", handle.as_raw_fd()));
    path.exists().then_some(path)
}

#[cfg(not(target_os = "linux"))]
fn capability_path(_handle: &File) -> Option<PathBuf> {
    None
}

#[cfg(unix)]
fn identity(metadata: &std::fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (metadata.dev(), metadata.ino())
}

#[cfg(not(unix))]
fn identity(metadata: &std::fs::Metadata) -> (u64, u64) {
    use std::os::windows::fs::MetadataExt;
    (metadata.creation_time(), metadata.file_size())
}

#[cfg(unix)]
fn link_count(metadata: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    metadata.nlink()
}

#[cfg(not(unix))]
fn link_count(_metadata: &std::fs::Metadata) -> u64 {
    1
}

// --- reading the marker --------------------------------------------------

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

enum MarkerRead {
    Absent,
    Bytes(Vec<u8>),
    /// Multiply linked right now; retry before refusing it.
    MultiplyLinked,
}

/// Open the marker without following a link at the final component.
#[cfg(unix)]
fn open_marker(dir: &PinnedDir) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(dir.child(LAYOUT_MARKER))
}

#[cfg(not(unix))]
fn open_marker(dir: &PinnedDir) -> io::Result<File> {
    let path = dir.child(LAYOUT_MARKER);
    let metadata = std::fs::symlink_metadata(&path)?;
    if metadata.file_type().is_symlink() {
        return Err(io::Error::other("layout marker is a symbolic link"));
    }
    File::open(path)
}

/// One attempt at reading the marker as a regular, singly linked file.
fn read_marker_once(dir: &PinnedDir) -> Result<MarkerRead, LayoutError> {
    let refused = |reason: &str| LayoutError::Refused {
        action: manual_action(&dir.marker_display(), reason),
    };
    let mut file = match open_marker(dir) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(MarkerRead::Absent),
        // Linux answers `O_NOFOLLOW` on a symlink with `ELOOP`, and reports
        // `ENOTDIR` when a component below a non-directory was addressed.
        Err(error) if is_symlink_open_error(&error) => {
            return Err(refused(
                "is a symbolic link where the Pickforge layout marker must be a regular file",
            ))
        }
        Err(error) => {
            return Err(LayoutError::Unreadable {
                path: dir.marker_display().display().to_string(),
                message: error.to_string(),
            })
        }
    };
    let metadata = file.metadata().map_err(|error| LayoutError::Unreadable {
        path: dir.marker_display().display().to_string(),
        message: error.to_string(),
    })?;
    if !metadata.is_file() {
        return Err(refused(
            "is not a regular file where the Pickforge layout marker must be one",
        ));
    }
    if metadata.len() > MAX_MARKER_BYTES {
        return Err(refused("is too large to be a Pickforge layout marker"));
    }
    if link_count(&metadata) > 1 {
        return Ok(MarkerRead::MultiplyLinked);
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| LayoutError::Unreadable {
            path: dir.marker_display().display().to_string(),
            message: error.to_string(),
        })?;
    Ok(MarkerRead::Bytes(bytes))
}

fn is_symlink_open_error(error: &io::Error) -> bool {
    #[cfg(unix)]
    {
        error.raw_os_error() == Some(libc::ELOOP) || error.kind() == io::ErrorKind::NotADirectory
    }
    #[cfg(not(unix))]
    {
        error.kind() == io::ErrorKind::Other
    }
}

/// Read the marker bytes, waiting out the brief window in which a concurrent
/// publisher still holds the staging link.
fn read_marker(dir: &PinnedDir) -> Result<Option<Vec<u8>>, LayoutError> {
    for _ in 0..LINK_SETTLE_ATTEMPTS {
        match read_marker_once(dir)? {
            MarkerRead::Absent => return Ok(None),
            MarkerRead::Bytes(bytes) => return Ok(Some(bytes)),
            MarkerRead::MultiplyLinked => std::thread::sleep(LINK_SETTLE_PAUSE),
        }
    }
    Err(LayoutError::Refused {
        action: manual_action(
            &dir.marker_display(),
            "is a hard link to another file, where the Pickforge layout marker must be \
             a regular file with exactly one name",
        ),
    })
}

/// The validated layout version of an open state directory, or `None` when it
/// has no marker.
fn read_layout_in(dir: &PinnedDir) -> Result<Option<u32>, LayoutError> {
    match read_marker(dir)? {
        None => Ok(None),
        Some(bytes) => {
            validate_marker(&dir.marker_display(), &bytes)?;
            Ok(Some(LAYOUT_VERSION))
        }
    }
}

/// Read the marker in `state_dir` when there is one. `Ok(None)` means the
/// directory predates the marker (alpha.1/alpha.2) or does not exist yet;
/// callers treat that as version 1 by adoption, never as a reason to rewrite.
pub fn read_layout(state_dir: &Path) -> Result<Option<u32>, LayoutError> {
    match PinnedDir::open(state_dir) {
        Ok(dir) => read_layout_in(&dir),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(LayoutError::Unreadable {
            path: state_dir.join(LAYOUT_MARKER).display().to_string(),
            message: error.to_string(),
        }),
    }
}

// --- the direct-entry rule -----------------------------------------------

/// The one direct-entry rule, applied before any first adoption: a directory
/// Pickforge is about to claim may hold only entries the table assigns to an
/// owner. A foreign entry is refused with the exact manual action, and nothing
/// is written.
///
/// After a directory carries a marker this is not re-run: ownership was
/// settled when it was claimed, and re-policing it would let an entry created
/// later break a tool that never reads it.
fn assert_adoptable(dir: &PinnedDir) -> Result<(), LayoutError> {
    let unreadable = |error: io::Error| LayoutError::Unreadable {
        path: dir.path.display().to_string(),
        message: error.to_string(),
    };
    for entry in std::fs::read_dir(&dir.base).map_err(unreadable)? {
        let entry = entry.map_err(unreadable)?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            return Err(LayoutError::Refused {
                action: manual_action(
                    &dir.path.join(entry.file_name()),
                    "has a name that is not valid UTF-8 and cannot be attributed to an owner",
                ),
            });
        };
        if classify_entry(name) == Owner::Foreign {
            return Err(LayoutError::Refused {
                action: manual_action(
                    &dir.path.join(name),
                    "is not owned by Pickforge or the Pickforge lab",
                ),
            });
        }
    }
    Ok(())
}

// --- claiming ------------------------------------------------------------

/// A staging entry this invocation created, tracked by identity so cleanup can
/// never remove a different file that took its name.
struct Staged {
    name: String,
    path: PathBuf,
    identity: (u64, u64),
}

/// Create an unpredictable, exclusively created, no-follow staging file with
/// the marker bytes already complete and flushed.
fn stage_marker(dir: &PinnedDir) -> io::Result<Staged> {
    let staged = tempfile::Builder::new()
        .prefix(&format!("{TMP_PREFIX}layout-"))
        .rand_bytes(16)
        .make_in(&dir.base, |path| {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
            }
            options.open(path)
        })?;
    let identity = identity(&staged.as_file().metadata()?);
    {
        let mut file = staged.as_file();
        file.write_all(&layout_marker_bytes())?;
        file.sync_all()?;
    }
    // `keep` disables the drop-time unlink so cleanup can check identity first.
    let (_, path) = staged.keep().map_err(|error| error.error)?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(Staged {
        name,
        path,
        identity,
    })
}

/// Remove the staging entry only when the name still resolves to the inode
/// this invocation created.
fn discard_staged(dir: &PinnedDir, staged: &Staged) {
    let Ok(metadata) = std::fs::symlink_metadata(dir.child(&staged.name)) else {
        return;
    };
    if metadata.is_file() && identity(&metadata) == staged.identity {
        let _ = std::fs::remove_file(&staged.path);
    }
}

/// Publish the staged bytes as the marker with `link(2)`, which fails with
/// `EEXIST` rather than replacing anything, then verify what is actually
/// there.
fn publish_marker(dir: &PinnedDir) -> Result<bool, LayoutError> {
    let unwritable = |error: io::Error| LayoutError::Unwritable {
        path: dir.marker_display().display().to_string(),
        message: error.to_string(),
    };
    let staged = stage_marker(dir).map_err(unwritable)?;
    let published = std::fs::hard_link(&staged.path, dir.child(LAYOUT_MARKER));
    discard_staged(dir, &staged);
    match published {
        Ok(()) => {
            // The winner validates its own published marker: after the staging
            // entry is gone it must be the singly linked regular file whose
            // bytes were complete before it was ever visible.
            require_marker(dir)?;
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            require_marker(dir)?;
            Ok(false)
        }
        Err(error) => Err(unwritable(error)),
    }
}

/// The marker must exist and validate; a directory that lost the race but has
/// no marker is a state nobody may write into.
fn require_marker(dir: &PinnedDir) -> Result<(), LayoutError> {
    match read_layout_in(dir)? {
        Some(_) => Ok(()),
        None => Err(LayoutError::Unwritable {
            path: dir.marker_display().display().to_string(),
            message: "the layout marker disappeared while it was being claimed".to_string(),
        }),
    }
}

/// Claim `state_dir` for the shared layout, atomically and at most once.
///
/// The marker is staged in an unpredictable, exclusively created file and
/// published with `link(2)`, which fails with `EEXIST` when a marker already
/// exists. That gives both exclusivity *and* full content in one step: the
/// loser of a race with the TypeScript lab always reads a complete marker,
/// never the empty file an `O_EXCL` create would expose between creation and
/// write. Because the marker is the only thing claimed, a crash before
/// publication leaves at most an inert `.pickforge-tmp-` file, and the next run
/// claims the directory. An existing marker is never rewritten, which is how an
/// alpha.1/alpha.2 directory is adopted in place.
///
/// A directory without a marker is validated against the direct-entry rule
/// first, so a first adoption never certifies a directory holding unowned
/// entries.
///
/// Returns whether this call created the marker.
pub fn claim_layout(state_dir: &Path) -> Result<bool, LayoutError> {
    create_private_dirs(state_dir).map_err(|error| LayoutError::Unwritable {
        path: state_dir.join(LAYOUT_MARKER).display().to_string(),
        message: error.to_string(),
    })?;
    let dir = PinnedDir::open(state_dir).map_err(|error| LayoutError::Unwritable {
        path: state_dir.join(LAYOUT_MARKER).display().to_string(),
        message: error.to_string(),
    })?;
    if read_layout_in(&dir)?.is_some() {
        return Ok(false);
    }
    assert_adoptable(&dir)?;
    publish_marker(&dir)
}

// --- private directories -------------------------------------------------

/// Create `path` and every missing ancestor as a private (`0700`) directory,
/// refusing to walk through a symlink or a non-directory. Shared by the state
/// claim and by evidence recording, so both create state with the same mode
/// the transaction layer uses.
pub fn create_private_dirs(path: &Path) -> io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(io::Error::other("final state directory is a symbolic link"));
        }
        Ok(metadata) if metadata.is_dir() => return Ok(()),
        Ok(_) => return Err(io::Error::other("state parent is not a directory")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    create_private_dirs(path.parent().ok_or_else(|| io::Error::other("no parent"))?)?;
    match create_private_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let metadata = std::fs::symlink_metadata(path)?;
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                Ok(())
            } else {
                Err(io::Error::other(
                    "concurrently created state path is not a real directory",
                ))
            }
        }
        Err(error) => Err(error),
    }
}

/// Create one directory with private (`0700`) permissions.
pub fn create_private_dir(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = std::fs::DirBuilder::new();
        builder.mode(0o700).create(path)
    }
    #[cfg(not(unix))]
    std::fs::DirBuilder::new().create(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_private_directory_creation_is_safe() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("one/two/three");
        std::thread::scope(|scope| {
            for _ in 0..16 {
                let path = &path;
                scope.spawn(move || create_private_dirs(path).unwrap());
            }
        });
        let metadata = std::fs::symlink_metadata(path).unwrap();
        assert!(metadata.is_dir());
        assert!(!metadata.file_type().is_symlink());
    }

    #[test]
    fn private_directories_are_created_owner_only() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("projects/app-0000");
        create_private_dirs(&path).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700, "{mode:o}");
        }
    }

    #[test]
    fn the_manual_action_is_quoted_and_never_clobbers() {
        let action = manual_action(Path::new("/tmp/a b/it's here"), "is not owned by Pickforge");
        assert!(
            action.contains(r"`mv -n -- '/tmp/a b/it'\''s here' '/tmp/a b/it'\''s here.bak'`"),
            "{action}"
        );
    }

    #[test]
    fn the_manual_action_skips_an_existing_backup_destination() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("notes.txt");
        std::fs::write(&path, b"x").unwrap();
        std::fs::write(temp.path().join("notes.txt.bak"), b"x").unwrap();
        let action = manual_action(&path, "is not owned by Pickforge");
        assert!(action.contains("notes.txt.bak-2'"), "{action}");
    }

    #[test]
    fn a_path_that_cannot_be_a_safe_shell_word_gets_no_command() {
        let action = manual_action(Path::new("/tmp/we\nird"), "is not owned by Pickforge");
        assert!(!action.contains("mv -n"), "{action}");
        assert!(action.contains("Move it aside yourself"), "{action}");
    }
}
