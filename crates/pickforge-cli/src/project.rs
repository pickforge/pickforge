//! Project identity and framework detection.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

use saphyr::{LoadableYamlNode, Yaml};
use saphyr_parser::{Event, Parser};
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
pub(crate) fn normalize_windows_canonical_path(path: PathBuf) -> PathBuf {
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
pub(crate) fn normalize_windows_canonical_path(path: PathBuf) -> PathBuf {
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

/// Deepest collection nesting accepted in `pubspec.yaml`, after aliases.
const MAX_PUBSPEC_DEPTH: usize = 128;

/// Check the YAML events before building a tree. Dropping a very deep tree
/// overflows the stack, and an alias copies its whole anchored subtree, so the
/// alias counts with that subtree's height. A scalar that fails its type tag
/// is malformed, also as a mapping key, which the tree would not keep.
fn check_pubspec_events(raw: &str) -> Result<(), FrameworkError> {
    let mut heights = NodeHeights::default();
    for event in Parser::new_from_str(raw) {
        let (event, _) =
            event.map_err(|error| FrameworkError::PubspecMalformed(error.to_string()))?;
        heights.record(event)?;
    }
    Ok(())
}

/// The height of each node in the tree that the YAML events would build.
#[derive(Default)]
struct NodeHeights {
    /// Each open collection, with its anchor id and its height so far.
    open: Vec<(usize, usize)>,
    anchored: HashMap<usize, usize>,
}

impl NodeHeights {
    fn record(&mut self, event: Event) -> Result<(), FrameworkError> {
        let (anchor, height) = match event {
            Event::SequenceStart(anchor, _) | Event::MappingStart(anchor, _) => {
                self.open.push((anchor, 1));
                return self.within_limit(0);
            }
            Event::SequenceEnd | Event::MappingEnd => match self.open.pop() {
                Some(closed) => closed,
                None => return Ok(()),
            },
            Event::Scalar(value, style, anchor, tag) => {
                let parsed = Yaml::value_from_cow_and_metadata(value, style, tag.as_ref());
                if matches!(parsed, Yaml::BadValue) {
                    return Err(FrameworkError::PubspecMalformed(
                        "a value that is not valid for its type".to_string(),
                    ));
                }
                (anchor, 0)
            }
            Event::Alias(id) => {
                let height = self.anchored.get(&id).copied().unwrap_or(0);
                self.within_limit(height)?;
                (0, height)
            }
            _ => return Ok(()),
        };
        if anchor > 0 {
            self.anchored.insert(anchor, height);
        }
        if let Some(parent) = self.open.last_mut() {
            parent.1 = parent.1.max(height + 1);
        }
        Ok(())
    }

    /// Whether a node of `height` inside the open collections fits the limit.
    fn within_limit(&self, height: usize) -> Result<(), FrameworkError> {
        if self.open.len() + height > MAX_PUBSPEC_DEPTH {
            return Err(FrameworkError::PubspecMalformed(format!(
                "nesting deeper than {MAX_PUBSPEC_DEPTH} levels"
            )));
        }
        Ok(())
    }
}

/// The node under any custom tags, so a tagged value still matches.
fn untagged<'a, 'input>(node: &'a Yaml<'input>) -> &'a Yaml<'input> {
    match node {
        Yaml::Tagged(_, inner) => untagged(inner),
        other => other,
    }
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

    check_pubspec_events(&raw)?;
    let documents = Yaml::load_from_str(&raw)
        .map_err(|error| FrameworkError::PubspecMalformed(error.to_string()))?;
    if documents.len() > 1 {
        return Err(FrameworkError::PubspecMalformed(
            "more than one YAML document".to_string(),
        ));
    }
    let sdk = documents
        .first()
        .and_then(|pubspec| untagged(pubspec).as_mapping_get("dependencies"))
        .and_then(|dependencies| untagged(dependencies).as_mapping_get("flutter"))
        .and_then(|flutter| untagged(flutter).as_mapping_get("sdk"))
        .and_then(|sdk| untagged(sdk).as_str());

    if sdk == Some("flutter") {
        Ok(())
    } else {
        Err(FrameworkError::NotFlutter)
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::normalize_windows_canonical_path;
    use std::path::PathBuf;

    #[test]
    fn windows_verbatim_prefix_normalization_covers_disk_unc_and_other_namespaces() {
        assert_eq!(
            normalize_windows_canonical_path(PathBuf::from(r"\\?\C:\app")),
            PathBuf::from(r"C:\app")
        );
        assert_eq!(
            normalize_windows_canonical_path(PathBuf::from(r"\\?\UNC\server\share\app")),
            PathBuf::from(r"\\server\share\app")
        );
        assert_eq!(
            normalize_windows_canonical_path(PathBuf::from(r"\\?\Volume{0}\app")),
            PathBuf::from(r"\\?\Volume{0}\app")
        );
    }
}
