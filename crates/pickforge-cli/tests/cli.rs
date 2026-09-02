//! Just enough end-to-end coverage to pin output rendering and exit mapping.

use std::path::{Path, PathBuf};

use assert_cmd::Command;
use tempfile::TempDir;

const FLUTTER_PUBSPEC: &str = "name: demo_app\ndependencies:\n  flutter:\n    sdk: flutter\n";

fn fake_bin(root: &Path, tools: &[&str]) -> PathBuf {
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    for tool in tools {
        #[cfg(windows)]
        {
            let path = bin.join(format!("{tool}.EXE"));
            std::fs::copy(std::env::current_exe().unwrap(), path).unwrap();
        }
        #[cfg(not(windows))]
        {
            let path = bin.join(tool);
            std::fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
    }
    bin
}

/// A `pickforge` invocation with an isolated PATH and state root, so the test
/// never sees the developer's tools or home directory.
fn pickforge(root: &Path, tools: &[&str]) -> Command {
    let mut command = Command::cargo_bin("pickforge").unwrap();
    command
        .env_clear()
        .env("PATH", fake_bin(root, tools))
        .env("PICKFORGE_HOME", root.join("state"));
    #[cfg(windows)]
    command.env("PATHEXT", ".EXE");
    command
}

fn flutter_project(root: &Path) -> PathBuf {
    let project_dir = root.join("app");
    std::fs::create_dir_all(&project_dir).unwrap();
    std::fs::write(project_dir.join("pubspec.yaml"), FLUTTER_PUBSPEC).unwrap();
    project_dir
}

#[test]
fn a_ready_project_prints_a_text_report_and_exits_zero() {
    let temp = TempDir::new().unwrap();
    let project_dir = flutter_project(temp.path());

    let output = pickforge(temp.path(), &["flutter", "dart", "claude"])
        .args(["doctor", "--project-dir"])
        .arg(&project_dir)
        .assert()
        .success();

    let stdout = String::from_utf8(output.get_output().stdout.clone()).unwrap();
    assert!(stdout.contains("framework: flutter"), "{stdout}");
    assert!(stdout.contains("state dir: "), "{stdout}");
    assert!(stdout.contains("[PASS] tool.flutter"), "{stdout}");
    assert!(stdout.contains("[WARN] harness.codex"), "{stdout}");
    assert!(stdout.trim_end().ends_with("ready: yes"), "{stdout}");
    assert!(!stdout.contains('\u{1b}'), "output must be color-free");
    assert!(!temp.path().join("state").exists());
}

#[test]
fn a_project_with_no_toolchain_exits_one_and_reports_not_ready() {
    let temp = TempDir::new().unwrap();
    let project_dir = flutter_project(temp.path());

    let output = pickforge(temp.path(), &[])
        .args(["doctor", "--project-dir"])
        .arg(&project_dir)
        .assert()
        .code(1);

    let stdout = String::from_utf8(output.get_output().stdout.clone()).unwrap();
    assert!(stdout.trim_end().ends_with("ready: no"), "{stdout}");
}

#[test]
fn json_output_is_parseable_and_uses_the_documented_field_casing() {
    let temp = TempDir::new().unwrap();
    let project_dir = flutter_project(temp.path());

    let output = pickforge(temp.path(), &["flutter", "dart", "pi"])
        .args(["doctor", "--json", "--project-dir"])
        .arg(&project_dir)
        .assert()
        .success();

    let value: serde_json::Value = serde_json::from_slice(&output.get_output().stdout).unwrap();
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["ready"], true);
    assert_eq!(value["project"]["framework"], "flutter");
    assert_eq!(value["checks"][0]["id"], "project.directory");
}

#[test]
fn a_missing_project_directory_exits_one_without_panicking() {
    let temp = TempDir::new().unwrap();

    let output = pickforge(temp.path(), &["flutter", "dart", "claude"])
        .args(["doctor", "--json", "--project-dir"])
        .arg(temp.path().join("nope"))
        .assert()
        .code(1);

    let value: serde_json::Value = serde_json::from_slice(&output.get_output().stdout).unwrap();
    assert_eq!(value["ready"], false);
    assert_eq!(value["checks"][0]["status"], "fail");
    let stderr = String::from_utf8(output.get_output().stderr.clone()).unwrap();
    assert!(!stderr.contains("panicked"), "{stderr}");
}

#[test]
fn the_current_directory_is_the_default_project() {
    let temp = TempDir::new().unwrap();
    let project_dir = flutter_project(temp.path());

    pickforge(temp.path(), &["flutter", "dart", "claude"])
        .current_dir(&project_dir)
        .arg("doctor")
        .assert()
        .success();
}
