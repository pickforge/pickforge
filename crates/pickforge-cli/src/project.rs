//! Project identity and framework detection.

use std::fmt;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde::de::{MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use sha2::{Digest, Sha256};
use thiserror::Error;

const PROJECT_ID_HASH_LENGTH: usize = 16;
const PROJECT_ID_SLUG_LENGTH: usize = 40;
const PUBSPEC_MAX_BYTES: usize = 4 * 1024 * 1024;
const PUBSPEC_PARSE_STACK_BYTES: usize = 8 * 1024 * 1024;

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

/// Lowercase hex SHA-256 of `bytes`.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Stable per-project id: a readable slug of the directory basename plus the
/// leading hex of a SHA-256 digest over the canonical path. Must stay
/// byte-identical to PickLab's TypeScript `deriveProjectId`. Paths that cannot
/// be represented by that string-based contract fail instead of colliding.
pub fn derive_project_id(canonical_path: &Path) -> Result<String, ProjectIdentityError> {
    let canonical = canonical_path
        .to_str()
        .ok_or(ProjectIdentityError::NonUtf8Path)?;
    let hash: String = sha256_hex(canonical.as_bytes())
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

// Only strings and mappings are needed for detection. Consume every other
// value, including collection keys, so the parser still validates the whole file.
enum PubspecValue {
    String(String),
    Mapping(Vec<(Self, Self)>),
    Other,
}

impl PubspecValue {
    fn get(&self, key: &str) -> Option<&Self> {
        match self {
            Self::Mapping(entries) => entries
                .iter()
                .find_map(|(candidate, value)| (candidate.as_str() == Some(key)).then_some(value)),
            _ => None,
        }
    }

    fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(value) => Some(value),
            _ => None,
        }
    }
}

impl<'de> Deserialize<'de> for PubspecValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ValueVisitor;

        impl<'de> Visitor<'de> for ValueVisitor {
            type Value = PubspecValue;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a YAML value")
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(PubspecValue::Other)
            }

            fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E> {
                Ok(PubspecValue::Other)
            }

            fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E> {
                Ok(PubspecValue::Other)
            }

            fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E> {
                Ok(PubspecValue::Other)
            }

            fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E> {
                Ok(PubspecValue::Other)
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
                Ok(PubspecValue::String(value.to_owned()))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
                Ok(PubspecValue::String(value))
            }

            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> Result<Self::Value, A::Error> {
                while sequence.next_element::<PubspecValue>()?.is_some() {}
                Ok(PubspecValue::Other)
            }

            fn visit_map<A: MapAccess<'de>>(self, mut mapping: A) -> Result<Self::Value, A::Error> {
                let mut entries = Vec::new();
                while let Some(entry) = mapping.next_entry::<PubspecValue, PubspecValue>()? {
                    entries.push(entry);
                }
                Ok(PubspecValue::Mapping(entries))
            }
        }

        deserializer.deserialize_any(ValueVisitor)
    }
}

/// Detect a Flutter project by parsing `pubspec.yaml` structurally: only a
/// `dependencies.flutter.sdk: flutter` entry counts.
pub fn detect_flutter(project_dir: &Path) -> Result<(), FrameworkError> {
    let pubspec_path = project_dir.join("pubspec.yaml");
    let file = match std::fs::File::open(&pubspec_path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(FrameworkError::PubspecMissing)
        }
        Err(error) => return Err(FrameworkError::PubspecUnreadable(error.to_string())),
    };

    // Bound the read before allocating or parsing attacker-controlled contents.
    let mut raw = Vec::new();
    file.take((PUBSPEC_MAX_BYTES + 1) as u64)
        .read_to_end(&mut raw)
        .map_err(|error| FrameworkError::PubspecUnreadable(error.to_string()))?;
    if raw.len() > PUBSPEC_MAX_BYTES {
        return Err(FrameworkError::PubspecMalformed(format!(
            "input exceeds {PUBSPEC_MAX_BYTES} bytes"
        )));
    }
    let raw = String::from_utf8(raw)
        .map_err(|error| FrameworkError::PubspecUnreadable(error.to_string()))?;

    // Recursive Serde visitors can exhaust Windows' 1 MiB main-thread stack
    // before reaching the depth budget. Parse and drop values on a fixed stack.
    // A debug build uses about 22 KiB per nesting level, so 8 MiB covers the
    // max_depth of 64 below with about 5x headroom. Resize both together.
    std::thread::Builder::new()
        .name("pubspec-parser".to_owned())
        .stack_size(PUBSPEC_PARSE_STACK_BYTES)
        .spawn(move || parse_pubspec(&raw))
        .map_err(|error| FrameworkError::PubspecUnreadable(error.to_string()))?
        .join()
        .map_err(|_| FrameworkError::PubspecUnreadable("internal YAML parser error".to_owned()))?
}

fn parse_pubspec(raw: &str) -> Result<(), FrameworkError> {
    let options = serde_saphyr::options! {
        budget: serde_saphyr::budget! {
            max_depth: 64,
            flow_nesting_limit: 64,
            max_documents: 1,
            max_events: 100_000,
            max_nodes: 50_000,
            max_aliases: 1_000,
            max_anchors: 1_000,
            max_recorded_anchor_events: 100_000,
            max_recorded_anchor_bytes: PUBSPEC_MAX_BYTES,
            max_total_scalar_bytes: PUBSPEC_MAX_BYTES,
        },
        alias_limits: serde_saphyr::alias_limits! {
            max_total_replayed_events: 100_000,
            max_replay_stack_depth: 32,
            max_alias_expansions_per_anchor: 1_000,
        },
        duplicate_keys: serde_saphyr::DuplicateKeyPolicy::Error,
        merge_keys: serde_saphyr::MergeKeyPolicy::AsOrdinary,
        strict_booleans: true,
        reject_unsupported_tags: true,
        // Preserve scalar spelling instead of decoding a binary SDK into "flutter".
        ignore_binary_tag_for_string: true,
        reject_non_finite_typeless_float: false,
        emit_comments: false,
        with_snippet: false,
    };
    // A generic value also validates unknown fields, including recursive aliases
    // that typed structs can skip. Parse the whole stream with a one-document
    // budget so malformed content after `...` also fails. Empty YAML is not Flutter.
    let pubspecs = serde_saphyr::from_multiple_with_options::<PubspecValue>(raw, options)
        .map_err(|error| FrameworkError::PubspecMalformed(error.to_string()))?;
    let sdk = pubspecs
        .first()
        .and_then(|pubspec| pubspec.get("dependencies"))
        .and_then(|dependencies| dependencies.get("flutter"))
        .and_then(|flutter| flutter.get("sdk"))
        .and_then(PubspecValue::as_str);

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
