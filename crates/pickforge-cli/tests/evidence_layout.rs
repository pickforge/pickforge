//! `pickforge evidence record` writes run directories into the shared project
//! state directory, so it goes through the same layout claim as `pickforge
//! init` (#104 review): unknown versions, stray or linked markers, and foreign
//! entries in an unclaimed directory all fail closed before a run exists.

use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use pickforge_cli::adapters::{Harness, IntegrationPack};
use pickforge_cli::evidence::{record_at, EVIDENCE_SCHEMA_VERSION};
use pickforge_cli::{apply_init, plan_init, state, Environment, InitRequest};
use tempfile::TempDir;

const PUBSPEC: &str = "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n";
const RECORDED_AT: Duration = Duration::from_secs(1_704_067_200);

/// An initialized Flutter project: `evidence record` requires a valid receipt,
/// so every case here starts from one.
fn fixture() -> (TempDir, PathBuf, Environment, PathBuf) {
    let temp = TempDir::new().unwrap();
    let project = temp.path().join("app");
    std::fs::create_dir(&project).unwrap();
    std::fs::write(project.join("pubspec.yaml"), PUBSPEC).unwrap();
    let bin = temp.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let dart = if cfg!(windows) {
        bin.join("dart.EXE")
    } else {
        bin.join("dart")
    };
    std::fs::write(&dart, "fixture").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dart, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let env = Environment::empty()
        .with_home_dir(temp.path().join("home"))
        .with_var("PICKFORGE_HOME", temp.path().join("state"))
        .with_var("PATH", &bin)
        .with_var("PATHEXT", ".EXE");
    let mut request = InitRequest::new(&project);
    request.pack = IntegrationPack::flutter();
    request.harnesses = vec![Harness::Codex];
    let plan = plan_init(&request, &env).unwrap();
    assert!(apply_init(&plan, "fixture").changed);
    let state_dir = PathBuf::from(plan.report.state_dir);
    (temp, project, env, state_dir)
}

fn envelope() -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "schemaVersion": EVIDENCE_SCHEMA_VERSION,
        "scenario": "Counter increments",
        "outcome": "passed",
        "before": {"summary": "Counter was zero."},
        "after": {"summary": "Counter is one."},
    }))
    .unwrap()
}

fn record(project: &Path, env: &Environment) -> Result<String, String> {
    record_at(project, env, &envelope(), UNIX_EPOCH + RECORDED_AT)
        .map(|result| result.run_id)
        .map_err(|error| error.to_string())
}

/// Entry names directly inside the project state directory.
fn entries(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn recording_refuses_an_unsupported_layout_version() {
    let (_temp, project, env, state_dir) = fixture();
    std::fs::write(
        state_dir.join("layout.json"),
        b"{\"layout\":\"pickforge-project-state\",\"layoutVersion\":99}\n",
    )
    .unwrap();

    let error = record(&project, &env).unwrap_err();
    assert!(error.contains("layout version 99"), "{error}");
    assert!(error.contains("Upgrade Pickforge"), "{error}");
    assert!(!state_dir.join("runs").exists());
}

#[test]
fn recording_refuses_a_stray_marker() {
    let (_temp, project, env, state_dir) = fixture();
    std::fs::write(state_dir.join("layout.json"), b"{\"layout\":\"other\"}\n").unwrap();

    let error = record(&project, &env).unwrap_err();
    assert!(
        error.contains("is not a Pickforge layout marker"),
        "{error}"
    );
    assert!(!state_dir.join("runs").exists());
}

#[cfg(unix)]
#[test]
fn recording_refuses_a_symlinked_marker() {
    let (_temp, project, env, state_dir) = fixture();
    let marker = state_dir.join("layout.json");
    let outside = state_dir.parent().unwrap().join("outside.json");
    std::fs::rename(&marker, &outside).unwrap();
    std::os::unix::fs::symlink(&outside, &marker).unwrap();

    let error = record(&project, &env).unwrap_err();
    assert!(error.contains("is a symbolic link"), "{error}");
    assert!(!state_dir.join("runs").exists());
    // The link and its target are the user's; nothing was written through it.
    assert_eq!(
        std::fs::read(&outside).unwrap(),
        state::layout_marker_bytes()
    );
}

/// An alpha.1/alpha.2 directory has a receipt and no marker. Recording adopts
/// it in place — the marker appears beside what is already there — and then
/// writes its run.
#[test]
fn recording_adopts_a_markerless_legacy_directory() {
    let (_temp, project, env, state_dir) = fixture();
    std::fs::remove_file(state_dir.join("layout.json")).unwrap();
    let receipt = std::fs::read(state_dir.join("project.json")).unwrap();

    let run_id = record(&project, &env).unwrap();

    assert_eq!(state::read_layout(&state_dir).unwrap(), Some(1));
    assert_eq!(
        std::fs::read(state_dir.join("project.json")).unwrap(),
        receipt
    );
    assert!(state_dir
        .join("runs")
        .join(run_id)
        .join("report.md")
        .is_file());
    assert_eq!(
        entries(&state_dir),
        vec!["layout.json", "project.json", "runs"]
    );
}

/// The direct-entry rule applies to recording's first adoption too, even
/// though a valid receipt is already there.
#[test]
fn recording_refuses_a_foreign_entry_before_a_first_adoption() {
    let (_temp, project, env, state_dir) = fixture();
    std::fs::remove_file(state_dir.join("layout.json")).unwrap();
    std::fs::write(state_dir.join("notes.txt"), b"not ours\n").unwrap();

    let error = record(&project, &env).unwrap_err();
    assert!(
        error.contains("notes.txt is not owned by Pickforge"),
        "{error}"
    );
    assert!(error.contains("mv -n --"), "{error}");
    assert!(!state_dir.join("runs").exists());
    assert!(!state_dir.join("layout.json").exists());
    assert!(state_dir.join("notes.txt").is_file());
}

/// The normal path: recording joins a claimed directory and leaves the marker
/// exactly as the claimer wrote it.
#[test]
fn recording_joins_a_claimed_directory_and_writes_one_run() {
    let (_temp, project, env, state_dir) = fixture();
    let marker = std::fs::read(state_dir.join("layout.json")).unwrap();

    let run_id = record(&project, &env).unwrap();

    assert_eq!(
        std::fs::read(state_dir.join("layout.json")).unwrap(),
        marker
    );
    assert_eq!(
        entries(&state_dir),
        vec!["layout.json", "project.json", "runs"]
    );
    assert_eq!(entries(&state_dir.join("runs")), vec![run_id]);
}

/// Recording must refuse a symlinked `projects/<id>` for the same reason the
/// lab does, on the logical path, before the canonicalisation that used to
/// resolve the link away (#104 R3).
#[cfg(unix)]
#[test]
fn recording_refuses_a_symlinked_project_state_directory() {
    let (_temp, project, env, state_dir) = fixture();
    let elsewhere = state_dir.parent().unwrap().join("elsewhere");
    std::fs::rename(&state_dir, &elsewhere).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &state_dir).unwrap();

    let error = record(&project, &env).unwrap_err();
    assert!(error.contains("is not a directory"), "{error}");
    assert!(error.contains("symbolic link"), "{error}");
    assert!(error.contains("mv -n --"), "{error}");
    // Nothing was written through the link: the moved directory still holds
    // exactly what init left there.
    assert_eq!(entries(&elsewhere), vec!["layout.json", "project.json"]);
    assert!(std::fs::symlink_metadata(&state_dir)
        .unwrap()
        .file_type()
        .is_symlink());
}

/// A FIFO planted as the marker blocked `evidence record` forever before the
/// marker open became non-blocking (#104 R1).
#[cfg(unix)]
#[test]
fn recording_refuses_a_fifo_marker_instead_of_blocking() {
    let (_temp, project, env, state_dir) = fixture();
    std::fs::remove_file(state_dir.join("layout.json")).unwrap();
    let marker = state_dir.join("layout.json");
    let name = std::ffi::CString::new(
        <std::ffi::OsString as std::os::unix::ffi::OsStringExt>::into_vec(marker.into_os_string()),
    )
    .unwrap();
    // SAFETY: `name` is a valid NUL-terminated path for the duration of the call.
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);

    let (sender, receiver) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let _ = sender.send(record(&project, &env));
    });
    let outcome = receiver
        .recv_timeout(Duration::from_secs(10))
        .expect("evidence record blocked on a FIFO marker");
    worker.join().unwrap();

    let error = outcome.unwrap_err();
    assert!(error.contains("is not a regular file"), "{error}");
    assert!(error.contains("named pipe"), "{error}");
    assert!(!state_dir.join("runs").exists());
}
