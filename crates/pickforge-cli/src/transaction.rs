//! Fail-closed snapshots and transactional atomic file replacement.

use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tempfile::Builder;
use thiserror::Error;

const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
enum Snapshot {
    Missing,
    Present {
        hash: [u8; 32],
        mode: Option<u32>,
        readonly: bool,
    },
}

#[derive(Debug, Clone)]
pub struct FilePlan {
    pub(crate) path: PathBuf,
    pub(crate) desired: Vec<u8>,
    snapshot: Snapshot,
}

impl FilePlan {
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn is_changed(&self) -> bool {
        !matches!(&self.snapshot, Snapshot::Present { hash, .. } if *hash == digest(&self.desired))
    }
    pub fn is_create(&self) -> bool {
        matches!(self.snapshot, Snapshot::Missing)
    }
    pub(crate) fn with_desired(mut self, desired: Vec<u8>) -> Result<Self, TransactionError> {
        self.desired = desired;
        refuse_changed_readonly(&self)?;
        Ok(self)
    }
}

#[derive(Debug, Error)]
pub enum TransactionError {
    #[error("unsafe target {path}: {reason}")]
    Unsafe { path: PathBuf, reason: String },
    #[error("could not inspect {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

#[derive(Debug)]
pub struct ApplyFailure {
    pub error: String,
    pub rolled_back: bool,
    pub backup_paths: Vec<PathBuf>,
    pub residual_paths: Vec<PathBuf>,
}

fn digest(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn resolve_target_parent(path: &Path) -> Result<PathBuf, TransactionError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|source| TransactionError::Io {
                path: path.into(),
                source,
            })?
            .join(path)
    };
    let file_name = absolute
        .file_name()
        .ok_or_else(|| unsafe_target(path, "target has no filename"))?
        .to_os_string();
    let mut cursor = absolute
        .parent()
        .ok_or_else(|| unsafe_target(path, "target has no parent"))?;
    let mut missing: Vec<OsString> = Vec::new();
    let resolved = loop {
        match fs::symlink_metadata(cursor) {
            Ok(metadata) if !metadata.is_dir() && !metadata.file_type().is_symlink() => {
                return Err(unsafe_target(path, "a parent path is not a directory"));
            }
            Ok(_) => {
                let canonical =
                    fs::canonicalize(cursor).map_err(|source| TransactionError::Io {
                        path: cursor.into(),
                        source,
                    })?;
                break crate::project::normalize_windows_canonical_path(canonical);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                missing.push(
                    cursor
                        .file_name()
                        .ok_or_else(|| unsafe_target(path, "target has no existing ancestor"))?
                        .to_os_string(),
                );
                cursor = cursor
                    .parent()
                    .ok_or_else(|| unsafe_target(path, "target has no existing ancestor"))?;
            }
            Err(source) => {
                return Err(TransactionError::Io {
                    path: cursor.into(),
                    source,
                });
            }
        }
    };
    let mut target = resolved;
    for component in missing.into_iter().rev() {
        target.push(component);
    }
    target.push(file_name);
    Ok(target)
}

fn inspect_ancestors(path: &Path) -> Result<(), TransactionError> {
    let mut cursor = path.parent();
    while let Some(parent) = cursor {
        match fs::symlink_metadata(parent) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(unsafe_target(path, "a parent directory is a symbolic link"));
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(unsafe_target(path, "a parent path is not a directory"));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(TransactionError::Io {
                    path: parent.into(),
                    source,
                });
            }
        }
        cursor = parent.parent();
    }
    Ok(())
}

fn inspect(
    path: &Path,
    require_utf8: bool,
) -> Result<(Snapshot, Option<Vec<u8>>), TransactionError> {
    inspect_ancestors(path)?;
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok((Snapshot::Missing, None))
        }
        Err(source) => {
            return Err(TransactionError::Io {
                path: path.into(),
                source,
            })
        }
    };
    if metadata.file_type().is_symlink() {
        return Err(unsafe_target(path, "symbolic links are not edited"));
    }
    if !metadata.is_file() {
        return Err(unsafe_target(path, "target is not a regular file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() > 1 {
            return Err(unsafe_target(path, "hardlinked files are not edited"));
        }
    }
    let file = File::open(path).map_err(|source| TransactionError::Io {
        path: path.into(),
        source,
    })?;
    let opened_metadata = file.metadata().map_err(|source| TransactionError::Io {
        path: path.into(),
        source,
    })?;
    if !opened_metadata.is_file() {
        return Err(unsafe_target(path, "target changed while it was inspected"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.dev() != opened_metadata.dev() || metadata.ino() != opened_metadata.ino() {
            return Err(unsafe_target(path, "target changed while it was inspected"));
        }
    }
    let mut bytes = Vec::with_capacity(
        opened_metadata
            .len()
            .min(MAX_CONFIG_BYTES.saturating_add(1)) as usize,
    );
    file.take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|source| TransactionError::Io {
            path: path.into(),
            source,
        })?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(unsafe_target(path, "file exceeds the 1 MiB safety limit"));
    }
    if require_utf8 && std::str::from_utf8(&bytes).is_err() {
        return Err(unsafe_target(path, "config is not valid UTF-8"));
    }
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        Some(opened_metadata.permissions().mode())
    };
    #[cfg(not(unix))]
    let mode = None;
    Ok((
        Snapshot::Present {
            hash: digest(&bytes),
            mode,
            readonly: opened_metadata.permissions().readonly(),
        },
        Some(bytes),
    ))
}

fn unsafe_target(path: &Path, reason: &str) -> TransactionError {
    TransactionError::Unsafe {
        path: path.into(),
        reason: reason.into(),
    }
}

#[cfg(windows)]
fn refuse_changed_readonly(file: &FilePlan) -> Result<(), TransactionError> {
    if matches!(file.snapshot, Snapshot::Present { readonly: true, .. }) && file.is_changed() {
        return Err(unsafe_target(
            &file.path,
            "read-only files are not edited on Windows",
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn refuse_changed_readonly(_file: &FilePlan) -> Result<(), TransactionError> {
    Ok(())
}

pub(crate) fn inspect_file(
    path: PathBuf,
    require_utf8: bool,
) -> Result<(FilePlan, Option<Vec<u8>>), TransactionError> {
    let path = resolve_target_parent(&path)?;
    let (snapshot, existing) = inspect(&path, require_utf8)?;
    let desired = existing.clone().unwrap_or_default();
    Ok((
        FilePlan {
            path,
            desired,
            snapshot,
        },
        existing,
    ))
}

pub fn plan_file(
    path: PathBuf,
    desired: Vec<u8>,
    require_utf8: bool,
) -> Result<(FilePlan, Option<Vec<u8>>), TransactionError> {
    let (file, existing) = inspect_file(path, require_utf8)?;
    Ok((file.with_desired(desired)?, existing))
}

fn set_mode(path: &Path, mode: Option<u32>, readonly: bool) -> io::Result<()> {
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::PermissionsExt;
        return fs::set_permissions(path, fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    {
        let _ = mode;
        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_readonly(readonly);
        fs::set_permissions(path, permissions)?;
    }
    let _ = readonly;
    Ok(())
}

fn create_private_dirs(parent: &Path, created: &mut Vec<PathBuf>) -> io::Result<()> {
    let mut missing = Vec::new();
    let mut cursor = parent;
    loop {
        match fs::symlink_metadata(cursor) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(io::Error::other(format!(
                    "refusing symbolic-link parent {}",
                    cursor.display()
                )));
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(io::Error::other(format!(
                    "parent path is not a directory: {}",
                    cursor.display()
                )));
            }
            Ok(_) => break,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                missing.push(cursor.to_path_buf());
                cursor = cursor
                    .parent()
                    .ok_or_else(|| io::Error::other("target has no existing ancestor"))?;
            }
            Err(error) => return Err(error),
        }
    }
    for directory in missing.into_iter().rev() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
            let mut builder = fs::DirBuilder::new();
            builder.mode(0o700).create(&directory)?;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
        }
        #[cfg(not(unix))]
        fs::create_dir(&directory)?;
        created.push(directory);
    }
    Ok(())
}

fn atomic_write(
    path: &Path,
    bytes: &[u8],
    mode: Option<u32>,
    readonly: bool,
    created_dirs: &mut Vec<PathBuf>,
) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("target has no parent"))?;
    create_private_dirs(parent, created_dirs)?;
    let mut temp = Builder::new()
        .prefix(".pickforge-tmp-")
        .tempfile_in(parent)?;
    temp.write_all(bytes)?;
    temp.flush()?;
    temp.as_file().sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(fs::Permissions::from_mode(mode.unwrap_or(0o600)))?;
    }
    #[cfg(not(unix))]
    {
        let _ = mode;
        let mut permissions = temp.as_file().metadata()?.permissions();
        permissions.set_readonly(readonly);
        temp.as_file().set_permissions(permissions)?;
    }
    #[cfg(unix)]
    let _ = readonly;
    temp.persist(path).map_err(|error| error.error)?;
    Ok(())
}

fn backup_path(path: &Path, stamp: &str) -> io::Result<(PathBuf, fs::File)> {
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::other("target has no filename"))?
        .to_string_lossy();
    for collision in 1usize.. {
        let suffix = if collision == 1 {
            String::new()
        } else {
            format!("-{collision}")
        };
        let candidate = path.with_file_name(format!("{name}.pickforge-backup-{stamp}{suffix}"));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&candidate) {
            Ok(file) => return Ok((candidate, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    unreachable!()
}

pub fn apply_files(files: &[FilePlan], stamp: &str) -> Result<Vec<PathBuf>, ApplyFailure> {
    apply_files_with(files, stamp, atomic_write)
}

fn apply_files_with<F>(
    files: &[FilePlan],
    stamp: &str,
    mut write_file: F,
) -> Result<Vec<PathBuf>, ApplyFailure>
where
    F: FnMut(&Path, &[u8], Option<u32>, bool, &mut Vec<PathBuf>) -> io::Result<()>,
{
    if stamp.is_empty()
        || !stamp
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character))
    {
        return Err(ApplyFailure {
            error: "backup stamp may contain only ASCII letters, digits, '-', '_', and '.'"
                .to_string(),
            rolled_back: true,
            backup_paths: vec![],
            residual_paths: vec![],
        });
    }
    for file in files {
        match inspect(&file.path, true) {
            Ok((snapshot, _)) if snapshot == file.snapshot => {}
            Ok(_) => {
                return Err(ApplyFailure {
                    error: format!("target changed since planning: {}", file.path.display()),
                    rolled_back: true,
                    backup_paths: vec![],
                    residual_paths: vec![],
                })
            }
            Err(error) => {
                return Err(ApplyFailure {
                    error: error.to_string(),
                    rolled_back: true,
                    backup_paths: vec![],
                    residual_paths: vec![],
                })
            }
        }
    }
    let mut backups = Vec::new();
    let mut applied: Vec<(&FilePlan, Option<PathBuf>)> = Vec::new();
    let mut created_dirs = Vec::new();
    for file in files.iter().filter(|file| file.is_changed()) {
        let (current_snapshot, current_bytes) = match inspect(&file.path, true) {
            Ok(current) if current.0 == file.snapshot => current,
            Ok(_) => {
                return rollback(
                    format!("target changed during apply: {}", file.path.display()),
                    &applied,
                    backups,
                    &created_dirs,
                    vec![],
                );
            }
            Err(error) => {
                return rollback(error.to_string(), &applied, backups, &created_dirs, vec![]);
            }
        };
        let backup = match &current_snapshot {
            Snapshot::Missing => None,
            Snapshot::Present { mode, readonly, .. } => {
                let (path, mut output) = match backup_path(&file.path, stamp) {
                    Ok(backup) => backup,
                    Err(error) => {
                        return rollback(
                            format!("backup failed for {}: {error}", file.path.display()),
                            &applied,
                            backups,
                            &created_dirs,
                            vec![],
                        );
                    }
                };
                let backup_result = (|| -> io::Result<()> {
                    output.write_all(
                        current_bytes
                            .as_deref()
                            .expect("present snapshot has bytes"),
                    )?;
                    output.flush()?;
                    output.sync_all()?;
                    drop(output);
                    set_mode(&path, *mode, *readonly)
                })();
                if let Err(error) = backup_result {
                    let mut residuals = Vec::new();
                    if fs::remove_file(&path).is_err() {
                        residuals.push(path);
                    }
                    return rollback(
                        format!("backup failed for {}: {error}", file.path.display()),
                        &applied,
                        backups,
                        &created_dirs,
                        residuals,
                    );
                }
                backups.push(path.clone());
                Some(path)
            }
        };
        let (mode, readonly) = match file.snapshot {
            Snapshot::Present { mode, readonly, .. } => (mode, readonly),
            Snapshot::Missing => (Some(0o600), false),
        };
        if let Err(error) = write_file(&file.path, &file.desired, mode, readonly, &mut created_dirs)
        {
            return rollback(
                format!("write failed for {}: {error}", file.path.display()),
                &applied,
                backups,
                &created_dirs,
                vec![],
            );
        }
        applied.push((file, backup));
    }
    Ok(backups)
}

fn rollback(
    error: String,
    applied: &[(&FilePlan, Option<PathBuf>)],
    backup_paths: Vec<PathBuf>,
    created_dirs: &[PathBuf],
    mut residuals: Vec<PathBuf>,
) -> Result<Vec<PathBuf>, ApplyFailure> {
    for (file, backup) in applied.iter().rev() {
        match backup {
            Some(backup) => {
                let current_is_ours = inspect(&file.path, true)
                    .ok()
                    .is_some_and(|(snapshot, _)| {
                        matches!(snapshot, Snapshot::Present { hash, .. } if hash == digest(&file.desired))
                    });
                if !current_is_ours {
                    residuals.push(file.path.clone());
                    continue;
                }
                let restored = fs::read(backup).and_then(|bytes| {
                    let metadata = fs::metadata(backup)?;
                    #[cfg(unix)]
                    let mode = {
                        use std::os::unix::fs::PermissionsExt;
                        Some(metadata.permissions().mode())
                    };
                    #[cfg(not(unix))]
                    let mode = None;
                    let readonly = metadata.permissions().readonly();
                    atomic_write(&file.path, &bytes, mode, readonly, &mut Vec::new())
                });
                if restored.is_err() {
                    residuals.push(file.path.clone());
                }
            }
            None => match inspect(&file.path, false) {
                Ok((Snapshot::Present { hash, .. }, _)) if hash == digest(&file.desired) => {
                    if fs::remove_file(&file.path).is_err() {
                        residuals.push(file.path.clone());
                    }
                }
                Ok((Snapshot::Missing, _)) => {}
                Ok(_) | Err(_) => residuals.push(file.path.clone()),
            },
        }
    }
    for directory in created_dirs.iter().rev() {
        match fs::remove_dir(directory) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => residuals.push(directory.clone()),
        }
    }
    Err(ApplyFailure {
        error,
        rolled_back: residuals.is_empty(),
        backup_paths,
        residual_paths: residuals,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn later_write_failure_rolls_back_update_and_create_and_retains_backup() {
        let temp = tempfile::tempdir().unwrap();
        let updated = temp.path().join("updated");
        let created = temp.path().join("created");
        let failed = temp.path().join("failed");
        fs::write(&updated, "old").unwrap();
        let (update, _) = plan_file(updated.clone(), b"new".to_vec(), true).unwrap();
        let (create, _) = plan_file(created.clone(), b"created".to_vec(), true).unwrap();
        let (failure, _) = plan_file(failed, b"failed".to_vec(), true).unwrap();
        let mut writes = 0;
        let result = apply_files_with(
            &[update, create, failure],
            "stamp",
            |path, bytes, mode, readonly, dirs| {
                writes += 1;
                if writes == 3 {
                    return Err(io::Error::other("injected failure"));
                }
                atomic_write(path, bytes, mode, readonly, dirs)
            },
        )
        .unwrap_err();
        assert!(result.rolled_back, "{result:?}");
        assert_eq!(fs::read_to_string(updated).unwrap(), "old");
        assert!(!created.exists());
        assert_eq!(result.backup_paths.len(), 1);
        assert!(result.backup_paths[0].exists());
        assert!(result.residual_paths.is_empty());
    }

    #[test]
    fn rollback_does_not_overwrite_a_concurrent_external_edit() {
        let temp = tempfile::tempdir().unwrap();
        let updated = temp.path().join("updated");
        let failed = temp.path().join("failed");
        fs::write(&updated, "old").unwrap();
        let (update, _) = plan_file(updated.clone(), b"pickforge".to_vec(), true).unwrap();
        let planned_updated = update.path().to_path_buf();
        let (failure, _) = plan_file(failed, b"failed".to_vec(), true).unwrap();
        let mut writes = 0;
        let result = apply_files_with(
            &[update, failure],
            "stamp",
            |path, bytes, mode, readonly, dirs| {
                writes += 1;
                if writes == 2 {
                    fs::write(&updated, "external")?;
                    return Err(io::Error::other("injected failure"));
                }
                atomic_write(path, bytes, mode, readonly, dirs)
            },
        )
        .unwrap_err();
        assert!(!result.rolled_back, "{result:?}");
        assert_eq!(fs::read_to_string(&updated).unwrap(), "external");
        assert_eq!(result.residual_paths, vec![planned_updated]);
        assert_eq!(result.backup_paths.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn rollback_does_not_follow_a_replacement_symlink_for_a_created_file() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let created = temp.path().join("created");
        let failed = temp.path().join("failed");
        let external = temp.path().join("external");
        fs::write(&external, "external").unwrap();
        let (create, _) = plan_file(created.clone(), b"pickforge".to_vec(), true).unwrap();
        let planned_created = create.path().to_path_buf();
        let (failure, _) = plan_file(failed, b"failed".to_vec(), true).unwrap();
        let mut writes = 0;
        let result = apply_files_with(
            &[create, failure],
            "stamp",
            |path, bytes, mode, readonly, dirs| {
                writes += 1;
                if writes == 2 {
                    fs::remove_file(&created)?;
                    symlink(&external, &created)?;
                    return Err(io::Error::other("injected failure"));
                }
                atomic_write(path, bytes, mode, readonly, dirs)
            },
        )
        .unwrap_err();
        assert!(!result.rolled_back, "{result:?}");
        assert_eq!(fs::read_to_string(&external).unwrap(), "external");
        assert_eq!(result.residual_paths, vec![planned_created]);
    }
}
