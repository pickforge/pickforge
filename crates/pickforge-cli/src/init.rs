//! Read-only init planning and transactional orchestration.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::adapters::{self, Harness, IntegrationPack};
use crate::transaction::{self, FilePlan};
use crate::{project, state, Environment};

pub const INIT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone)]
pub struct InitRequest {
    pub project_dir: PathBuf,
    pub harnesses: Vec<Harness>,
    pub pack: IntegrationPack,
}

impl InitRequest {
    pub fn new(project_dir: impl Into<PathBuf>) -> Self {
        Self {
            project_dir: project_dir.into(),
            harnesses: Harness::ALL.to_vec(),
            pack: IntegrationPack::base(),
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
            let planned = transaction::plan_file(target.clone(), Vec::new(), true);
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
                Harness::ClaudeCode => {
                    adapters::json_config(text, &request.pack, "Claude Code config")
                }
                Harness::Pi => adapters::json_config(text, &request.pack, "Pi MCP config"),
                Harness::Codex => adapters::codex_config(text, &request.pack),
            };
            match transformed {
                Ok(Some(desired)) => {
                    let file = snapshot.with_desired(desired);
                    let warning = (harness == Harness::Pi).then(|| {
                        "Core Pi has no built-in MCP; this config requires pi-mcp-adapter."
                            .to_string()
                    });
                    actions.push(action(
                        &target,
                        &file,
                        format!("Configure {harness} MCP servers"),
                        server_names.clone(),
                        warning,
                    ));
                    files.push(file);
                }
                Ok(None) => {}
                Err(error) => conflicts.push(format!("{}: {error}", target.display())),
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
    match transaction::plan_file(receipt_path.clone(), receipt_bytes, true) {
        Ok((file, existing)) => {
            let receipt_conflict = if let Some(bytes) = existing {
                validate_existing_receipt(&bytes, &project_path, &project_id).err()
            } else if state_dir.is_dir() {
                match std::fs::read_dir(&state_dir) {
                    Ok(entries) => entries.into_iter().next().map(|_| {
                        format!(
                            "state directory {} is non-empty but has no Pickforge project receipt",
                            state_dir.display()
                        )
                    }),
                    Err(error) => Some(format!(
                        "could not inspect state directory {}: {error}",
                        state_dir.display()
                    )),
                }
            } else {
                None
            };
            if let Some(conflict) = receipt_conflict {
                conflicts.push(conflict);
            } else {
                actions.push(action(
                    &receipt_path,
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
        return Err(InitError::Conflicts(conflicts.join("\n")));
    }

    Ok(InitPlan {
        report: InitPlanReport {
            schema_version: INIT_SCHEMA_VERSION,
            project_path,
            project_id,
            state_dir: state_dir.to_string_lossy().into_owned(),
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
