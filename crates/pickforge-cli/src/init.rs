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
    /// The project state directory whose shared layout `apply` claims. `None`
    /// when planning found a conflict there and wrote no receipt action.
    layout_dir: Option<PathBuf>,
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

use state::manual_action;

/// Inspect the entries the integration CLI owns in a state directory that has
/// no receipt yet, deciding whether `init` may still claim it.
///
/// Shared entries ([`state::Owner::Shared`]) are skipped untouched: a lab run
/// that happened before `pickforge init` is normal, not a conflict (#104), and
/// the marker is judged by [`state::read_layout`] rather than here. Only a
/// genuinely foreign entry, or an unreadable/oversized owned one, blocks init.
fn recoverable_state_artifacts(
    state_dir: &Path,
    expected_path: &str,
    expected_id: &str,
) -> Result<(), String> {
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
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            return Err(manual_action(
                &entry.path(),
                "has a name that is not valid UTF-8 and cannot be attributed to an owner",
            ));
        };
        let owner = state::classify_entry(name);
        match owner {
            // The run tree is shared: the lab creates it and `pickforge
            // evidence record` writes its own runs into it, each below its own
            // run directory. Neither tool polices the other's entries there,
            // and the marker is validated by `state::read_layout`.
            state::Owner::Shared => continue,
            state::Owner::Foreign => {
                return Err(manual_action(
                    &entry.path(),
                    "is not owned by Pickforge or the Pickforge lab",
                ))
            }
            state::Owner::Transient | state::Owner::Integration => {}
        }

        let file_type = entry.file_type().map_err(|error| {
            format!(
                "could not inspect state artifact {}: {error}",
                entry.path().display()
            )
        })?;
        if file_type.is_symlink() {
            return Err(manual_action(
                &entry.path(),
                "is a symlink where Pickforge expects a regular file",
            ));
        }
        let metadata = entry.metadata().map_err(|error| {
            format!(
                "could not inspect state artifact {}: {error}",
                entry.path().display()
            )
        })?;
        // A transient left by a crashed write is inert: bound its size and
        // shape as a sanity check, then leave it alone.
        if owner == state::Owner::Transient
            && metadata.is_file()
            && metadata.len() <= MAX_STATE_ARTIFACT_BYTES
        {
            continue;
        }
        if !metadata.is_file() || metadata.len() > MAX_STATE_ARTIFACT_BYTES {
            return Err(manual_action(
                &entry.path(),
                "is not a regular file of the expected size for Pickforge state",
            ));
        }
        let (_, bytes) = transaction::inspect_file(entry.path(), true).map_err(|error| {
            format!(
                "could not safely read state backup {}: {error}",
                entry.path().display()
            )
        })?;
        let bytes =
            bytes.ok_or_else(|| format!("state backup {} disappeared", entry.path().display()))?;
        validate_existing_receipt(&bytes, expected_path, expected_id)?;
    }
    Ok(())
}

/// Plan the integration receipt for `state_dir`, or describe why the CLI may
/// not claim that directory.
///
/// This is the whole ownership decision for the shared project state
/// directory: the layout version must be one this build understands, an
/// existing receipt must be this project's, and a directory without a receipt
/// must hold nothing but entries Pickforge or the lab owns.
fn plan_receipt(
    state_dir: &Path,
    receipt_bytes: Vec<u8>,
    project_path: &str,
    project_id: &str,
) -> Result<FilePlan, String> {
    // The state directory itself must be a real directory. The transaction
    // layer below canonicalises the receipt's path, so a symlinked
    // `projects/<id>` would otherwise be followed here while the lab refuses
    // it (#104 R3); the check is on the logical path, before that happens.
    state::assert_real_state_dir(state_dir).map_err(|error| error.to_string())?;
    let (file, existing) =
        transaction::plan_file(state_dir.join("project.json"), receipt_bytes, true)
            .map_err(|error| error.to_string())?;
    let physical_state_dir = file
        .path()
        .parent()
        .expect("receipt target always has a parent");

    // A layout stamped by a newer build, or a stray `layout.json`, is reported
    // before anything else: the ownership rules below are only meaningful for
    // a layout this build understands.
    let layout = state::read_layout(physical_state_dir).map_err(|error| error.to_string())?;
    if let Some(bytes) = existing {
        validate_existing_receipt(&bytes, project_path, project_id)?;
    } else if physical_state_dir.is_dir() {
        recoverable_state_artifacts(physical_state_dir, project_path, project_id)?;
    }
    // A directory with no marker is about to be adopted, and adoption runs the
    // direct-entry rule. A receipt beside a foreign entry used to skip the
    // check above, so `--dry-run` reported a clean plan for a directory the
    // real run then refused (#104 R2): the preview now refuses it too, and
    // still writes nothing.
    if layout.is_none() {
        state::assert_adoptable_dir(physical_state_dir).map_err(|error| error.to_string())?;
    }
    Ok(file)
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

/// Everything a plan derives from the request before any file is inspected.
struct InitContext {
    project_path: String,
    project_id: String,
    state_dir: PathBuf,
    harnesses: Vec<Harness>,
}

/// Resolve and validate the project, its identity, and the pack, or fail
/// before anything is planned.
fn init_context(request: &InitRequest, env: &Environment) -> Result<InitContext, InitError> {
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
    let state_dir = state::project_state_dir(&state::state_root(env)?, &project_id);
    request
        .pack
        .validate()
        .map_err(|error| InitError::Conflicts(error.to_string()))?;
    let harnesses = normalized_harnesses(&request.harnesses);
    require_pack_tools(request, env, &harnesses)?;
    let project_path = canonical
        .to_str()
        .ok_or(project::ProjectIdentityError::NonUtf8Path)?
        .to_string();
    Ok(InitContext {
        project_path,
        project_id,
        state_dir,
        harnesses,
    })
}

/// A pack's tools only matter when it has a harness to configure.
fn require_pack_tools(
    request: &InitRequest,
    env: &Environment,
    harnesses: &[Harness],
) -> Result<(), InitError> {
    if harnesses.is_empty() {
        return Ok(());
    }
    let missing = request
        .pack
        .required_tools
        .iter()
        .find(|tool| tools::find_on_path(env, tool).is_none());
    match missing {
        None => Ok(()),
        Some(tool) => Err(InitError::Conflicts(format!(
            "{} requires {tool} on PATH; install the Dart/Flutter SDK or fix PATH, then run `pickforge doctor`",
            request.pack.name
        ))),
    }
}

/// The planned files, the actions reported for them, and everything that
/// blocks the plan.
#[derive(Default)]
struct PlanBuilder {
    files: Vec<FilePlan>,
    actions: Vec<InitAction>,
    conflicts: Vec<String>,
}

impl PlanBuilder {
    fn push(
        &mut self,
        file: FilePlan,
        summary: String,
        server_names: Vec<String>,
        warning: Option<String>,
    ) {
        self.actions
            .push(action(file.path(), &file, summary, server_names, warning));
        self.files.push(file);
    }

    fn record(&mut self, outcome: Result<(), String>) {
        if let Err(conflict) = outcome {
            self.conflicts.push(conflict);
        }
    }

    /// Turn the accumulated plan into a report, or into the conflict list that
    /// stops it. Conflicts are de-duplicated in the order they were found.
    fn finish(
        mut self,
        request: &InitRequest,
        context: InitContext,
        layout_dir: Option<PathBuf>,
    ) -> Result<InitPlan, InitError> {
        if !self.conflicts.is_empty() {
            let mut unique = BTreeSet::new();
            self.conflicts
                .retain(|conflict| unique.insert(conflict.clone()));
            return Err(InitError::Conflicts(self.conflicts.join("\n")));
        }
        let state_dir = layout_dir.clone().unwrap_or(context.state_dir);
        Ok(InitPlan {
            report: InitPlanReport {
                schema_version: INIT_SCHEMA_VERSION,
                project_path: context.project_path,
                project_id: context.project_id,
                state_dir: state_dir.to_string_lossy().into_owned(),
                pack: PackReport {
                    name: request.pack.name.clone(),
                    version: request.pack.version,
                },
                harnesses: context.harnesses,
                actions: self.actions,
            },
            files: self.files,
            layout_dir,
        })
    }
}

/// Plan one harness's MCP config, or `Ok(None)` when the pack leaves it alone.
fn plan_harness_config(
    request: &InitRequest,
    env: &Environment,
    harness: Harness,
) -> Result<Option<FilePlan>, String> {
    let target = adapters::target_for(harness, env)?;
    let (snapshot, existing) =
        transaction::inspect_file(target, true).map_err(|error| error.to_string())?;
    let text = existing
        .as_deref()
        .map(|bytes| std::str::from_utf8(bytes).expect("preflight validated UTF-8"));
    let transformed = match harness {
        Harness::ClaudeCode => {
            adapters::json_config(text, &request.pack, harness, "Claude Code config")
        }
        Harness::Pi => adapters::json_config(text, &request.pack, harness, "Pi MCP config"),
        Harness::Codex => adapters::codex_config(text, &request.pack),
    }
    .map_err(|error| format!("{}: {error}", snapshot.path().display()))?;
    let Some(desired) = transformed else {
        return Ok(None);
    };
    snapshot
        .with_desired(desired)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn plan_harness_configs(
    builder: &mut PlanBuilder,
    request: &InitRequest,
    env: &Environment,
    harnesses: &[Harness],
) {
    if request.pack.mcp_servers.is_empty() {
        return;
    }
    let server_names = request
        .pack
        .mcp_servers
        .iter()
        .map(|server| server.name.clone())
        .collect::<Vec<_>>();
    for harness in Harness::ALL
        .into_iter()
        .filter(|harness| harnesses.contains(harness))
    {
        let outcome = plan_harness_config(request, env, harness).map(|planned| {
            if let Some(file) = planned {
                let warning = (harness == Harness::Pi).then(|| {
                    "Core Pi has no built-in MCP; this config requires pi-mcp-adapter.".to_string()
                });
                builder.push(
                    file,
                    format!("Configure {harness} MCP servers"),
                    server_names.clone(),
                    warning,
                );
            }
        });
        builder.record(outcome);
    }
}

/// A workflow file that is not the one Pickforge manages must not be replaced.
fn is_foreign_workflow(workflow: &adapters::WorkflowSpec, existing: Option<&[u8]>) -> bool {
    existing.is_some_and(|content| {
        content != workflow.content
            && !content
                .windows(workflow.ownership_marker.len())
                .any(|window| window == workflow.ownership_marker.as_bytes())
    })
}

/// Plan one workflow file, or `Ok(None)` when an identical file is already
/// planned for the same path (the two workflow roots can resolve together).
fn plan_workflow(
    planned: &[FilePlan],
    workflow: &adapters::WorkflowSpec,
    root: WorkflowRoot,
    env: &Environment,
) -> Result<Option<FilePlan>, String> {
    let target_path = adapters::workflow_target(root, &workflow.name, env)?;
    let (file, existing) = transaction::plan_file(target_path, workflow.content.clone(), true)
        .map_err(|error| error.to_string())?;
    if is_foreign_workflow(workflow, existing.as_deref()) {
        return Err(format!(
            "{} contains a workflow not managed by Pickforge; move or remove it first",
            file.path().display()
        ));
    }
    match planned.iter().find(|prior| prior.path() == file.path()) {
        Some(prior) if prior.desired != file.desired => Err(format!(
            "workflow targets resolve to {} with different contents",
            file.path().display()
        )),
        Some(_) => Ok(None),
        None => Ok(Some(file)),
    }
}

fn plan_workflows(
    builder: &mut PlanBuilder,
    request: &InitRequest,
    env: &Environment,
    harnesses: &[Harness],
) {
    for root in [WorkflowRoot::ClaudeSkills, WorkflowRoot::SharedAgentSkills] {
        for workflow in &request.pack.workflows {
            let wanted = workflow
                .targets
                .iter()
                .any(|target| target.root == root && harnesses.contains(&target.harness));
            if !wanted {
                continue;
            }
            let outcome = plan_workflow(&builder.files, workflow, root, env).map(|planned| {
                if let Some(file) = planned {
                    let summary = format!("Install {} workflow", workflow.name);
                    builder.push(file, summary, vec![], None);
                }
            });
            builder.record(outcome);
        }
    }
}

/// The receipt bytes this run would write.
fn receipt_bytes(request: &InitRequest, context: &InitContext) -> Vec<u8> {
    let receipt = Receipt {
        schema_version: INIT_SCHEMA_VERSION,
        project_path: &context.project_path,
        project_id: &context.project_id,
        pack: PackReport {
            name: request.pack.name.clone(),
            version: request.pack.version,
        },
        harnesses: &context.harnesses,
    };
    let mut bytes = serde_json::to_vec_pretty(&receipt).expect("receipt is serializable");
    bytes.push(b'\n');
    bytes
}

/// Plan the receipt and return the state directory whose layout `apply` will
/// claim, or `None` when planning the receipt conflicted.
fn plan_receipt_action(
    builder: &mut PlanBuilder,
    request: &InitRequest,
    context: &InitContext,
) -> Option<PathBuf> {
    let planned = plan_receipt(
        &context.state_dir,
        receipt_bytes(request, context),
        &context.project_path,
        &context.project_id,
    );
    match planned {
        Ok(file) => {
            let layout_dir = file
                .path()
                .parent()
                .expect("receipt target always has a parent")
                .to_path_buf();
            builder.push(file, "Write external project receipt".into(), vec![], None);
            Some(layout_dir)
        }
        Err(conflict) => {
            builder.conflicts.push(conflict);
            None
        }
    }
}

pub fn plan_init(request: &InitRequest, env: &Environment) -> Result<InitPlan, InitError> {
    let context = init_context(request, env)?;
    let mut builder = PlanBuilder::default();
    plan_harness_configs(&mut builder, request, env, &context.harnesses);
    plan_workflows(&mut builder, request, env, &context.harnesses);
    let layout_dir = plan_receipt_action(&mut builder, request, &context);
    builder.finish(request, context, layout_dir)
}

/// Stamp the shared layout marker before any file is written.
///
/// Claiming first means a state directory is either unclaimed or carries a
/// marker this build understands for the whole of `apply`; it can never end up
/// holding a receipt under a layout nobody agreed on. The claim is atomic and
/// additive, so it is also how an alpha.1/alpha.2 directory is adopted: the
/// marker appears, and nothing already there is touched.
fn claim_layout_for(plan: &InitPlan) -> Result<bool, String> {
    match &plan.layout_dir {
        Some(dir) => state::claim_layout(dir).map_err(|error| error.to_string()),
        None => Ok(false),
    }
}

pub fn apply_init(plan: &InitPlan, backup_stamp: &str) -> ApplyReport {
    let claimed = match claim_layout_for(plan) {
        Ok(claimed) => claimed,
        Err(error) => {
            return ApplyReport {
                schema_version: INIT_SCHEMA_VERSION,
                outcome: ApplyState::FailedRolledBack,
                changed: false,
                backup_paths: vec![],
                rollback_residuals: vec![],
                error: Some(error),
            }
        }
    };
    let changed = plan.files.iter().any(FilePlan::is_changed);
    if !changed {
        return ApplyReport {
            schema_version: INIT_SCHEMA_VERSION,
            outcome: if claimed {
                ApplyState::Success
            } else {
                ApplyState::NoOp
            },
            changed: claimed,
            backup_paths: vec![],
            rollback_residuals: vec![],
            error: None,
        };
    }
    let report = apply_planned_files(plan, backup_stamp);
    account_for_claim(report, plan, claimed)
}

/// A marker this run published is a real change the file transaction knows
/// nothing about, so a failure after it cannot be reported as a clean
/// rollback. The marker is left in place — a concurrent tool may already have
/// joined the directory on the strength of it — and reported as a residual.
fn account_for_claim(report: ApplyReport, plan: &InitPlan, claimed: bool) -> ApplyReport {
    let Some(dir) = plan.layout_dir.as_ref().filter(|_| claimed) else {
        return report;
    };
    if matches!(report.outcome, ApplyState::Success | ApplyState::NoOp) {
        return report;
    }
    let mut residuals = report.rollback_residuals;
    residuals.push(
        dir.join(state::LAYOUT_MARKER)
            .to_string_lossy()
            .into_owned(),
    );
    ApplyReport {
        outcome: ApplyState::FailedPartial,
        changed: true,
        rollback_residuals: residuals,
        ..report
    }
}

/// Apply the planned files. Only called once at least one file changed.
fn apply_planned_files(plan: &InitPlan, backup_stamp: &str) -> ApplyReport {
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
