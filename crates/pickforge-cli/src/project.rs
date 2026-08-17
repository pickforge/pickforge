//! Project identity and framework detection.

use std::path::{Component, Path, PathBuf};

use serde::Deserialize;
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

/// Canonical form of a project path used for stable project-id derivation.
/// Resolves symlinks so a project reached through different paths keeps one
/// identity; falls back to the lexically resolved path when the directory does
/// not exist, so id derivation never fails.
pub fn canonical_project_path(project_dir: &Path) -> PathBuf {
    std::fs::canonicalize(project_dir).unwrap_or_else(|_| lexically_absolute(project_dir))
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

/// Stable per-project id: a readable slug of the directory basename plus the
/// leading hex of a SHA-256 digest over the canonical path. Must stay
/// byte-identical to PickLab's TypeScript `deriveProjectId`.
pub fn derive_project_id(canonical_path: &Path) -> String {
    let digest = Sha256::digest(canonical_path.to_string_lossy().as_bytes());
    let hash: String = format!("{digest:x}")
        .chars()
        .take(PROJECT_ID_HASH_LENGTH)
        .collect();
    let basename = canonical_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    format!("{}-{hash}", sanitize_slug(&basename))
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

#[derive(Debug, Deserialize)]
struct Pubspec {
    #[serde(default)]
    dependencies: Option<Dependencies>,
}

#[derive(Debug, Deserialize)]
struct Dependencies {
    #[serde(default)]
    flutter: Option<FlutterDependency>,
}

#[derive(Debug, Deserialize)]
struct FlutterDependency {
    #[serde(default)]
    sdk: Option<String>,
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

    let pubspec: Pubspec = serde_yaml_ng::from_str(&raw)
        .map_err(|error| FrameworkError::PubspecMalformed(error.to_string()))?;

    let sdk = pubspec
        .dependencies
        .and_then(|dependencies| dependencies.flutter)
        .and_then(|flutter| flutter.sdk);

    if sdk.as_deref() == Some("flutter") {
        Ok(())
    } else {
        Err(FrameworkError::NotFlutter)
    }
}
