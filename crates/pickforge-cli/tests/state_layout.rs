//! Project-state ownership between the Rust integration CLI and the
//! TypeScript lab (#104): command order, legacy adoption, and concurrent
//! first use.
//!
//! The lab is not spawned here — these tests stand in for it by writing the
//! entries it owns (`runs/`). The real cross-tool proof is
//! `scripts/state-ownership-smoke.sh`, which runs both binaries.

use std::path::{Path, PathBuf};

use pickforge_cli::adapters::IntegrationPack;
use pickforge_cli::init::ApplyState;
use pickforge_cli::state::{self, Owner};
use pickforge_cli::{apply_init, plan_init, Environment, InitRequest};
use tempfile::TempDir;

const PUBSPEC: &str = "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n";

/// `pickforge init` defaults to the Flutter pack, which needs `dart` on PATH.
/// These tests are about state ownership, so they use the empty base pack.
fn receipt_only_request(project: &Path) -> InitRequest {
    let mut request = InitRequest::new(project);
    request.pack = IntegrationPack::base();
    request
}

fn fixture() -> (TempDir, PathBuf, Environment) {
    let temp = TempDir::new().unwrap();
    let project = temp.path().join("app");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(project.join("pubspec.yaml"), PUBSPEC).unwrap();
    let env = Environment::empty()
        .with_home_dir(temp.path().join("home"))
        .with_var("PICKFORGE_HOME", temp.path().join("state"));
    (temp, project, env)
}

/// Where the lab would put this project's runs, and one run inside it.
fn write_lab_run(state_dir: &Path, run_id: &str) {
    let run = state_dir.join("runs").join(run_id);
    std::fs::create_dir_all(&run).unwrap();
    std::fs::write(run.join("manifest.json"), b"{\"runId\":\"x\"}\n").unwrap();
}

fn state_dir_for(project: &Path, env: &Environment) -> PathBuf {
    let canonical = pickforge_cli::project::canonical_project_path(project);
    let id = pickforge_cli::project::derive_project_id(&canonical).unwrap();
    state::project_state_dir(&state::state_root(env).unwrap(), &id)
}

fn run_init(project: &Path, env: &Environment, stamp: &str) -> Result<ApplyState, String> {
    let plan = plan_init(&receipt_only_request(project), env).map_err(|e| e.to_string())?;
    let report = apply_init(&plan, stamp);
    match report.error {
        Some(error) => Err(error),
        None => Ok(report.outcome),
    }
}

// --- command order -------------------------------------------------------

/// The regression from #104: a lab run written before `pickforge init` made
/// init refuse the project outright.
#[test]
fn init_succeeds_after_the_lab_already_wrote_runs() {
    let (_temp, project, env) = fixture();
    let state_dir = state_dir_for(&project, &env);
    write_lab_run(&state_dir, "20260101-000000-first");

    assert_eq!(run_init(&project, &env, "1").unwrap(), ApplyState::Success);

    // The receipt is written and the lab's runs are still exactly where the
    // lab left them: no migration, no deletion.
    assert!(state_dir.join("project.json").is_file());
    assert!(state_dir
        .join("runs")
        .join("20260101-000000-first")
        .join("manifest.json")
        .is_file());
    assert_eq!(state::read_layout(&state_dir).unwrap(), Some(1));
}

/// The documented happy path stays a no-op on re-run once the lab has also
/// written runs, so neither order is a hidden prerequisite for the other.
#[test]
fn init_then_lab_then_init_again_is_a_no_op() {
    let (_temp, project, env) = fixture();
    let state_dir = state_dir_for(&project, &env);

    assert_eq!(run_init(&project, &env, "1").unwrap(), ApplyState::Success);
    write_lab_run(&state_dir, "20260101-000000-after");
    assert_eq!(run_init(&project, &env, "2").unwrap(), ApplyState::NoOp);

    assert!(state_dir
        .join("runs")
        .join("20260101-000000-after")
        .join("manifest.json")
        .is_file());
}

/// Both orders reach the same state directory contents for one project.
#[test]
fn both_orders_converge_on_the_same_ownership() {
    let (_first, project_a, env_a) = fixture();
    let (_second, project_b, env_b) = fixture();

    // init -> lab
    run_init(&project_a, &env_a, "1").unwrap();
    let dir_a = state_dir_for(&project_a, &env_a);
    write_lab_run(&dir_a, "20260101-000000-run");

    // lab -> init
    let dir_b = state_dir_for(&project_b, &env_b);
    write_lab_run(&dir_b, "20260101-000000-run");
    run_init(&project_b, &env_b, "1").unwrap();

    let names = |dir: &Path| {
        let mut entries: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        entries.sort();
        entries
    };
    assert_eq!(names(&dir_a), names(&dir_b));
    assert_eq!(names(&dir_a), vec!["layout.json", "project.json", "runs"]);
}

// --- legacy layouts ------------------------------------------------------

/// An alpha.1/alpha.2 directory has a receipt and no marker. It is adopted in
/// place: the marker appears, the receipt bytes are untouched.
#[test]
fn a_legacy_directory_is_adopted_without_rewriting_its_receipt() {
    let (_temp, project, env) = fixture();
    let state_dir = state_dir_for(&project, &env);

    run_init(&project, &env, "1").unwrap();
    let receipt = state_dir.join("project.json");
    let before = std::fs::read(&receipt).unwrap();

    // Roll the directory back to the pre-marker layout.
    std::fs::remove_file(state_dir.join("layout.json")).unwrap();
    write_lab_run(&state_dir, "20260101-000000-legacy");
    assert_eq!(state::read_layout(&state_dir).unwrap(), None);

    // Adoption is a real change (the marker is written), not a silent no-op.
    assert_eq!(run_init(&project, &env, "2").unwrap(), ApplyState::Success);
    assert_eq!(state::read_layout(&state_dir).unwrap(), Some(1));
    assert_eq!(std::fs::read(&receipt).unwrap(), before);
    assert!(state_dir
        .join("runs")
        .join("20260101-000000-legacy")
        .is_dir());
}

/// A legacy receipt backup is still recognised alongside lab runs.
#[test]
fn legacy_receipt_backups_coexist_with_lab_runs() {
    let (_temp, project, env) = fixture();
    let state_dir = state_dir_for(&project, &env);
    run_init(&project, &env, "1").unwrap();

    let receipt = state_dir.join("project.json");
    let bytes = std::fs::read(&receipt).unwrap();
    std::fs::write(state_dir.join("project.json.pickforge-backup-1"), &bytes).unwrap();
    std::fs::remove_file(&receipt).unwrap();
    std::fs::remove_file(state_dir.join("layout.json")).unwrap();
    write_lab_run(&state_dir, "20260101-000000-legacy");

    assert_eq!(run_init(&project, &env, "2").unwrap(), ApplyState::Success);
    assert!(state_dir.join("project.json.pickforge-backup-1").is_file());
}

// --- refusals with an exact manual action --------------------------------

#[test]
fn a_foreign_entry_is_refused_with_the_command_to_run() {
    let (_temp, project, env) = fixture();
    let state_dir = state_dir_for(&project, &env);
    std::fs::create_dir_all(&state_dir).unwrap();
    std::fs::write(state_dir.join("notes.txt"), b"not ours").unwrap();

    let error = plan_init(&receipt_only_request(&project), &env)
        .err()
        .unwrap()
        .to_string();
    assert!(
        error.contains("notes.txt is not owned by Pickforge"),
        "{error}"
    );
    assert!(error.contains("will not move or delete it"), "{error}");
    assert!(error.contains("mv "), "{error}");
    // Refusal leaves the directory exactly as it was.
    assert!(state_dir.join("notes.txt").is_file());
    assert!(!state_dir.join("project.json").exists());
}

#[test]
fn a_newer_layout_version_is_refused_with_an_upgrade_instruction() {
    let (_temp, project, env) = fixture();
    let state_dir = state_dir_for(&project, &env);
    std::fs::create_dir_all(&state_dir).unwrap();
    std::fs::write(
        state_dir.join("layout.json"),
        b"{\"layout\":\"pickforge-project-state\",\"layoutVersion\":99}\n",
    )
    .unwrap();

    let error = plan_init(&receipt_only_request(&project), &env)
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("layout version 99"), "{error}");
    assert!(error.contains("Upgrade Pickforge"), "{error}");
    assert!(!state_dir.join("project.json").exists());
}

#[test]
fn a_stray_layout_marker_is_refused_rather_than_adopted() {
    let (_temp, project, env) = fixture();
    let state_dir = state_dir_for(&project, &env);
    std::fs::create_dir_all(&state_dir).unwrap();
    std::fs::write(
        state_dir.join("layout.json"),
        b"{\"layout\":\"something-else\"}\n",
    )
    .unwrap();

    let error = plan_init(&receipt_only_request(&project), &env)
        .err()
        .unwrap()
        .to_string();
    assert!(
        error.contains("is not a Pickforge layout marker"),
        "{error}"
    );
}

// --- atomic first use ----------------------------------------------------

/// Concurrent first use must produce exactly one claim and one marker: no
/// thread may observe a partially owned directory.
#[test]
fn concurrent_claims_produce_exactly_one_winner() {
    let temp = TempDir::new().unwrap();
    let state_dir = temp.path().join("projects").join("app-0000");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(16));

    let winners: usize = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..16)
            .map(|_| {
                let dir = state_dir.clone();
                let barrier = std::sync::Arc::clone(&barrier);
                scope.spawn(move || {
                    barrier.wait();
                    state::claim_layout(&dir).unwrap()
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .filter(|claimed| *claimed)
            .count()
    });

    assert_eq!(winners, 1);
    assert_eq!(
        std::fs::read(state_dir.join("layout.json")).unwrap(),
        state::layout_marker_bytes()
    );
}

/// Claiming is idempotent and never rewrites an existing marker.
#[test]
fn claiming_an_already_claimed_directory_changes_nothing() {
    let temp = TempDir::new().unwrap();
    let state_dir = temp.path().join("projects").join("app-0000");

    assert!(state::claim_layout(&state_dir).unwrap());
    let marker = state_dir.join("layout.json");
    let mtime = std::fs::metadata(&marker).unwrap().modified().unwrap();

    assert!(!state::claim_layout(&state_dir).unwrap());
    assert_eq!(
        std::fs::metadata(&marker).unwrap().modified().unwrap(),
        mtime
    );
}

/// A claim against a directory owned by a newer layout fails without writing.
#[test]
fn claiming_a_newer_layout_fails_closed() {
    let temp = TempDir::new().unwrap();
    let state_dir = temp.path().join("projects").join("app-0000");
    std::fs::create_dir_all(&state_dir).unwrap();
    std::fs::write(
        state_dir.join("layout.json"),
        b"{\"layout\":\"pickforge-project-state\",\"layoutVersion\":99}\n",
    )
    .unwrap();

    assert!(state::claim_layout(&state_dir).is_err());
}

// --- the marker's shape --------------------------------------------------

/// Plant `layout.json` as a symlink pointing at bytes that are a valid marker.
/// Following it would let an attacker certify a directory — and, before this
/// PR, have the CLI write through it.
#[test]
fn a_symlinked_marker_is_refused_even_with_valid_bytes() {
    let (_temp, project, env) = fixture();
    let state_dir = state_dir_for(&project, &env);
    std::fs::create_dir_all(&state_dir).unwrap();
    let outside = state_dir.parent().unwrap().join("outside.json");
    std::fs::write(&outside, state::layout_marker_bytes()).unwrap();
    symlink(&outside, &state_dir.join("layout.json"));

    let error = state::read_layout(&state_dir).unwrap_err().to_string();
    assert!(error.contains("is a symbolic link"), "{error}");
    assert!(state::claim_layout(&state_dir).is_err());
    assert!(plan_init(&receipt_only_request(&project), &env).is_err());

    // Nothing was written through the link, and the link is still the user's.
    assert_eq!(
        std::fs::read(&outside).unwrap(),
        state::layout_marker_bytes()
    );
    assert!(std::fs::symlink_metadata(state_dir.join("layout.json"))
        .unwrap()
        .file_type()
        .is_symlink());
}

/// A marker with a second name is not a marker this build trusts: it is an
/// inode someone else can still address.
#[test]
fn a_hardlinked_marker_is_refused() {
    let (_temp, project, env) = fixture();
    let state_dir = state_dir_for(&project, &env);
    std::fs::create_dir_all(&state_dir).unwrap();
    let marker = state_dir.join("layout.json");
    std::fs::write(&marker, state::layout_marker_bytes()).unwrap();
    std::fs::hard_link(&marker, state_dir.parent().unwrap().join("elsewhere")).unwrap();

    let error = state::read_layout(&state_dir).unwrap_err().to_string();
    assert!(error.contains("hard link"), "{error}");
    assert!(state::claim_layout(&state_dir).is_err());
}

/// The marker must be a regular file; a directory named `layout.json` is
/// refused rather than read.
#[test]
fn a_marker_that_is_not_a_regular_file_is_refused() {
    let (_temp, project, env) = fixture();
    let state_dir = state_dir_for(&project, &env);
    std::fs::create_dir_all(state_dir.join("layout.json")).unwrap();

    let error = state::read_layout(&state_dir).unwrap_err().to_string();
    assert!(error.contains("is not a regular file"), "{error}");
}

/// A crashed write — or a planted file with a name a previous build would
/// have reused after PID reuse — is inert: the claim neither writes through it
/// nor removes it.
#[test]
fn a_planted_transient_is_neither_adopted_nor_removed() {
    let temp = TempDir::new().unwrap();
    let state_dir = temp.path().join("projects").join("app-0000");
    std::fs::create_dir_all(&state_dir).unwrap();
    let outside = temp.path().join("outside");
    std::fs::write(&outside, b"private\n").unwrap();

    // The name the pre-fix build derived from PID and thread id, planted both
    // as a symlink out of the directory and as a stale regular file.
    let planted_link = state_dir.join(format!(
        ".pickforge-tmp-layout-{}-ThreadId(1)",
        std::process::id()
    ));
    symlink(&outside, &planted_link);
    let stale = state_dir.join(".pickforge-tmp-layout-stale");
    std::fs::write(&stale, b"crash remnant\n").unwrap();

    assert!(state::claim_layout(&state_dir).unwrap());

    // The marker is a real, singly linked regular file with complete bytes.
    let marker = state_dir.join("layout.json");
    let metadata = std::fs::symlink_metadata(&marker).unwrap();
    assert!(metadata.is_file() && !metadata.file_type().is_symlink());
    assert_eq!(
        std::fs::read(&marker).unwrap(),
        state::layout_marker_bytes()
    );
    // The planted entries — and the file one of them points at — are untouched.
    assert_eq!(std::fs::read(&outside).unwrap(), b"private\n");
    assert!(std::fs::symlink_metadata(&planted_link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(std::fs::read(&stale).unwrap(), b"crash remnant\n");
}

/// Cleanup removes the entry this claim created and nothing else.
#[test]
fn a_claim_leaves_only_the_marker_behind() {
    let temp = TempDir::new().unwrap();
    let state_dir = temp.path().join("projects").join("app-0000");

    assert!(state::claim_layout(&state_dir).unwrap());

    let mut entries: Vec<String> = std::fs::read_dir(&state_dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    entries.sort();
    assert_eq!(entries, vec!["layout.json"]);
}

/// A directory nobody has claimed yet is validated against the direct-entry
/// rule before the marker is stamped, whatever else it holds.
#[test]
fn a_first_adoption_refuses_a_foreign_entry_even_beside_a_receipt() {
    let temp = TempDir::new().unwrap();
    let state_dir = temp.path().join("projects").join("app-0000");
    std::fs::create_dir_all(&state_dir).unwrap();
    std::fs::write(state_dir.join("project.json"), b"{}\n").unwrap();
    std::fs::write(state_dir.join("notes.txt"), b"not ours\n").unwrap();

    let error = state::claim_layout(&state_dir).unwrap_err().to_string();
    assert!(
        error.contains("notes.txt is not owned by Pickforge"),
        "{error}"
    );
    assert!(error.contains("mv -n --"), "{error}");
    assert!(!state_dir.join("layout.json").exists());
}

/// Once a directory carries a marker, an entry created later is not re-judged:
/// ownership was settled at adoption.
#[test]
fn a_claimed_directory_is_not_re_policed() {
    let temp = TempDir::new().unwrap();
    let state_dir = temp.path().join("projects").join("app-0000");
    assert!(state::claim_layout(&state_dir).unwrap());
    std::fs::write(state_dir.join("notes.txt"), b"added later\n").unwrap();

    assert!(!state::claim_layout(&state_dir).unwrap());
}

#[cfg(unix)]
fn symlink(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).unwrap();
}

#[cfg(windows)]
fn symlink(target: &Path, link: &Path) {
    std::os::windows::fs::symlink_file(target, link).unwrap();
}

// --- failure after a claim -----------------------------------------------

/// A marker this run published is a real change, so a later failure cannot be
/// reported as a clean rollback with nothing changed.
#[test]
fn a_failed_apply_after_a_new_claim_reports_the_marker_as_a_residual() {
    let (_temp, project, env) = fixture();
    let plan = plan_init(&receipt_only_request(&project), &env).unwrap();
    let state_dir = state_dir_for(&project, &env);

    // The receipt target drifts between planning and applying: a directory
    // now sits where the file belongs, so writing it fails.
    std::fs::create_dir_all(state_dir.join("project.json")).unwrap();

    let report = apply_init(&plan, "1");
    assert_eq!(report.outcome, ApplyState::FailedPartial);
    assert!(report.changed);
    let marker = state_dir.join("layout.json").to_string_lossy().into_owned();
    assert!(
        report.rollback_residuals.contains(&marker),
        "{:?}",
        report.rollback_residuals
    );
    assert!(state_dir.join("layout.json").is_file());
}

// --- the ownership table -------------------------------------------------

#[derive(serde::Deserialize)]
struct LayoutFixture {
    #[serde(rename = "layoutKind")]
    layout_kind: String,
    #[serde(rename = "layoutVersion")]
    layout_version: u32,
    #[serde(rename = "markerContent")]
    marker_content: String,
    ownership: Vec<OwnershipRow>,
}

#[derive(serde::Deserialize)]
struct OwnershipRow {
    entry: String,
    owner: String,
}

fn layout_fixture() -> LayoutFixture {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/state-layout.json")
        .canonicalize()
        .expect("the shared layout fixture exists");
    serde_json::from_slice(&std::fs::read(path).unwrap()).expect("the fixture parses")
}

fn owner_named(owner: &str) -> Owner {
    match owner {
        "shared" => Owner::Shared,
        "integration" => Owner::Integration,
        "transient" => Owner::Transient,
        "foreign" => Owner::Foreign,
        other => panic!("unknown owner {other:?} in the shared layout fixture"),
    }
}

/// The one ownership table both tools implement, read from the language-neutral
/// fixture `packages/core/test/state-layout.test.ts` also checks. Changing one
/// implementation without the fixture fails both suites.
#[test]
fn entry_ownership_matches_the_shared_fixture() {
    let fixture = layout_fixture();
    assert_eq!(fixture.layout_kind, state::LAYOUT_KIND);
    assert_eq!(fixture.layout_version, state::LAYOUT_VERSION);
    assert_eq!(
        fixture.marker_content.as_bytes(),
        state::layout_marker_bytes()
    );
    for row in &fixture.ownership {
        assert_eq!(
            state::classify_entry(&row.entry),
            owner_named(&row.owner),
            "entry {:?}",
            row.entry
        );
    }
}
