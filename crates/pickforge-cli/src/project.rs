//! Project identity and framework detection.

use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};
use thiserror::Error;

const PROJECT_ID_HASH_LENGTH: usize = 16;
const PROJECT_ID_SLUG_LENGTH: usize = 40;

/// Absolute path with `.`/`..` removed, without touching the filesystem.
fn lexically_absolute(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(path)
    };

    let mut resolved = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            other => resolved.push(other.as_os_str()),
        }
    }
    resolved
}

#[cfg(windows)]
fn normalize_windows_canonical_path(path: PathBuf) -> PathBuf {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    const VERBATIM_PREFIX: &[u16] = &[b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
    const VERBATIM_UNC_PREFIX: &[u16] = &[
        b'\\' as u16,
        b'\\' as u16,
        b'?' as u16,
        b'\\' as u16,
        b'U' as u16,
        b'N' as u16,
        b'C' as u16,
        b'\\' as u16,
    ];

    let wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    let normalized = if wide.starts_with(VERBATIM_UNC_PREFIX) {
        [vec![b'\\' as u16, b'\\' as u16], wide[8..].to_vec()].concat()
    } else if wide.starts_with(VERBATIM_PREFIX)
        && wide.get(4).is_some_and(|unit| {
            (*unit >= u16::from(b'A') && *unit <= u16::from(b'Z'))
                || (*unit >= u16::from(b'a') && *unit <= u16::from(b'z'))
        })
        && wide.get(5) == Some(&u16::from(b':'))
    {
        wide[4..].to_vec()
    } else {
        return path;
    };

    PathBuf::from(OsString::from_wide(&normalized))
}

#[cfg(not(windows))]
fn normalize_windows_canonical_path(path: PathBuf) -> PathBuf {
    path
}

/// Canonical form of a project path used for stable project-id derivation.
/// Resolves `.`/`..` before symlinks to match TypeScript's
/// `realpath(path.resolve(projectDir))`, then removes Windows' verbatim prefix.
/// Falls back to the lexical path when the directory does not exist.
pub fn canonical_project_path(project_dir: &Path) -> PathBuf {
    let absolute = lexically_absolute(project_dir);
    let canonical = std::fs::canonicalize(&absolute).unwrap_or(absolute);
    normalize_windows_canonical_path(canonical)
}

fn sanitize_slug(name: &str) -> String {
    let mut slug = String::new();
    for ch in name.to_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            slug.push(ch);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() { "project" } else { slug };
    slug.chars().take(PROJECT_ID_SLUG_LENGTH).collect()
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProjectIdentityError {
    #[error("project path is not valid UTF-8 and cannot match the TypeScript project-id contract")]
    NonUtf8Path,
}

/// Stable per-project id: a readable slug of the directory basename plus the
/// leading hex of a SHA-256 digest over the canonical path. Must stay
/// byte-identical to PickLab's TypeScript `deriveProjectId`. Paths that cannot
/// be represented by that string-based contract fail instead of colliding.
pub fn derive_project_id(canonical_path: &Path) -> Result<String, ProjectIdentityError> {
    let canonical = canonical_path
        .to_str()
        .ok_or(ProjectIdentityError::NonUtf8Path)?;
    let digest = Sha256::digest(canonical.as_bytes());
    let hash: String = format!("{digest:x}")
        .chars()
        .take(PROJECT_ID_HASH_LENGTH)
        .collect();
    let basename = canonical_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    Ok(format!("{}-{hash}", sanitize_slug(basename)))
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum FrameworkError {
    #[error("no pubspec.yaml found")]
    PubspecMissing,
    #[error("pubspec.yaml could not be read: {0}")]
    PubspecUnreadable(String),
    #[error("pubspec.yaml is not valid YAML: {0}")]
    PubspecMalformed(String),
    #[error("pubspec.yaml has no dependencies.flutter.sdk: flutter entry")]
    NotFlutter,
}

/// Detect a Flutter project by parsing `pubspec.yaml` structurally: only a
/// `dependencies.flutter.sdk: flutter` entry counts.
pub fn detect_flutter(project_dir: &Path) -> Result<(), FrameworkError> {
    let pubspec_path = project_dir.join("pubspec.yaml");
    let raw = match std::fs::read_to_string(&pubspec_path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(FrameworkError::PubspecMissing)
        }
        Err(error) => return Err(FrameworkError::PubspecUnreadable(error.to_string())),
    };

    let pubspec: serde_yaml_ng::Value = serde_yaml_ng::from_str(&raw)
        .map_err(|error| FrameworkError::PubspecMalformed(error.to_string()))?;
    let sdk = pubspec
        .get("dependencies")
        .and_then(|dependencies| dependencies.get("flutter"))
        .and_then(|flutter| flutter.get("sdk"))
        .and_then(serde_yaml_ng::Value::as_str);

    if sdk == Some("flutter") {
        Ok(())
    } else {
        Err(FrameworkError::NotFlutter)
    }
}
