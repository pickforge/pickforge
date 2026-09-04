//! Read-only init planning and transactional orchestration.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::adapters::{self, Harness, IntegrationPack, WorkflowRoot};
use crate::transaction::{self, FilePlan};
use crate::{project, state, tools, Environment};

pub const INIT_SCHEMA_VERSION: u32 = 1;
const MAX_STATE_ARTIFACT_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone)]
pub struct InitRequest {
    pub project_dir: PathBuf,
    pub harnesses: Vec<Harness>,
    pub pack: IntegrationPack,
}

impl InitRequest {
    /// The normal `pickforge init` request: every supported harness with the
    /// Flutter integration pack. Callers that only need the project receipt
    /// (tests, diagnostics) can swap in [`IntegrationPack::base`].
    pub fn new(project_dir: impl Into<PathBuf>) -> Self {
        Self {
            project_dir: project_dir.into(),
            harnesses: Harness::ALL.to_vec(),
            pack: IntegrationPack::flutter(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackReport {
    pub name: String,
    pub version: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActionKind {
    Create,
    Update,
    Unchanged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitAction {
    pub target: String,
    pub action: ActionKind,
    pub backup_needed: bool,
    pub summary: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub server_names: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitPlanReport {
    pub schema_version: u32,
    pub project_path: String,
    pub project_id: String,
    pub state_dir: String,
    pub pack: PackReport,
    pub harnesses: Vec<Harness>,
    pub actions: Vec<InitAction>,
}

#[derive(Debug)]
pub struct InitPlan {
    pub report: InitPlanReport,
    files: Vec<FilePlan>,
}

#[derive(Debug, Error)]
pub enum InitError {
    #[error("project directory does not exist: {0}")]
    MissingProject(String),
    #[error("project path is not a directory: {0}")]
    NotDirectory(String),
    #[error("Flutter project validation failed: {0}")]
    Framework(#[from] project::FrameworkError),
    #[error("project identity failed: {0}")]
    Identity(#[from] project::ProjectIdentityError),
    #[error("state directory resolution failed: {0}")]
    State(#[from] state::StateError),
    #[error("init has conflicts:\n{0}")]
    Conflicts(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApplyState {
    Success,
    NoOp,
    FailedRolledBack,
    FailedPartial,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    pub schema_version: u32,
    pub outcome: ApplyState,
    pub changed: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub backup_paths: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub rollback_residuals: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt<'a> {
    schema_version: u32,
    project_path: &'a str,
    project_id: &'a str,
    pack: PackReport,
    harnesses: &'a [Harness],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExistingReceipt {
    schema_version: u32,
    project_path: String,
    project_id: String,
}

fn validate_existing_receipt(
    bytes: &[u8],
    expected_path: &str,
    expected_id: &str,
) -> Result<(), String> {
    let receipt: ExistingReceipt = serde_json::from_slice(bytes).map_err(|error| {
        format!("existing project receipt is not owned Pickforge state: {error}")
    })?;
    if receipt.schema_version != INIT_SCHEMA_VERSION {
        return Err(format!(
            "existing project receipt uses unsupported schema version {}",
            receipt.schema_version
        ));
    }
    if receipt.project_path != expected_path || receipt.project_id != expected_id {
        return Err(
            "existing project receipt belongs to a different project; choose another PICKFORGE_HOME"
                .to_string(),
        );
    }
    Ok(())
}

fn recoverable_state_artifacts(
    state_dir: &Path,
    expected_path: &str,
    expected_id: &str,
) -> Result<bool, String> {
    let entries = std::fs::read_dir(state_dir).map_err(|error| {
        format!(
            "could not inspect state directory {}: {error}",
            state_dir.display()
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "could not inspect state directory {}: {error}",
                state_dir.display()
            )
        })?;
        let file_type = entry.file_type().map_err(|error| {
            format!(
                "could not inspect state artifact {}: {error}",
                entry.path().display()
            )
        })?;
        if file_type.is_symlink() {
            return Ok(false);
        }
        let metadata = entry.metadata().map_err(|error| {
            format!(
                "could not inspect state artifact {}: {error}",
                entry.path().display()
            )
        })?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            return Ok(false);
        };
        if name.starts_with(".pickforge-tmp-")
            && metadata.is_file()
            && metadata.len() <= MAX_STATE_ARTIFACT_BYTES
        {
            continue;
        }
        if !metadata.is_file() || metadata.len() > MAX_STATE_ARTIFACT_BYTES {
            return Ok(false);
        }
        if name.starts_with("project.json.pickforge-backup-") {
            let (_, bytes) = transaction::inspect_file(entry.path(), true).map_err(|error| {
                format!(
                    "could not safely read state backup {}: {error}",
                    entry.path().display()
                )
            })?;
            let bytes = bytes
                .ok_or_else(|| format!("state backup {} disappeared", entry.path().display()))?;
            validate_existing_receipt(&bytes, expected_path, expected_id)?;
            continue;
        }
        return Ok(false);
    }
    Ok(true)
}

fn normalized_harnesses(selected: &[Harness]) -> Vec<Harness> {
    Harness::ALL
        .into_iter()
        .filter(|harness| selected.contains(harness))
        .collect()
}

fn action(
    path: &Path,
    file: &FilePlan,
    summary: String,
    server_names: Vec<String>,
    warning: Option<String>,
) -> InitAction {
    InitAction {
        target: path.to_string_lossy().into_owned(),
        action: if !file.is_changed() {
            ActionKind::Unchanged
        } else if file.is_create() {
            ActionKind::Create
        } else {
            ActionKind::Update
        },
        backup_needed: file.is_changed() && !file.is_create(),
        summary,
        server_names,
        warning,
    }
}

pub fn plan_init(request: &InitRequest, env: &Environment) -> Result<InitPlan, InitError> {
    let canonical = project::canonical_project_path(&request.project_dir);
    let metadata = std::fs::metadata(&canonical)
        .map_err(|_| InitError::MissingProject(canonical.to_string_lossy().into_owned()))?;
    if !metadata.is_dir() {
        return Err(InitError::NotDirectory(
            canonical.to_string_lossy().into_owned(),
        ));
    }
    project::detect_flutter(&canonical)?;
    let project_id = project::derive_project_id(&canonical)?;
    let root = state::state_root(env)?;
    let state_dir = state::project_state_dir(&root, &project_id);
    request
        .pack
        .validate()
        .map_err(|error| InitError::Conflicts(error.to_string()))?;
    let harnesses = normalized_harnesses(&request.harnesses);
    if !harnesses.is_empty() {
        if let Some(tool) = request
            .pack
            .required_tools
            .iter()
            .find(|tool| tools::find_on_path(env, tool).is_none())
        {
            return Err(InitError::Conflicts(format!(
                "{} requires {tool} on PATH; install the Dart/Flutter SDK or fix PATH, then run `pickforge doctor`",
                request.pack.name
            )));
        }
    }
    let mut files = Vec::new();
    let mut actions = Vec::new();
    let mut conflicts = Vec::new();
    let server_names = request
        .pack
        .mcp_servers
        .iter()
        .map(|server| server.name.clone())
        .collect::<Vec<_>>();

    if !request.pack.mcp_servers.is_empty() {
        for harness in Harness::ALL
            .into_iter()
            .filter(|harness| harnesses.contains(harness))
        {
            let target = match adapters::target_for(harness, env) {
                Ok(path) => path,
                Err(error) => {
                    conflicts.push(error);
                    continue;
                }
            };
            let planned = transaction::inspect_file(target.clone(), true);
            let (snapshot, existing) = match planned {
                Ok(value) => value,
                Err(error) => {
                    conflicts.push(error.to_string());
                    continue;
                }
            };
            let text = existing
                .as_deref()
                .map(|bytes| std::str::from_utf8(bytes).expect("preflight validated UTF-8"));
            let transformed = match harness {
                Harness::ClaudeCode => adapters::json_config(
                    text,
                    &request.pack,
                    Harness::ClaudeCode,
                    "Claude Code config",
                ),
                Harness::Pi => {
                    adapters::json_config(text, &request.pack, Harness::Pi, "Pi MCP config")
                }
                Harness::Codex => adapters::codex_config(text, &request.pack),
            };
            match transformed {
                Ok(Some(desired)) => {
                    let file = match snapshot.with_desired(desired) {
                        Ok(file) => file,
                        Err(error) => {
                            conflicts.push(error.to_string());
                            continue;
                        }
                    };
                    let warning = (harness == Harness::Pi).then(|| {
                        "Core Pi has no built-in MCP; this config requires pi-mcp-adapter."
                            .to_string()
                    });
                    actions.push(action(
                        file.path(),
                        &file,
                        format!("Configure {harness} MCP servers"),
                        server_names.clone(),
                        warning,
                    ));
                    files.push(file);
                }
                Ok(None) => {}
                Err(error) => conflicts.push(format!("{}: {error}", snapshot.path().display())),
            }
        }
    }

    for root in [WorkflowRoot::ClaudeSkills, WorkflowRoot::SharedAgentSkills] {
        for workflow in &request.pack.workflows {
            if !workflow
                .targets
                .iter()
                .any(|target| target.root == root && harnesses.contains(&target.harness))
            {
                continue;
            }
            let target_path = match adapters::workflow_target(root, &workflow.name, env) {
                Ok(path) => path,
                Err(error) => {
                    conflicts.push(error);
                    continue;
                }
            };
            match transaction::plan_file(target_path, workflow.content.clone(), true) {
                Ok((file, existing)) => {
                    let foreign_content = existing.as_ref().is_some_and(|content| {
                        content != &workflow.content
                            && !content
                                .windows(workflow.ownership_marker.len())
                                .any(|window| window == workflow.ownership_marker.as_bytes())
                    });
                    if foreign_content {
                        conflicts.push(format!(
                            "{} contains a workflow not managed by Pickforge; move or remove it first",
                            file.path().display()
                        ));
                        continue;
                    }
                    if let Some(planned) =
                        files.iter().find(|planned| planned.path() == file.path())
                    {
                        if planned.desired != file.desired {
                            conflicts.push(format!(
                                "workflow targets resolve to {} with different contents",
                                file.path().display()
                            ));
                        }
                        continue;
                    }
                    actions.push(action(
                        file.path(),
                        &file,
                        format!("Install {} workflow", workflow.name),
                        vec![],
                        None,
                    ));
                    files.push(file);
                }
                Err(error) => conflicts.push(error.to_string()),
            }
        }
    }

    let project_path = canonical
        .to_str()
        .ok_or(project::ProjectIdentityError::NonUtf8Path)?
        .to_string();
    let receipt = Receipt {
        schema_version: INIT_SCHEMA_VERSION,
        project_path: &project_path,
        project_id: &project_id,
        pack: PackReport {
            name: request.pack.name.clone(),
            version: request.pack.version,
        },
        harnesses: &harnesses,
    };
    let mut receipt_bytes = serde_json::to_vec_pretty(&receipt).expect("receipt is serializable");
    receipt_bytes.push(b'\n');
    let receipt_path = state_dir.join("project.json");
    let mut reported_state_dir = state_dir.clone();
    match transaction::plan_file(receipt_path.clone(), receipt_bytes, true) {
        Ok((file, existing)) => {
            let physical_state_dir = file
                .path()
                .parent()
                .expect("receipt target always has a parent");
            let receipt_conflict = if let Some(bytes) = existing {
                validate_existing_receipt(&bytes, &project_path, &project_id).err()
            } else if physical_state_dir.is_dir() {
                match recoverable_state_artifacts(physical_state_dir, &project_path, &project_id) {
                    Ok(false) => Some(format!(
                        "state directory {} is non-empty but has no Pickforge project receipt",
                        physical_state_dir.display()
                    )),
                    Ok(true) => None,
                    Err(error) => Some(error),
                }
            } else {
                None
            };
            if let Some(conflict) = receipt_conflict {
                conflicts.push(conflict);
            } else {
                reported_state_dir = physical_state_dir.to_path_buf();
                actions.push(action(
                    file.path(),
                    &file,
                    "Write external project receipt".into(),
                    vec![],
                    None,
                ));
                files.push(file);
            }
        }
        Err(error) => conflicts.push(error.to_string()),
    }
    if !conflicts.is_empty() {
        let mut unique = BTreeSet::new();
        conflicts.retain(|conflict| unique.insert(conflict.clone()));
        return Err(InitError::Conflicts(conflicts.join("\n")));
    }

    Ok(InitPlan {
        report: InitPlanReport {
            schema_version: INIT_SCHEMA_VERSION,
            project_path,
            project_id,
            state_dir: reported_state_dir.to_string_lossy().into_owned(),
            pack: PackReport {
                name: request.pack.name.clone(),
                version: request.pack.version,
            },
            harnesses,
            actions,
        },
        files,
    })
}

pub fn apply_init(plan: &InitPlan, backup_stamp: &str) -> ApplyReport {
    let changed = plan.files.iter().any(FilePlan::is_changed);
    if !changed {
        return ApplyReport {
            schema_version: INIT_SCHEMA_VERSION,
            outcome: ApplyState::NoOp,
            changed: false,
            backup_paths: vec![],
            rollback_residuals: vec![],
            error: None,
        };
    }
    match transaction::apply_files(&plan.files, backup_stamp) {
        Ok(backups) => ApplyReport {
            schema_version: INIT_SCHEMA_VERSION,
            outcome: ApplyState::Success,
            changed: true,
            backup_paths: backups
                .into_iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
            rollback_residuals: vec![],
            error: None,
        },
        Err(failure) => ApplyReport {
            schema_version: INIT_SCHEMA_VERSION,
            outcome: if failure.rolled_back {
                ApplyState::FailedRolledBack
            } else {
                ApplyState::FailedPartial
            },
            changed: !failure.rolled_back,
            backup_paths: failure
                .backup_paths
                .into_iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
            rollback_residuals: failure
                .residual_paths
                .into_iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
            error: Some(failure.error),
        },
    }
}
