//! Just enough end-to-end coverage to pin output rendering and exit mapping.

use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;

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
        .env("HOME", root.join("home"))
        .env("USERPROFILE", root.join("home"))
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

fn git(project: &Path, args: &[&str]) -> Vec<u8> {
    let output = ProcessCommand::new("git")
        .args(args)
        .current_dir(project)
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?} failed: {output:?}");
    output.stdout
}

fn snapshot_without_git(root: &Path) -> Vec<(PathBuf, Option<Vec<u8>>)> {
    fn visit(root: &Path, path: &Path, entries: &mut Vec<(PathBuf, Option<Vec<u8>>)>) {
        let mut children = std::fs::read_dir(path)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        children.sort();
        for child in children {
            if child.file_name().is_some_and(|name| name == ".git") {
                continue;
            }
            let relative = child.strip_prefix(root).unwrap().to_path_buf();
            if child.is_dir() {
                entries.push((relative, None));
                visit(root, &child, entries);
            } else {
                entries.push((relative, Some(std::fs::read(&child).unwrap())));
            }
        }
    }

    let mut entries = Vec::new();
    visit(root, root, &mut entries);
    entries
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

#[test]
fn init_dry_run_preserves_clean_and_dirty_git_trees_byte_for_byte() {
    for dirty in [false, true] {
        let temp = TempDir::new().unwrap();
        let project_dir = flutter_project(temp.path());
        git(&project_dir, &["init", "--quiet"]);
        git(&project_dir, &["add", "pubspec.yaml"]);
        git(
            &project_dir,
            &[
                "-c",
                "user.name=Pickforge Test",
                "-c",
                "user.email=test@invalid.example",
                "commit",
                "--quiet",
                "-m",
                "fixture",
            ],
        );
        if dirty {
            std::fs::write(project_dir.join("dirty.txt"), "user work\n").unwrap();
        }
        let mut command = pickforge(temp.path(), &[]);
        let status_before = git(&project_dir, &["status", "--porcelain=v1"]);
        let tree_before = snapshot_without_git(temp.path());
        let output = command
            .args(["init", "--dry-run", "--json", "--project-dir"])
            .arg(&project_dir)
            .assert()
            .success();
        let value: serde_json::Value = serde_json::from_slice(&output.get_output().stdout).unwrap();
        assert_eq!(value["plan"]["schemaVersion"], 1);
        assert!(value.get("outcome").is_none());
        assert_eq!(
            git(&project_dir, &["status", "--porcelain=v1"]),
            status_before
        );
        assert_eq!(snapshot_without_git(temp.path()), tree_before);
        assert!(!temp.path().join("state").exists());
    }
}

#[test]
fn init_apply_and_noop_use_success_exit_codes_and_leave_dirty_project_untouched() {
    let temp = TempDir::new().unwrap();
    let project_dir = flutter_project(temp.path());
    git(&project_dir, &["init", "--quiet"]);
    git(&project_dir, &["add", "pubspec.yaml"]);
    git(
        &project_dir,
        &[
            "-c",
            "user.name=Pickforge Test",
            "-c",
            "user.email=test@invalid.example",
            "commit",
            "--quiet",
            "-m",
            "fixture",
        ],
    );
    std::fs::write(project_dir.join("dirty.txt"), "user work\n").unwrap();
    let status_before = git(&project_dir, &["status", "--porcelain=v1"]);
    let tree_before = snapshot_without_git(&project_dir);
    for _ in 0..2 {
        pickforge(temp.path(), &[])
            .args(["init", "--project-dir"])
            .arg(&project_dir)
            .assert()
            .success();
    }
    assert_eq!(
        git(&project_dir, &["status", "--porcelain=v1"]),
        status_before
    );
    assert_eq!(snapshot_without_git(&project_dir), tree_before);
}

#[test]
fn init_success_and_noop_output_contracts_are_stable() {
    let temp = TempDir::new().unwrap();
    let project_dir = flutter_project(temp.path());
    let first = pickforge(temp.path(), &[])
        .args(["init", "--json", "--project-dir"])
        .arg(&project_dir)
        .assert()
        .success();
    let first: serde_json::Value = serde_json::from_slice(&first.get_output().stdout).unwrap();
    assert_eq!(first["plan"]["schemaVersion"], 1);
    assert_eq!(first["plan"]["actions"][0]["action"], "create");
    assert_eq!(first["outcome"]["outcome"], "success");
    assert_eq!(first["outcome"]["changed"], true);

    let second = pickforge(temp.path(), &[])
        .args(["init", "--project-dir"])
        .arg(&project_dir)
        .assert()
        .success();
    let stdout = String::from_utf8(second.get_output().stdout.clone()).unwrap();
    assert!(stdout.contains("[UNCHANGED]"), "{stdout}");
    assert!(stdout.contains("outcome: no-op"), "{stdout}");
    assert!(stdout.contains("changed: no"), "{stdout}");
}

#[cfg(unix)]
#[test]
fn init_human_output_escapes_path_control_characters() {
    let temp = TempDir::new().unwrap();
    let project_dir = flutter_project(temp.path());
    let unsafe_state = temp.path().join("state\nunsafe");
    let output = pickforge(temp.path(), &[])
        .env("PICKFORGE_HOME", &unsafe_state)
        .args(["init", "--dry-run", "--project-dir"])
        .arg(&project_dir)
        .assert()
        .success();
    let stdout = String::from_utf8(output.get_output().stdout.clone()).unwrap();
    assert!(stdout.contains("state\\nunsafe"), "{stdout:?}");
    assert!(!stdout.contains(&unsafe_state.to_string_lossy().into_owned()));
}

#[test]
fn mobile_alpha_flag_is_hidden_and_missing_dart_fails_without_writing() {
    let temp = TempDir::new().unwrap();
    let project_dir = flutter_project(temp.path());
    let help = pickforge(temp.path(), &[])
        .args(["init", "--help"])
        .assert()
        .success();
    assert!(
        !String::from_utf8_lossy(&help.get_output().stdout).contains("mobile-integration-alpha")
    );

    let missing = pickforge(temp.path(), &[])
        .args(["init", "--mobile-integration-alpha", "--project-dir"])
        .arg(&project_dir)
        .assert()
        .code(1);
    assert!(String::from_utf8_lossy(&missing.get_output().stdout).contains("requires dart on PATH"));
    assert!(!temp.path().join("state").exists());
    assert!(!temp.path().join("home").exists());
}

#[cfg(unix)]
#[test]
fn mobile_alpha_never_executes_dart_and_keeps_the_project_clean() {
    let temp = TempDir::new().unwrap();
    let project_dir = flutter_project(temp.path());
    git(&project_dir, &["init", "--quiet"]);
    git(&project_dir, &["add", "pubspec.yaml"]);
    git(
        &project_dir,
        &[
            "-c",
            "user.name=Pickforge Test",
            "-c",
            "user.email=test@invalid.example",
            "commit",
            "--quiet",
            "-m",
            "fixture",
        ],
    );
    let status_before = git(&project_dir, &["status", "--porcelain=v1"]);
    let tree_before = snapshot_without_git(&project_dir);
    let marker = temp.path().join("dart-ran");
    let bin = fake_bin(temp.path(), &["dart"]);
    let dart = bin.join("dart");
    std::fs::write(&dart, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();

    let output = pickforge(temp.path(), &[])
        .env("PATH", bin)
        .args([
            "init",
            "--mobile-integration-alpha",
            "--harness",
            "codex",
            "--json",
            "--project-dir",
        ])
        .arg(&project_dir)
        .assert()
        .success();
    assert!(!marker.exists());
    let value: serde_json::Value = serde_json::from_slice(&output.get_output().stdout).unwrap();
    assert_eq!(value["plan"]["pack"]["name"], "pickforge-flutter");
    assert_eq!(value["plan"]["harnesses"], serde_json::json!(["codex"]));
    assert_eq!(value["plan"]["actions"].as_array().unwrap().len(), 3);
    assert!(temp.path().join("home/.codex/config.toml").is_file());
    assert!(temp
        .path()
        .join("home/.agents/skills/pickforge-flutter/SKILL.md")
        .is_file());
    assert!(!temp.path().join("home/.claude.json").exists());
    assert!(!temp.path().join("home/.claude/skills").exists());
    assert!(!temp.path().join("home/.config/mcp/mcp.json").exists());
    assert_eq!(
        git(&project_dir, &["status", "--porcelain=v1"]),
        status_before
    );
    assert_eq!(snapshot_without_git(&project_dir), tree_before);
}

#[test]
fn init_precondition_failure_exits_one_without_writing() {
    let temp = TempDir::new().unwrap();
    pickforge(temp.path(), &[])
        .args(["init", "--json", "--project-dir"])
        .arg(temp.path().join("missing"))
        .assert()
        .code(1);
    let human = pickforge(temp.path(), &[])
        .args(["init", "--project-dir"])
        .arg(temp.path().join("mïssing\npath"))
        .assert()
        .code(1);
    let stdout = String::from_utf8(human.get_output().stdout.clone()).unwrap();
    assert!(stdout.contains("mïssing\\npath"), "{stdout:?}");
    assert!(!stdout.contains("\\u{ef}"), "{stdout:?}");
    assert!(!temp.path().join("state").exists());
}

#[test]
fn evidence_record_supports_stdin_path_human_json_and_errors() {
    let temp = TempDir::new().unwrap();
    let project_dir = flutter_project(temp.path());
    git(&project_dir, &["init", "--quiet"]);
    git(&project_dir, &["add", "pubspec.yaml"]);
    git(
        &project_dir,
        &[
            "-c",
            "user.name=Pickforge Test",
            "-c",
            "user.email=test@invalid.example",
            "commit",
            "--quiet",
            "-m",
            "fixture",
        ],
    );
    let status_before = git(&project_dir, &["status", "--porcelain=v1"]);
    let project_before = snapshot_without_git(&project_dir);
    let input = serde_json::json!({"schemaVersion":1,"scenario":"Smoke","outcome":"passed","before":{"summary":"Before","observations":[],"artifacts":[]},"after":{"summary":"After","observations":[],"artifacts":[]},"sourceChanges":[],"checks":[],"limitations":[]}).to_string();
    let missing_receipt = pickforge(temp.path(), &[])
        .args(["evidence", "record", "--project-dir"])
        .arg(&project_dir)
        .write_stdin(input.as_bytes())
        .assert()
        .code(1);
    let stderr = String::from_utf8_lossy(&missing_receipt.get_output().stderr);
    let expected_receipt = std::fs::canonicalize(temp.path())
        .unwrap()
        .join("state/projects");
    assert!(
        stderr.contains(&expected_receipt.to_string_lossy().into_owned())
            && stderr.contains("project.json"),
        "{stderr}"
    );
    assert!(
        stderr.contains("pickforge init --mobile-integration-alpha"),
        "{stderr}"
    );

    pickforge(temp.path(), &["dart"])
        .args([
            "init",
            "--mobile-integration-alpha",
            "--harness",
            "codex",
            "--project-dir",
        ])
        .arg(&project_dir)
        .assert()
        .success();
    let missing_input = temp.path().join("missing-input.json");
    let input_error = pickforge(temp.path(), &[])
        .args(["evidence", "record", "--input"])
        .arg(&missing_input)
        .arg("--project-dir")
        .arg(&project_dir)
        .assert()
        .code(1);
    let stderr = String::from_utf8_lossy(&input_error.get_output().stderr);
    assert!(
        stderr.contains(&missing_input.to_string_lossy().into_owned()),
        "{stderr}"
    );
    assert!(stderr.contains("verify or fix `--input`"), "{stderr}");
    assert!(!stderr.contains("pickforge init"), "{stderr}");

    let human = pickforge(temp.path(), &[])
        .args(["evidence", "record", "--project-dir"])
        .arg(&project_dir)
        .write_stdin(input.as_bytes())
        .assert()
        .success();
    let stdout = String::from_utf8_lossy(&human.get_output().stdout);
    assert!(stdout.contains("recorded Flutter evidence run"), "{stdout}");
    assert!(
        stdout.contains("evidence:") && stdout.contains("report:"),
        "{stdout}"
    );

    let input_path = temp.path().join("input.json");
    std::fs::write(&input_path, input).unwrap();
    let json = pickforge(temp.path(), &[])
        .args(["evidence", "record", "--json", "--input"])
        .arg(&input_path)
        .arg("--project-dir")
        .arg(&project_dir)
        .assert()
        .success();
    let value: serde_json::Value = serde_json::from_slice(&json.get_output().stdout).unwrap();
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["changed"], true);
    assert!(value["evidencePath"]
        .as_str()
        .unwrap()
        .ends_with("evidence.json"));

    let error = pickforge(temp.path(), &[])
        .args(["evidence", "record", "--json", "--project-dir"])
        .arg(&project_dir)
        .write_stdin("{}")
        .assert()
        .code(1);
    let value: serde_json::Value = serde_json::from_slice(&error.get_output().stdout).unwrap();
    assert_eq!(value["schemaVersion"], 1);
    assert!(value["error"]
        .as_str()
        .unwrap()
        .contains("invalid evidence input"));
    assert_eq!(
        git(&project_dir, &["status", "--porcelain=v1"]),
        status_before
    );
    assert_eq!(snapshot_without_git(&project_dir), project_before);
}
