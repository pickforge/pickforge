//! The `doctor` diagnostics: does this project directory look ready for the
//! next integration-pack step?
//!
//! Read-only by construction: nothing here writes, creates directories, runs
//! the discovered tools, or touches the network.

use std::path::Path;

use crate::env::Environment;
use crate::project::{canonical_project_path, derive_project_id, detect_flutter, FrameworkError};
use crate::report::{Check, CheckStatus, DoctorReport, ProjectInfo};
use crate::state::{project_state_dir, state_root, StateError, HOME_ENV_VAR};

/// Required build tools, in report order.
const REQUIRED_TOOLS: [&str; 2] = ["flutter", "dart"];
/// Supported agent harnesses, in report order. At least one must exist.
const HARNESSES: [&str; 3] = ["claude", "codex", "pi"];

/// Diagnose `project_dir` against `env`, returning a fully resolved report.
/// Never panics and never mutates anything.
pub fn diagnose(project_dir: &Path, env: &Environment) -> DoctorReport {
    let canonical = canonical_project_path(project_dir);
    let project_id = derive_project_id(&canonical);
    let mut checks = Vec::new();

    let metadata = std::fs::metadata(&canonical);
    let is_directory = metadata.as_ref().map(|meta| meta.is_dir()).unwrap_or(false);
    checks.push(directory_check(
        &canonical,
        metadata.as_ref().err(),
        is_directory,
    ));

    let framework = if is_directory {
        detect_flutter(&canonical)
    } else {
        Err(FrameworkError::PubspecMissing)
    };
    checks.push(framework_check(&canonical, &framework));

    for tool in REQUIRED_TOOLS {
        checks.push(required_tool_check(env, tool));
    }
    let mut found_harnesses = Vec::new();
    for harness in HARNESSES {
        let found = crate::tools::find_on_path(env, harness);
        if found.is_some() {
            found_harnesses.push(harness);
        }
        checks.push(harness_check(harness, found.as_deref()));
    }
    checks.push(harness_aggregate_check(&found_harnesses));

    let root = state_root(env);
    checks.push(state_check(&root, &project_id));

    let state_dir = root.as_ref().ok().map(|root| {
        project_state_dir(root, &project_id)
            .to_string_lossy()
            .to_string()
    });

    DoctorReport::new(
        ProjectInfo {
            path: canonical.to_string_lossy().to_string(),
            framework: framework.is_ok().then(|| "flutter".to_string()),
            project_id: Some(project_id),
            state_dir,
        },
        checks,
    )
}

fn directory_check(canonical: &Path, error: Option<&std::io::Error>, is_directory: bool) -> Check {
    let display = canonical.display();
    match (error, is_directory) {
        (None, true) => Check::new(
            "project.directory",
            CheckStatus::Pass,
            format!("project directory resolved: {display}"),
        ),
        (None, false) => Check::new(
            "project.directory",
            CheckStatus::Fail,
            format!("project path is not a directory: {display}"),
        )
        .with_remediation("point --project-dir at a Flutter project directory"),
        (Some(error), _) => Check::new(
            "project.directory",
            CheckStatus::Fail,
            format!("project directory not found: {display}"),
        )
        .with_detail(error.to_string())
        .with_remediation("point --project-dir at an existing Flutter project directory"),
    }
}

fn framework_check(canonical: &Path, framework: &Result<(), FrameworkError>) -> Check {
    match framework {
        Ok(()) => Check::new(
            "project.framework",
            CheckStatus::Pass,
            "Flutter project detected (pubspec.yaml declares the Flutter SDK)",
        ),
        Err(error) => Check::new(
            "project.framework",
            CheckStatus::Fail,
            "no Flutter project detected",
        )
        .with_detail(format!(
            "{}: {error}",
            canonical.join("pubspec.yaml").display()
        ))
        .with_remediation(
            "run this against a Flutter app whose pubspec.yaml has \
             dependencies.flutter.sdk: flutter",
        ),
    }
}

fn required_tool_check(env: &Environment, tool: &str) -> Check {
    match crate::tools::find_on_path(env, tool) {
        Some(path) => Check::new(
            &format!("tool.{tool}"),
            CheckStatus::Pass,
            format!("{tool} found on PATH"),
        )
        .with_detail(path.to_string_lossy().to_string()),
        None => Check::new(
            &format!("tool.{tool}"),
            CheckStatus::Fail,
            format!("{tool} not found on PATH"),
        )
        .with_remediation("install the Flutter SDK and put its bin directory on PATH"),
    }
}

fn harness_check(harness: &str, found: Option<&Path>) -> Check {
    match found {
        Some(path) => Check::new(
            &format!("harness.{harness}"),
            CheckStatus::Pass,
            format!("{harness} found on PATH"),
        )
        .with_detail(path.to_string_lossy().to_string()),
        None => Check::new(
            &format!("harness.{harness}"),
            CheckStatus::Warning,
            format!("{harness} not found on PATH"),
        )
        .with_remediation(format!("install {harness} to use it as an agent harness")),
    }
}

fn harness_aggregate_check(found: &[&str]) -> Check {
    if found.is_empty() {
        Check::new(
            "harness.available",
            CheckStatus::Fail,
            "no supported agent harness found on PATH",
        )
        .with_detail(format!("looked for: {}", HARNESSES.join(", ")))
        .with_remediation("install at least one of claude, codex, or pi")
    } else {
        Check::new(
            "harness.available",
            CheckStatus::Pass,
            format!("{} agent harness(es) available", found.len()),
        )
        .with_detail(found.join(", "))
    }
}

fn state_check(root: &Result<std::path::PathBuf, StateError>, project_id: &str) -> Check {
    match root {
        Ok(root) => Check::new(
            "storage.state",
            CheckStatus::Pass,
            format!(
                "project state directory resolved: {}",
                project_state_dir(root, project_id).display()
            ),
        )
        .with_detail("not created; doctor never writes"),
        Err(error @ StateError::RelativeOverride(_)) => Check::new(
            "storage.state",
            CheckStatus::Fail,
            "project state directory could not be resolved",
        )
        .with_detail(error.to_string())
        .with_remediation(format!(
            "set {HOME_ENV_VAR} to an absolute path, or unset it"
        )),
        Err(error @ StateError::NoHomeDirectory) => Check::new(
            "storage.state",
            CheckStatus::Fail,
            "project state directory could not be resolved",
        )
        .with_detail(error.to_string())
        .with_remediation(format!("set {HOME_ENV_VAR} to an absolute path")),
    }
}
