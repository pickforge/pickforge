//! Library-level coverage of `pickforge doctor` through its public interface.

use std::path::{Path, PathBuf};

use pickforge_cli::report::CheckStatus;
use pickforge_cli::{diagnose, project, state, DoctorReport, Environment};
use tempfile::TempDir;

const FLUTTER_PUBSPEC: &str = "name: demo_app\ndependencies:\n  flutter:\n    sdk: flutter\n";

fn write_project(dir: &Path, pubspec: Option<&str>) {
    std::fs::create_dir_all(dir).unwrap();
    if let Some(pubspec) = pubspec {
        std::fs::write(dir.join("pubspec.yaml"), pubspec).unwrap();
    }
}

/// A PATH directory holding fake executables, so tests never depend on the
/// developer's real toolchain.
fn fake_bin(root: &Path, tools: &[&str]) -> PathBuf {
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    for tool in tools {
        let path = bin.join(tool);
        std::fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
    bin
}

fn env_with(root: &Path, tools: &[&str]) -> Environment {
    let home = root.join("home");
    std::fs::create_dir_all(&home).unwrap();
    Environment::empty()
        .with_var("PATH", fake_bin(root, tools))
        .with_home_dir(home)
}

fn all_tools() -> Vec<&'static str> {
    vec!["flutter", "dart", "claude", "codex", "pi"]
}

fn check<'a>(report: &'a DoctorReport, id: &str) -> &'a pickforge_cli::Check {
    report
        .checks
        .iter()
        .find(|check| check.id == id)
        .unwrap_or_else(|| panic!("missing check {id}"))
}

#[test]
fn valid_flutter_project_with_full_toolchain_is_ready() {
    let temp = TempDir::new().unwrap();
    let project_dir = temp.path().join("app");
    write_project(&project_dir, Some(FLUTTER_PUBSPEC));

    let report = diagnose(&project_dir, &env_with(temp.path(), &all_tools()));

    assert!(report.ready, "{report:?}");
    assert_eq!(report.schema_version, 1);
    assert_eq!(report.project.framework.as_deref(), Some("flutter"));
    assert_eq!(
        check(&report, "project.framework").status,
        CheckStatus::Pass
    );
    assert!(report
        .checks
        .iter()
        .all(|check| check.status != CheckStatus::Fail));
}

#[test]
fn check_order_is_stable() {
    let temp = TempDir::new().unwrap();
    let project_dir = temp.path().join("app");
    write_project(&project_dir, Some(FLUTTER_PUBSPEC));

    let report = diagnose(&project_dir, &env_with(temp.path(), &all_tools()));

    let ids: Vec<&str> = report
        .checks
        .iter()
        .map(|check| check.id.as_str())
        .collect();
    assert_eq!(
        ids,
        vec![
            "project.directory",
            "project.framework",
            "tool.flutter",
            "tool.dart",
            "harness.claude",
            "harness.codex",
            "harness.pi",
            "harness.available",
            "storage.state",
        ]
    );
}

#[test]
fn non_flutter_pubspec_fails_the_framework_check() {
    let temp = TempDir::new().unwrap();
    let project_dir = temp.path().join("app");
    write_project(
        &project_dir,
        Some("name: plain_dart\ndependencies:\n  http: ^1.0.0\n"),
    );

    let report = diagnose(&project_dir, &env_with(temp.path(), &all_tools()));

    assert!(!report.ready);
    assert_eq!(report.project.framework, None);
    let framework = check(&report, "project.framework");
    assert_eq!(framework.status, CheckStatus::Fail);
    assert!(framework.remediation.is_some());
}

#[test]
fn a_flutter_named_dependency_without_the_sdk_entry_is_not_flutter() {
    let temp = TempDir::new().unwrap();
    let project_dir = temp.path().join("app");
    write_project(
        &project_dir,
        Some("name: tricky\ndependencies:\n  flutter: ^1.0.0\n"),
    );

    let report = diagnose(&project_dir, &env_with(temp.path(), &all_tools()));

    assert_eq!(
        check(&report, "project.framework").status,
        CheckStatus::Fail
    );
}

#[test]
fn malformed_yaml_fails_cleanly() {
    let temp = TempDir::new().unwrap();
    let project_dir = temp.path().join("app");
    write_project(
        &project_dir,
        Some("name: demo\n  : ][ bad\n\tdependencies\n"),
    );

    let report = diagnose(&project_dir, &env_with(temp.path(), &all_tools()));

    let framework = check(&report, "project.framework");
    assert_eq!(framework.status, CheckStatus::Fail);
    assert!(framework.detail.is_some());
}

#[test]
fn missing_project_directory_fails_without_panicking() {
    let temp = TempDir::new().unwrap();
    let project_dir = temp.path().join("nope");

    let report = diagnose(&project_dir, &env_with(temp.path(), &all_tools()));

    assert!(!report.ready);
    assert_eq!(
        check(&report, "project.directory").status,
        CheckStatus::Fail
    );
    assert_eq!(
        check(&report, "project.framework").status,
        CheckStatus::Fail
    );
}

#[test]
fn a_file_passed_as_the_project_fails_the_directory_check() {
    let temp = TempDir::new().unwrap();
    let file = temp.path().join("pubspec.yaml");
    std::fs::write(&file, FLUTTER_PUBSPEC).unwrap();

    let report = diagnose(&file, &env_with(temp.path(), &all_tools()));

    assert!(!report.ready);
    let directory = check(&report, "project.directory");
    assert_eq!(directory.status, CheckStatus::Fail);
    assert!(directory.summary.contains("not a directory"));
}

#[test]
fn missing_path_fails_the_required_tools_and_harness_checks() {
    let temp = TempDir::new().unwrap();
    let project_dir = temp.path().join("app");
    write_project(&project_dir, Some(FLUTTER_PUBSPEC));
    let home = temp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();

    let report = diagnose(&project_dir, &Environment::empty().with_home_dir(home));

    assert!(!report.ready);
    assert_eq!(check(&report, "tool.flutter").status, CheckStatus::Fail);
    assert_eq!(check(&report, "tool.dart").status, CheckStatus::Fail);
    assert_eq!(
        check(&report, "harness.available").status,
        CheckStatus::Fail
    );
}

#[test]
fn empty_path_finds_nothing() {
    let temp = TempDir::new().unwrap();
    let project_dir = temp.path().join("app");
    write_project(&project_dir, Some(FLUTTER_PUBSPEC));
    let home = temp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();

    let report = diagnose(
        &project_dir,
        &Environment::empty()
            .with_var("PATH", "")
            .with_home_dir(home),
    );

    assert_eq!(check(&report, "tool.flutter").status, CheckStatus::Fail);
}

#[test]
fn a_single_harness_keeps_the_aggregate_passing_and_warns_on_the_others() {
    let temp = TempDir::new().unwrap();
    let project_dir = temp.path().join("app");
    write_project(&project_dir, Some(FLUTTER_PUBSPEC));

    let report = diagnose(
        &project_dir,
        &env_with(temp.path(), &["flutter", "dart", "codex"]),
    );

    assert!(report.ready);
    assert_eq!(check(&report, "harness.codex").status, CheckStatus::Pass);
    assert_eq!(
        check(&report, "harness.claude").status,
        CheckStatus::Warning
    );
    assert_eq!(check(&report, "harness.pi").status, CheckStatus::Warning);
    assert_eq!(
        check(&report, "harness.available").status,
        CheckStatus::Pass
    );
}

#[test]
fn no_harness_fails_the_aggregate_check() {
    let temp = TempDir::new().unwrap();
    let project_dir = temp.path().join("app");
    write_project(&project_dir, Some(FLUTTER_PUBSPEC));

    let report = diagnose(&project_dir, &env_with(temp.path(), &["flutter", "dart"]));

    assert!(!report.ready);
    assert_eq!(
        check(&report, "harness.available").status,
        CheckStatus::Fail
    );
}

#[test]
fn absolute_pickforge_home_overrides_the_default_root() {
    let temp = TempDir::new().unwrap();
    let project_dir = temp.path().join("app");
    write_project(&project_dir, Some(FLUTTER_PUBSPEC));
    let override_root = temp.path().join("custom-home");

    let report = diagnose(
        &project_dir,
        &env_with(temp.path(), &all_tools()).with_var("PICKFORGE_HOME", &override_root),
    );

    assert!(report.ready);
    let expected = override_root
        .join("projects")
        .join(report.project.project_id.clone().unwrap());
    assert_eq!(
        report.project.state_dir.as_deref(),
        Some(expected.to_string_lossy().as_ref())
    );
}

#[test]
fn relative_pickforge_home_fails_the_storage_check() {
    let temp = TempDir::new().unwrap();
    let project_dir = temp.path().join("app");
    write_project(&project_dir, Some(FLUTTER_PUBSPEC));

    let report = diagnose(
        &project_dir,
        &env_with(temp.path(), &all_tools()).with_var("PICKFORGE_HOME", "relative/home"),
    );

    assert!(!report.ready);
    let storage = check(&report, "storage.state");
    assert_eq!(storage.status, CheckStatus::Fail);
    assert_eq!(report.project.state_dir, None);
}

#[test]
fn empty_pickforge_home_behaves_as_unset() {
    let temp = TempDir::new().unwrap();
    let project_dir = temp.path().join("app");
    write_project(&project_dir, Some(FLUTTER_PUBSPEC));

    let report = diagnose(
        &project_dir,
        &env_with(temp.path(), &all_tools()).with_var("PICKFORGE_HOME", ""),
    );

    assert!(report.ready);
    let expected = temp
        .path()
        .join("home")
        .join(".pickforge")
        .join("pickforge")
        .join("projects")
        .join(report.project.project_id.clone().unwrap());
    assert_eq!(
        report.project.state_dir.as_deref(),
        Some(expected.to_string_lossy().as_ref())
    );
}

#[test]
fn a_missing_home_without_an_override_fails_cleanly() {
    let temp = TempDir::new().unwrap();
    let project_dir = temp.path().join("app");
    write_project(&project_dir, Some(FLUTTER_PUBSPEC));

    let report = diagnose(
        &project_dir,
        &Environment::empty().with_var("PATH", fake_bin(temp.path(), &all_tools())),
    );

    assert!(!report.ready);
    assert_eq!(check(&report, "storage.state").status, CheckStatus::Fail);
    assert_eq!(report.project.state_dir, None);
}

#[test]
fn doctor_never_creates_the_state_directories() {
    let temp = TempDir::new().unwrap();
    let project_dir = temp.path().join("app");
    write_project(&project_dir, Some(FLUTTER_PUBSPEC));
    let override_root = temp.path().join("custom-home");

    let report = diagnose(
        &project_dir,
        &env_with(temp.path(), &all_tools()).with_var("PICKFORGE_HOME", &override_root),
    );

    assert!(!override_root.exists());
    assert!(!Path::new(report.project.state_dir.as_deref().unwrap()).exists());
    assert!(!temp.path().join("home").join(".pickforge").exists());
    // The project itself is untouched beyond the pubspec the test wrote.
    let entries: Vec<String> = std::fs::read_dir(&project_dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(entries, vec!["pubspec.yaml".to_string()]);
}

#[test]
fn project_id_matches_the_picklab_algorithm() {
    // Cross-checked against PickLab's TypeScript `deriveProjectId`.
    assert_eq!(
        project::derive_project_id(Path::new("/tmp/My App")),
        "my-app-a2b5d505f3ca90ae"
    );
}

#[test]
fn long_and_unslugabble_basenames_stay_within_the_id_contract() {
    let long = format!("/tmp/{}", "a".repeat(80));
    let id = project::derive_project_id(Path::new(&long));
    let (slug, hash) = id.rsplit_once('-').unwrap();
    assert_eq!(slug.len(), 40);
    assert_eq!(hash.len(), 16);

    let fallback = project::derive_project_id(Path::new("/tmp/___"));
    assert!(fallback.starts_with("project-"), "{fallback}");
}

#[cfg(unix)]
#[test]
fn a_symlinked_project_path_derives_the_same_id() {
    let temp = TempDir::new().unwrap();
    let project_dir = temp.path().join("app");
    write_project(&project_dir, Some(FLUTTER_PUBSPEC));
    let link = temp.path().join("link");
    std::os::unix::fs::symlink(&project_dir, &link).unwrap();

    let env = env_with(temp.path(), &all_tools());
    let direct = diagnose(&project_dir, &env);
    let through_link = diagnose(&link, &env);

    assert_eq!(direct.project.project_id, through_link.project.project_id);
    assert_eq!(direct.project.path, through_link.project.path);
}

#[test]
fn state_root_defaults_under_the_pickforge_company_root() {
    let env = Environment::empty().with_home_dir("/home/someone");
    assert_eq!(
        state::state_root(&env).unwrap(),
        Path::new("/home/someone/.pickforge/pickforge")
    );
}

#[test]
fn json_shape_uses_the_documented_casing_and_omits_absent_optionals() {
    let temp = TempDir::new().unwrap();
    let project_dir = temp.path().join("app");
    write_project(&project_dir, Some(FLUTTER_PUBSPEC));

    let report = diagnose(&project_dir, &env_with(temp.path(), &all_tools()));
    let value: serde_json::Value =
        serde_json::from_str(&pickforge_cli::render::render_json(&report)).unwrap();

    let object = value.as_object().unwrap();
    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, vec!["checks", "project", "ready", "schemaVersion"]);
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["ready"], true);
    assert_eq!(value["project"]["framework"], "flutter");
    assert!(value["project"]["projectId"].is_string());
    assert!(value["project"]["stateDir"].is_string());
    assert_eq!(value["checks"][0]["id"], "project.directory");
    assert_eq!(value["checks"][0]["status"], "pass");
    // A passing directory check carries no remediation.
    assert!(value["checks"][0].get("remediation").is_none());
    assert!(value["checks"][0].get("detail").is_none());
}
