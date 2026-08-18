//! Single-shot, external Flutter evidence recording.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::time::SystemTime;

use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use time::{format_description, OffsetDateTime};

use crate::{adapters::Harness, project, state, Environment};

pub const EVIDENCE_SCHEMA_VERSION: u32 = 1;
pub const MAX_INPUT_BYTES: u64 = 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RUN_ID_ATTEMPTS: usize = 1024;

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Passed,
    Failed,
    Inconclusive,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Passed,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceInput {
    schema_version: u32,
    scenario: String,
    outcome: Outcome,
    before: PhaseInput,
    after: PhaseInput,
    #[serde(default)]
    source_changes: Vec<String>,
    #[serde(default)]
    checks: Vec<CheckInput>,
    #[serde(default)]
    limitations: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct PhaseInput {
    summary: String,
    #[serde(default)]
    observations: Vec<Observation>,
    #[serde(default)]
    artifacts: Vec<ArtifactInput>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Observation {
    label: String,
    value: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactInput {
    kind: ArtifactKind,
    label: String,
    source: PathBuf,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ArtifactKind {
    Screenshot,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CheckInput {
    name: String,
    status: CheckStatus,
    summary: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceDocument<'a> {
    schema_version: u32,
    run_id: &'a str,
    project_id: &'a str,
    project_path: &'a str,
    created_at: &'a str,
    scenario: &'a str,
    outcome: Outcome,
    before: &'a Phase,
    after: &'a Phase,
    source_changes: &'a [String],
    checks: &'a [CheckInput],
    limitations: &'a [String],
}

#[derive(Debug, Serialize)]
struct Phase {
    summary: String,
    observations: Vec<Observation>,
    artifacts: Vec<Artifact>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Artifact {
    kind: &'static str,
    label: String,
    path: String,
    sha256: String,
    bytes: u64,
    media_type: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordResult {
    pub schema_version: u32,
    pub changed: bool,
    pub run_id: String,
    pub evidence_path: String,
    pub report_path: String,
}

#[derive(Debug, Error)]
pub enum EvidenceError {
    #[error("project directory does not exist or is not a directory: {0}")]
    Project(String),
    #[error("Flutter project validation failed: {0}")]
    Framework(#[from] project::FrameworkError),
    #[error("project identity failed: {0}")]
    Identity(#[from] project::ProjectIdentityError),
    #[error("state directory resolution failed: {0}")]
    State(#[from] state::StateError),
    #[error("valid Pickforge project receipt required: {0}")]
    Receipt(String),
    #[error("evidence input exceeds the 1 MiB limit")]
    InputTooLarge,
    #[error("evidence input is not valid UTF-8")]
    InputUtf8,
    #[error("invalid evidence input: {0}")]
    Input(String),
    #[error("unsafe artifact {path}: {reason}")]
    Artifact { path: PathBuf, reason: String },
    #[error("could not record evidence: {0}")]
    Io(String),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    schema_version: u32,
    project_path: String,
    project_id: String,
    pack: ReceiptPack,
    harnesses: Vec<Harness>,
}
#[derive(Deserialize)]
struct ReceiptPack {
    name: String,
    version: u32,
}

pub fn read_bounded<R: Read>(reader: R) -> Result<Vec<u8>, EvidenceError> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_INPUT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| EvidenceError::Io(e.to_string()))?;
    if bytes.len() as u64 > MAX_INPUT_BYTES {
        return Err(EvidenceError::InputTooLarge);
    }
    if std::str::from_utf8(&bytes).is_err() {
        return Err(EvidenceError::InputUtf8);
    }
    Ok(bytes)
}

pub fn record(
    project_dir: &Path,
    env: &Environment,
    input: &[u8],
) -> Result<RecordResult, EvidenceError> {
    record_at(project_dir, env, input, SystemTime::now())
}

pub fn record_at(
    project_dir: &Path,
    env: &Environment,
    input: &[u8],
    now: SystemTime,
) -> Result<RecordResult, EvidenceError> {
    if input.len() as u64 > MAX_INPUT_BYTES {
        return Err(EvidenceError::InputTooLarge);
    }
    if std::str::from_utf8(input).is_err() {
        return Err(EvidenceError::InputUtf8);
    }
    let canonical = project::canonical_project_path(project_dir);
    if !canonical.is_dir() {
        return Err(EvidenceError::Project(
            canonical.to_string_lossy().into_owned(),
        ));
    }
    project::detect_flutter(&canonical)?;
    let project_id = project::derive_project_id(&canonical)?;
    let project_path = canonical
        .to_str()
        .ok_or(project::ProjectIdentityError::NonUtf8Path)?
        .to_owned();
    let root = state::state_root(env)?;
    let project_state = state::project_state_dir(&root, &project_id);
    validate_receipt(
        &project_state.join("project.json"),
        &project_path,
        &project_id,
    )?;
    let project_state = fs::canonicalize(&project_state)
        .map(project::normalize_windows_canonical_path)
        .map_err(|error| EvidenceError::Receipt(error.to_string()))?;

    let mut parsed: EvidenceInput =
        serde_json::from_slice(input).map_err(|e| EvidenceError::Input(e.to_string()))?;
    validate_input(&parsed)?;
    sanitize_input(&mut parsed);

    let instant = OffsetDateTime::from(now)
        .replace_nanosecond(0)
        .expect("zero nanos valid");
    let created_at = instant
        .format(&format_description::well_known::Rfc3339)
        .expect("RFC3339 formatting");
    let base_id = instant
        .format(
            &format_description::parse_borrowed::<2>(
                "[year][month][day]-[hour][minute][second]-flutter",
            )
            .expect("static format"),
        )
        .expect("run id formatting");
    let runs = project_state.join("runs");
    create_private_dirs(&runs).map_err(|e| EvidenceError::Io(e.to_string()))?;

    for collision in 1..=MAX_RUN_ID_ATTEMPTS {
        let run_id = if collision == 1 {
            base_id.clone()
        } else {
            format!("{base_id}-{collision}")
        };
        let final_dir = runs.join(&run_id);
        if final_dir.exists() {
            continue;
        }
        let temp_dir = runs.join(format!(
            ".pickforge-evidence-{run_id}-{}",
            std::process::id()
        ));
        match create_private_dir(&temp_dir) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(EvidenceError::Io(e.to_string())),
        }
        let result = build_run(
            &temp_dir,
            &run_id,
            &project_id,
            &project_path,
            &created_at,
            parsed.clone(),
        );
        match result {
            Ok(()) => match fs::rename(&temp_dir, &final_dir) {
                Ok(()) => {
                    return Ok(RecordResult {
                        schema_version: EVIDENCE_SCHEMA_VERSION,
                        changed: true,
                        run_id,
                        evidence_path: final_dir
                            .join("evidence.json")
                            .to_string_lossy()
                            .into_owned(),
                        report_path: final_dir.join("report.md").to_string_lossy().into_owned(),
                    })
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::AlreadyExists | io::ErrorKind::DirectoryNotEmpty
                    ) =>
                {
                    let _ = fs::remove_dir_all(&temp_dir);
                    continue;
                }
                Err(e) => {
                    let _ = fs::remove_dir_all(&temp_dir);
                    return Err(EvidenceError::Io(e.to_string()));
                }
            },
            Err(error) => {
                let _ = fs::remove_dir_all(&temp_dir);
                return Err(error);
            }
        }
    }
    Err(EvidenceError::Io(format!(
        "could not allocate an evidence run id after {MAX_RUN_ID_ATTEMPTS} attempts; retry with a later timestamp or inspect {}",
        runs.to_string_lossy()
    )))
}

fn validate_receipt(
    path: &Path,
    project_path: &str,
    project_id: &str,
) -> Result<(), EvidenceError> {
    let remediation =
        "run `pickforge init --mobile-integration-alpha` for this project and selected harnesses";
    let receipt_error = |reason: String| {
        EvidenceError::Receipt(format!(
            "{}: {reason}; {remediation}",
            path.to_string_lossy()
        ))
    };
    let metadata = fs::symlink_metadata(path).map_err(|e| receipt_error(e.to_string()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(receipt_error("receipt is not a regular file".into()));
    }
    let mut file = File::open(path).map_err(|e| receipt_error(e.to_string()))?;
    let opened = file.metadata().map_err(|e| receipt_error(e.to_string()))?;
    if !same_file(&metadata, &opened) {
        return Err(receipt_error("receipt changed while opening".into()));
    }
    let opened_identity = file_identity(&file).map_err(|e| receipt_error(e.to_string()))?;
    if opened_identity.link_count > 1 {
        return Err(receipt_error("receipt is hardlinked".into()));
    }
    let bytes = read_bounded(&mut file).map_err(|e| receipt_error(e.to_string()))?;
    let path_after = fs::symlink_metadata(path).map_err(|e| receipt_error(e.to_string()))?;
    if path_after.file_type().is_symlink()
        || !path_after.is_file()
        || !same_file(&opened, &path_after)
    {
        return Err(receipt_error("receipt path changed while reading".into()));
    }
    let reopened = File::open(path).map_err(|e| receipt_error(e.to_string()))?;
    let reopened_identity = file_identity(&reopened).map_err(|e| receipt_error(e.to_string()))?;
    if opened_identity != reopened_identity || reopened_identity.link_count > 1 {
        return Err(receipt_error("receipt path changed while reading".into()));
    }
    let receipt: Receipt =
        serde_json::from_slice(&bytes).map_err(|e| receipt_error(e.to_string()))?;
    if receipt.schema_version != EVIDENCE_SCHEMA_VERSION
        || receipt.project_path != project_path
        || receipt.project_id != project_id
        || receipt.pack.name != "pickforge-flutter"
        || receipt.pack.version < 1
        || receipt.harnesses.is_empty()
    {
        return Err(receipt_error(
            "receipt does not identify this initialized Flutter project".into(),
        ));
    }
    Ok(())
}

fn validate_input(input: &EvidenceInput) -> Result<(), EvidenceError> {
    if input.schema_version != EVIDENCE_SCHEMA_VERSION {
        return bad(&format!("schemaVersion must be {EVIDENCE_SCHEMA_VERSION}"));
    }
    bounded_line(&input.scenario, 120, "scenario")?;
    validate_phase(&input.before, "before")?;
    validate_phase(&input.after, "after")?;
    if input.before.artifacts.len() + input.after.artifacts.len() > 16 {
        return bad("at most 16 artifacts are allowed");
    }
    if input.source_changes.len() > 64 {
        return bad("sourceChanges exceeds 64 entries");
    }
    for path in &input.source_changes {
        validate_relative_path(path)?;
    }
    if input.checks.len() > 32 {
        return bad("checks exceeds 32 entries");
    }
    for check in &input.checks {
        bounded_line(&check.name, 120, "check name")?;
        bounded_text(&check.summary, 1000, "check summary")?;
    }
    if input.limitations.len() > 32 {
        return bad("limitations exceeds 32 entries");
    }
    for limitation in &input.limitations {
        bounded_text(limitation, 1000, "limitation")?;
    }
    Ok(())
}
fn validate_phase(phase: &PhaseInput, name: &str) -> Result<(), EvidenceError> {
    bounded_text(&phase.summary, 2000, &format!("{name} summary"))?;
    if phase.observations.len() > 32 || phase.artifacts.len() > 8 {
        return bad(&format!("{name} exceeds observation or artifact limits"));
    }
    for item in &phase.observations {
        bounded_line(&item.label, 120, "observation label")?;
        bounded_text(&item.value, 2000, "observation value")?;
    }
    for artifact in &phase.artifacts {
        bounded_line(&artifact.label, 120, "artifact label")?;
        if !artifact.source.is_absolute() {
            return bad("artifact source must be absolute");
        }
        if artifact
            .source
            .to_string_lossy()
            .chars()
            .any(|character| character.is_control() || is_bidi_control(character))
        {
            return bad("artifact source contains a control or bidi-control character");
        }
    }
    Ok(())
}
fn is_bidi_control(character: char) -> bool {
    matches!(
        character,
        '\u{061c}'
            | '\u{200e}'
            | '\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2066}'..='\u{2069}'
    )
}
fn bounded_line(value: &str, max: usize, name: &str) -> Result<(), EvidenceError> {
    if value.is_empty()
        || value.chars().count() > max
        || value
            .chars()
            .any(|character| character.is_control() || is_bidi_control(character))
    {
        bad(&format!(
            "{name} must be nonempty, single-line, control-free, and at most {max} characters"
        ))
    } else {
        Ok(())
    }
}
fn bounded_text(value: &str, max: usize, name: &str) -> Result<(), EvidenceError> {
    if value.chars().count() > max
        || value.chars().any(|c| {
            is_bidi_control(c) || c == '\0' || (c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
        })
    {
        bad(&format!(
            "{name} contains controls or exceeds {max} characters"
        ))
    } else {
        Ok(())
    }
}
fn validate_relative_path(value: &str) -> Result<(), EvidenceError> {
    if value.is_empty()
        || value
            .chars()
            .any(|character| character.is_control() || is_bidi_control(character))
    {
        return bad("sourceChanges contains an empty, control-character, or bidi-control path");
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        || value.contains('\\')
    {
        return bad("sourceChanges must contain normalized project-relative paths");
    }
    Ok(())
}
fn bad<T>(message: &str) -> Result<T, EvidenceError> {
    Err(EvidenceError::Input(message.into()))
}

fn sanitize_input(input: &mut EvidenceInput) {
    input.scenario = redact_secrets(&input.scenario);
    sanitize_phase(&mut input.before);
    sanitize_phase(&mut input.after);
    for path in &mut input.source_changes {
        *path = redact_secrets(path);
    }
    input.source_changes.sort();
    input.source_changes.dedup();
    for check in &mut input.checks {
        check.name = redact_secrets(&check.name);
        check.summary = redact_secrets(&check.summary);
    }
    for value in &mut input.limitations {
        *value = redact_secrets(value);
    }
}
fn sanitize_phase(phase: &mut PhaseInput) {
    phase.summary = redact_secrets(&phase.summary);
    for item in &mut phase.observations {
        item.label = redact_secrets(&item.label);
        item.value = redact_secrets(&item.value);
    }
    for item in &mut phase.artifacts {
        item.label = redact_secrets(&item.label);
    }
}

fn redact_secrets(value: &str) -> String {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| vec![
        Regex::new(r#"(?i)(\b(?:authorization|set-cookie|cookie)\b\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*')"#).unwrap(),
        Regex::new(r#"(?i)(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;\"']+"#).unwrap(),
        Regex::new(r#"(?i)((?:set-cookie|cookie)\s*[:=]\s*)[^\s,;\"']+"#).unwrap(),
        Regex::new(r#"(?i)(\b(?:api[_-]?key|token|secret|password|passwd)\b\s*[=:]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;\"']+)"#).unwrap(),
        Regex::new(r#"(?i)(\"(?:api[_-]?key|token|secret|password|authorization|cookie|set-cookie)\"\s*:\s*\")[^\"]*(\")"#).unwrap(),
        Regex::new(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b").unwrap(),
        Regex::new(r"\b(?:gh[pousr]_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{16})\b").unwrap(),
    ]);
    let mut output = value.to_owned();
    for (index, pattern) in patterns.iter().enumerate() {
        output = if index == 4 {
            pattern.replace_all(&output, "$1[REDACTED]$2").into_owned()
        } else if index < 4 {
            pattern.replace_all(&output, "$1[REDACTED]").into_owned()
        } else {
            pattern.replace_all(&output, "[REDACTED]").into_owned()
        };
    }
    output
}

fn build_run(
    temp: &Path,
    run_id: &str,
    project_id: &str,
    project_path: &str,
    created_at: &str,
    input: EvidenceInput,
) -> Result<(), EvidenceError> {
    let artifacts_dir = temp.join("artifacts");
    create_private_dir(&artifacts_dir).map_err(|e| EvidenceError::Io(e.to_string()))?;
    let mut total = 0u64;
    let mut known = BTreeMap::<String, Artifact>::new();
    let before = materialize_phase(
        input.before,
        "before",
        &artifacts_dir,
        &mut total,
        &mut known,
    )?;
    let after = materialize_phase(input.after, "after", &artifacts_dir, &mut total, &mut known)?;
    let doc = EvidenceDocument {
        schema_version: EVIDENCE_SCHEMA_VERSION,
        run_id,
        project_id,
        project_path,
        created_at,
        scenario: &input.scenario,
        outcome: input.outcome,
        before: &before,
        after: &after,
        source_changes: &input.source_changes,
        checks: &input.checks,
        limitations: &input.limitations,
    };
    let mut json = serde_json::to_vec_pretty(&doc).expect("typed evidence serializes");
    json.push(b'\n');
    write_private(&temp.join("evidence.json"), &json)?;
    write_private(&temp.join("report.md"), render_report(&doc).as_bytes())?;
    Ok(())
}
fn materialize_phase(
    input: PhaseInput,
    phase: &str,
    dir: &Path,
    total: &mut u64,
    known: &mut BTreeMap<String, Artifact>,
) -> Result<Phase, EvidenceError> {
    let mut artifacts = Vec::new();
    for source in input.artifacts {
        let ArtifactKind::Screenshot = source.kind;
        let (bytes, media, ext, hash) = read_image(&source.source)?;
        let artifact = if let Some(existing) = known.get(&hash) {
            existing.clone()
        } else {
            *total = total
                .checked_add(bytes.len() as u64)
                .ok_or_else(|| EvidenceError::Input("artifact byte total overflow".into()))?;
            if *total > MAX_TOTAL_IMAGE_BYTES {
                return Err(EvidenceError::Artifact {
                    path: source.source,
                    reason: "copied artifacts exceed 64 MiB total".into(),
                });
            }
            let slug = slug(&source.label);
            let relative = format!("artifacts/{phase}-{slug}-{}.{ext}", &hash[..12]);
            let target = dir.parent().unwrap().join(&relative);
            if target.exists() {
                let existing = fs::read(&target).map_err(|e| EvidenceError::Io(e.to_string()))?;
                if existing != bytes {
                    return Err(EvidenceError::Artifact {
                        path: target,
                        reason: "content-addressed filename collision".into(),
                    });
                }
            } else {
                write_private(&target, &bytes)?;
            }
            let artifact = Artifact {
                kind: "screenshot",
                label: source.label.clone(),
                path: relative,
                sha256: hash.clone(),
                bytes: bytes.len() as u64,
                media_type: media,
            };
            known.insert(hash.clone(), artifact.clone());
            artifact
        };
        let mut artifact = artifact;
        artifact.label = source.label;
        artifacts.push(artifact);
    }
    Ok(Phase {
        summary: input.summary,
        observations: input.observations,
        artifacts,
    })
}
fn read_image(path: &Path) -> Result<(Vec<u8>, &'static str, &'static str, String), EvidenceError> {
    let fail = |reason: &str| EvidenceError::Artifact {
        path: path.into(),
        reason: reason.into(),
    };
    let before = fs::symlink_metadata(path).map_err(|e| fail(&e.to_string()))?;
    if before.file_type().is_symlink() || !before.is_file() {
        return Err(fail("source must be a non-symlink regular file"));
    }
    if before.len() > MAX_IMAGE_BYTES {
        return Err(fail("image exceeds 8 MiB"));
    }
    let mut file = File::open(path).map_err(|e| fail(&e.to_string()))?;
    let opened = file.metadata().map_err(|e| fail(&e.to_string()))?;
    if !same_file(&before, &opened) {
        return Err(fail("source changed while opening"));
    }
    let opened_identity = file_identity(&file).map_err(|e| fail(&e.to_string()))?;
    if opened_identity.link_count > 1 {
        return Err(fail("hardlinked source is refused"));
    }
    let mut bytes = Vec::with_capacity((opened.len().min(MAX_IMAGE_BYTES + 1)) as usize);
    Read::by_ref(&mut file)
        .take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| fail(&e.to_string()))?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(fail("image exceeds 8 MiB"));
    }
    let after = file.metadata().map_err(|e| fail(&e.to_string()))?;
    if !same_file(&opened, &after) || after.len() != bytes.len() as u64 {
        return Err(fail("source changed while copying"));
    }
    let path_after = fs::symlink_metadata(path).map_err(|e| fail(&e.to_string()))?;
    if path_after.file_type().is_symlink()
        || !path_after.is_file()
        || !same_file(&opened, &path_after)
    {
        return Err(fail("source path was replaced while copying"));
    }
    let reopened = File::open(path).map_err(|e| fail(&e.to_string()))?;
    let reopened_identity = file_identity(&reopened).map_err(|e| fail(&e.to_string()))?;
    if opened_identity != reopened_identity {
        return Err(fail("source path was replaced while copying"));
    }
    if reopened_identity.link_count > 1 {
        return Err(fail("hardlinked source is refused"));
    }
    let (media, ext) =
        image_type(&bytes).ok_or_else(|| fail("source is not a PNG, JPEG, or WebP image"))?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    Ok((bytes, media, ext, hash))
}
#[cfg(unix)]
fn same_file(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
}
#[cfg(windows)]
fn same_file(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    a.file_attributes() == b.file_attributes()
        && a.creation_time() == b.creation_time()
        && a.last_write_time() == b.last_write_time()
        && a.file_size() == b.file_size()
}
#[cfg(not(any(unix, windows)))]
fn same_file(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    a.len() == b.len() && a.modified().ok() == b.modified().ok()
}
#[derive(Debug, PartialEq, Eq)]
struct FileIdentity {
    volume: u64,
    index: u64,
    link_count: u64,
}

#[cfg(unix)]
fn file_identity(file: &File) -> io::Result<FileIdentity> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    Ok(FileIdentity {
        volume: metadata.dev(),
        index: metadata.ino(),
        link_count: metadata.nlink(),
    })
}

#[cfg(windows)]
fn file_identity(file: &File) -> io::Result<FileIdentity> {
    use std::mem::MaybeUninit;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
    // SAFETY: the handle is owned by `file`, and Windows initializes `information` on success.
    let succeeded =
        unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) };
    if succeeded == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: GetFileInformationByHandle succeeded and initialized the structure.
    let information = unsafe { information.assume_init() };
    Ok(FileIdentity {
        volume: information.dwVolumeSerialNumber as u64,
        index: ((information.nFileIndexHigh as u64) << 32) | information.nFileIndexLow as u64,
        link_count: information.nNumberOfLinks as u64,
    })
}

#[cfg(not(any(unix, windows)))]
fn file_identity(file: &File) -> io::Result<FileIdentity> {
    let metadata = file.metadata()?;
    Ok(FileIdentity {
        volume: 0,
        index: 0,
        link_count: 1,
    })
}
fn image_type(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(("image/png", "png"))
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some(("image/jpeg", "jpg"))
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(("image/webp", "webp"))
    } else {
        None
    }
}
fn slug(value: &str) -> String {
    let mut out = String::new();
    for c in value.to_ascii_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_matches('-');
    if out.is_empty() {
        "artifact".into()
    } else {
        out.chars().take(40).collect()
    }
}
fn normalize_markdown(value: &str) -> String {
    let flat = value
        .replace("\r\n", " ")
        .replace(['\r', '\n', '\t'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut escaped = String::new();
    for character in flat.chars() {
        if matches!(
            character,
            '\\' | '#' | '*' | '_' | '`' | '[' | ']' | '<' | '>'
        ) {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped.replace("\\[REDACTED\\]", "[REDACTED]")
}
fn render_report(doc: &EvidenceDocument<'_>) -> String {
    let outcome = match doc.outcome {
        Outcome::Passed => "passed",
        Outcome::Failed => "failed",
        Outcome::Inconclusive => "inconclusive",
    };
    let mut out = format!(
        "# Flutter evidence: {}\n\n**Outcome:** {outcome}\n\n## Before\n\n{}\n",
        normalize_markdown(doc.scenario),
        normalize_markdown(&doc.before.summary)
    );
    render_observations(&mut out, &doc.before.observations);
    out.push_str("\n## After\n\n");
    out.push_str(&normalize_markdown(&doc.after.summary));
    out.push('\n');
    render_observations(&mut out, &doc.after.observations);
    out.push_str("\n## Source changes\n\n");
    render_list(
        &mut out,
        doc.source_changes.iter().map(|s| normalize_markdown(s)),
    );
    out.push_str("\n## Checks\n\n");
    if doc.checks.is_empty() {
        out.push_str("- None\n");
    } else {
        for c in doc.checks {
            out.push_str(&format!(
                "- **{}** ({:?}): {}\n",
                normalize_markdown(&c.name),
                c.status,
                normalize_markdown(&c.summary)
            ));
        }
    }
    out.push_str("\n## Artifacts\n\n");
    let all = doc
        .before
        .artifacts
        .iter()
        .chain(&doc.after.artifacts)
        .collect::<Vec<_>>();
    if all.is_empty() {
        out.push_str("- None\n");
    } else {
        for a in all {
            out.push_str(&format!(
                "- [{}]({}) ({} bytes, `{}`)\n",
                normalize_markdown(&a.label),
                normalize_markdown(&a.path),
                a.bytes,
                a.sha256
            ));
        }
    }
    out.push_str("\n## Limitations\n\n");
    render_list(
        &mut out,
        doc.limitations.iter().map(|s| normalize_markdown(s)),
    );
    out
}
fn render_observations(out: &mut String, items: &[Observation]) {
    if !items.is_empty() {
        out.push('\n');
        for item in items {
            out.push_str(&format!(
                "- **{}:** {}\n",
                normalize_markdown(&item.label),
                normalize_markdown(&item.value)
            ));
        }
    }
}
fn render_list(out: &mut String, items: impl Iterator<Item = String>) {
    let items = items.collect::<Vec<_>>();
    if items.is_empty() {
        out.push_str("- None\n");
    } else {
        for item in items {
            out.push_str(&format!("- {item}\n"));
        }
    }
}
fn create_private_dirs(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
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
            let metadata = fs::symlink_metadata(path)?;
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
fn create_private_dir(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700).create(path)
    }
    #[cfg(not(unix))]
    fs::DirBuilder::new().create(path)
}
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), EvidenceError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|e| EvidenceError::Io(e.to_string()))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| EvidenceError::Io(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn redacts_supported_secret_shapes() {
        let raw = "api_key=abc123 token: \"quoted\" password='single' JSON {\"token\":\"xyz\"} Authorization: Bearer hello Cookie: sid=secret eyJabc.def.ghi ghp_123456789 sk-123456789 AKIA1234567890123456";
        let clean = redact_secrets(raw);
        for secret in [
            "abc123",
            "quoted",
            "single",
            "xyz",
            "hello",
            "sid=secret",
            "eyJabc.def.ghi",
            "ghp_123456789",
            "sk-123456789",
            "AKIA1234567890123456",
        ] {
            assert!(!clean.contains(secret), "{clean}");
        }
    }

    #[test]
    fn quoted_authorization_and_cookie_keep_safe_trailing_text() {
        let clean = redact_secrets(
            "authorization: \"planted-auth-secret\" safe-yaml cookie = 'planted-cookie-secret' safe-toml",
        );
        assert!(!clean.contains("planted-auth-secret"), "{clean}");
        assert!(!clean.contains("planted-cookie-secret"), "{clean}");
        assert!(clean.contains("safe-yaml"), "{clean}");
        assert!(clean.contains("safe-toml"), "{clean}");
    }

    #[test]
    fn recognizes_image_magic() {
        assert_eq!(
            image_type(b"\x89PNG\r\n\x1a\nrest"),
            Some(("image/png", "png"))
        );
        assert_eq!(
            image_type(b"\xff\xd8\xffwithout-eoi"),
            Some(("image/jpeg", "jpg"))
        );
        assert_eq!(image_type(b"suffix.png"), None);
    }

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
        let metadata = fs::symlink_metadata(path).unwrap();
        assert!(metadata.is_dir());
        assert!(!metadata.file_type().is_symlink());
    }
}
