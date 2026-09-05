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
#[cfg(unix)]
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
#[cfg(unix)]
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

// --- a marker that could block a reader ----------------------------------

/// Run `body` on its own thread and fail if it has not finished within
/// `LAYOUT_CALL_TIMEOUT`.
///
/// Every check below is about a marker that a *blocking* open would never come
/// back from, so "refused" is only half the guarantee: the other half is that
/// the answer arrives at all. A plain assertion would hang the whole test
/// binary instead of failing.
const LAYOUT_CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

fn within_timeout<T: Send + 'static>(what: &str, body: impl FnOnce() -> T + Send + 'static) -> T {
    let (sender, receiver) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let _ = sender.send(body());
    });
    match receiver.recv_timeout(LAYOUT_CALL_TIMEOUT) {
        Ok(value) => {
            worker.join().unwrap();
            value
        }
        Err(_) => panic!("{what} blocked for more than {LAYOUT_CALL_TIMEOUT:?}"),
    }
}

#[cfg(unix)]
fn mkfifo(path: &Path) {
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    // SAFETY: `name` is a valid NUL-terminated path for the duration of the call.
    let created = unsafe { libc::mkfifo(name.as_ptr(), 0o600) };
    assert_eq!(
        created,
        0,
        "mkfifo failed: {}",
        std::io::Error::last_os_error()
    );
}

/// A FIFO named `layout.json` used to hang both tools forever: the marker was
/// opened for reading before its type was checked, and opening a FIFO blocks
/// until a writer arrives (#104 R1). Nobody ever comes.
#[cfg(unix)]
#[test]
fn a_fifo_marker_is_refused_instead_of_blocking() {
    let temp = TempDir::new().unwrap();
    let state_dir = temp.path().join("projects").join("app-0000");
    std::fs::create_dir_all(&state_dir).unwrap();
    mkfifo(&state_dir.join("layout.json"));

    let dir = state_dir.clone();
    let error = within_timeout("read_layout on a FIFO marker", move || {
        state::read_layout(&dir).unwrap_err().to_string()
    });
    assert!(error.contains("is not a regular file"), "{error}");
    assert!(error.contains("named pipe"), "{error}");

    let dir = state_dir.clone();
    let claim = within_timeout("claim_layout on a FIFO marker", move || {
        state::claim_layout(&dir).map(|_| ())
    });
    assert!(claim.is_err(), "a FIFO marker was adopted");
    // The FIFO is the user's: refused, never replaced or removed.
    assert_eq!(
        entry_names(&state_dir),
        vec!["layout.json"],
        "the refusal wrote something"
    );
}

/// A socket, a device node, and a directory all reach the same rule from
/// different `open` outcomes: a socket fails the open with `ENXIO`, a
/// directory succeeds and fails the type check.
#[cfg(unix)]
#[test]
fn a_socket_marker_is_refused_instead_of_blocking() {
    let temp = TempDir::new().unwrap();
    let state_dir = temp.path().join("projects").join("app-0000");
    std::fs::create_dir_all(&state_dir).unwrap();
    let listener = std::os::unix::net::UnixListener::bind(state_dir.join("layout.json")).unwrap();

    let dir = state_dir.clone();
    let error = within_timeout("read_layout on a socket marker", move || {
        state::read_layout(&dir).unwrap_err().to_string()
    });
    assert!(error.contains("is not a regular file"), "{error}");
    assert!(error.contains("socket"), "{error}");
    drop(listener);
}

// A device node cannot be created inside a temp directory without privileges
// and cannot be hard-linked across filesystems, so the device case is pinned
// where it is decided instead: `state.rs`'s `a_device_node_is_not_a_regular_file`
// classifies `/dev/null`, and the refusal text it feeds is the same one the
// FIFO and socket cases above assert end to end.

// --- the publication window ----------------------------------------------

/// A marker that is multiply linked because its publisher has not yet unlinked
/// its staging entry is a *publication in flight*, and must be waited out even
/// when the publisher is descheduled for far longer than the old fixed
/// 40 × 5 ms window (#104 R6).
#[test]
fn a_slow_publication_window_is_waited_out_rather_than_refused() {
    let temp = TempDir::new().unwrap();
    let state_dir = temp.path().join("projects").join("app-0000");
    std::fs::create_dir_all(&state_dir).unwrap();
    let staging = state_dir.join(".pickforge-tmp-layout-slowpublisher");
    std::fs::write(&staging, state::layout_marker_bytes()).unwrap();
    std::fs::hard_link(&staging, state_dir.join("layout.json")).unwrap();

    // A publisher stalled for 400 ms — twice the old window — between its
    // `link(2)` and the unlink of its staging entry.
    let publisher = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        std::fs::remove_file(&staging).unwrap();
    });

    assert_eq!(state::read_layout(&state_dir).unwrap(), Some(1));
    publisher.join().unwrap();
}

/// A second name that is *not* a publication in flight is a planted hard link
/// and is refused — promptly, without waiting out the publication budget.
#[test]
fn a_planted_hard_link_is_refused_without_waiting_for_a_publisher() {
    let temp = TempDir::new().unwrap();
    let state_dir = temp.path().join("projects").join("app-0000");
    std::fs::create_dir_all(&state_dir).unwrap();
    let marker = state_dir.join("layout.json");
    std::fs::write(&marker, state::layout_marker_bytes()).unwrap();
    std::fs::hard_link(&marker, temp.path().join("elsewhere")).unwrap();

    let started = std::time::Instant::now();
    let error = state::read_layout(&state_dir).unwrap_err().to_string();
    assert!(error.contains("hard link"), "{error}");
    assert!(
        started.elapsed() < std::time::Duration::from_millis(500),
        "refusing a planted hard link waited {:?}",
        started.elapsed()
    );
}

// --- owned entries must have the shape their owner writes ----------------

/// A symlinked `runs` is an entry both tools refuse to write through. Stamping
/// the marker beside it would certify a layout that is not sound, so first
/// adoption refuses it instead (#104 R7).
#[cfg(unix)]
#[test]
fn a_symlinked_run_tree_is_refused_before_the_marker_is_stamped() {
    let temp = TempDir::new().unwrap();
    let state_dir = temp.path().join("projects").join("app-0000");
    std::fs::create_dir_all(&state_dir).unwrap();
    let outside = temp.path().join("outside-runs");
    std::fs::create_dir(&outside).unwrap();
    symlink(&outside, &state_dir.join("runs"));

    let error = state::claim_layout(&state_dir).unwrap_err().to_string();
    assert!(error.contains("runs is not a directory"), "{error}");
    assert!(error.contains("symbolic link"), "{error}");
    assert!(error.contains("mv -n --"), "{error}");
    // Nothing stamped, nothing written through the link.
    assert!(!state_dir.join("layout.json").exists());
    assert_eq!(entry_names(&outside), Vec::<String>::new());
}

/// The same rule for the entries the integration CLI owns.
#[cfg(unix)]
#[test]
fn a_symlinked_receipt_is_refused_before_the_marker_is_stamped() {
    let temp = TempDir::new().unwrap();
    let state_dir = temp.path().join("projects").join("app-0000");
    std::fs::create_dir_all(&state_dir).unwrap();
    let outside = temp.path().join("outside.json");
    std::fs::write(&outside, b"{}\n").unwrap();
    symlink(&outside, &state_dir.join("project.json"));

    let error = state::claim_layout(&state_dir).unwrap_err().to_string();
    assert!(
        error.contains("project.json is not a regular file"),
        "{error}"
    );
    assert!(error.contains("symbolic link"), "{error}");
    assert!(!state_dir.join("layout.json").exists());
    assert_eq!(std::fs::read(&outside).unwrap(), b"{}\n");
}

/// A `runs` FIFO must not block the *adoption* check either.
#[cfg(unix)]
#[test]
fn a_fifo_run_tree_is_refused_instead_of_blocking() {
    let temp = TempDir::new().unwrap();
    let state_dir = temp.path().join("projects").join("app-0000");
    std::fs::create_dir_all(&state_dir).unwrap();
    mkfifo(&state_dir.join("runs"));

    let dir = state_dir.clone();
    let error = within_timeout("claim_layout beside a FIFO run tree", move || {
        state::claim_layout(&dir).unwrap_err().to_string()
    });
    assert!(error.contains("runs is not a directory"), "{error}");
    assert!(error.contains("named pipe"), "{error}");
    assert!(!state_dir.join("layout.json").exists());
}

/// The entries an alpha.1/alpha.2 directory really holds — a real receipt,
/// real backups, a real run tree, and an inert transient — are all still
/// adopted in place. The shape rule must not cost a legitimate upgrade.
#[test]
fn a_real_legacy_directory_is_still_adopted_in_place() {
    let temp = TempDir::new().unwrap();
    let state_dir = temp.path().join("projects").join("app-0000");
    std::fs::create_dir_all(state_dir.join("runs").join("20260101-000000-old")).unwrap();
    std::fs::write(state_dir.join("project.json"), b"{\"schemaVersion\":1}\n").unwrap();
    std::fs::write(
        state_dir.join("project.json.pickforge-backup-20260101"),
        b"{\"schemaVersion\":1}\n",
    )
    .unwrap();
    std::fs::write(state_dir.join(".pickforge-tmp-crash"), b"remnant\n").unwrap();

    assert!(state::claim_layout(&state_dir).unwrap());
    assert_eq!(state::read_layout(&state_dir).unwrap(), Some(1));
    assert!(state_dir.join("runs").join("20260101-000000-old").is_dir());
}

// --- the state directory itself ------------------------------------------

/// The lab refuses a symlinked `projects/<id>`; so does the CLI now, on the
/// logical path, before the transaction layer canonicalises it away (#104 R3).
#[cfg(unix)]
#[test]
fn a_symlinked_project_state_directory_is_refused_by_init() {
    let (_temp, project, env) = fixture();
    let state_dir = state_dir_for(&project, &env);
    let outside = state_dir.parent().unwrap().join("elsewhere");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::create_dir_all(state_dir.parent().unwrap()).unwrap();
    symlink(&outside, &state_dir);

    let error = plan_init(&receipt_only_request(&project), &env)
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("is not a directory"), "{error}");
    assert!(error.contains("symbolic link"), "{error}");
    assert!(error.contains("mv -n --"), "{error}");
    // Nothing was written through the link, and the link is still the user's.
    assert_eq!(entry_names(&outside), Vec::<String>::new());
    assert!(std::fs::symlink_metadata(&state_dir)
        .unwrap()
        .file_type()
        .is_symlink());
}

/// A real state directory that already exists is exactly what the normal path
/// uses, so the check above must not touch it.
#[test]
fn a_real_existing_state_directory_is_still_used() {
    let (_temp, project, env) = fixture();
    let state_dir = state_dir_for(&project, &env);
    std::fs::create_dir_all(&state_dir).unwrap();

    assert_eq!(run_init(&project, &env, "1").unwrap(), ApplyState::Success);
    assert!(state_dir.join("project.json").is_file());
}

// --- the dry run previews the same refusal -------------------------------

/// `init --dry-run` is `plan_init` with nothing applied. With a receipt
/// present and no marker it used to skip the direct-entry rule entirely and
/// report a clean plan for a directory the real run then refused (#104 R2).
#[test]
fn the_dry_run_refuses_a_foreign_entry_beside_an_existing_receipt() {
    let (_temp, project, env) = fixture();
    let state_dir = state_dir_for(&project, &env);

    // A real alpha.1/alpha.2 directory: a valid receipt, no marker.
    run_init(&project, &env, "1").unwrap();
    std::fs::remove_file(state_dir.join("layout.json")).unwrap();
    std::fs::write(state_dir.join("notes.txt"), b"not ours\n").unwrap();

    let error = plan_init(&receipt_only_request(&project), &env)
        .err()
        .unwrap()
        .to_string();
    assert!(
        error.contains("notes.txt is not owned by Pickforge"),
        "{error}"
    );
    assert!(error.contains("mv -n --"), "{error}");
    // The preview wrote nothing: no marker, and the entry is untouched.
    assert!(!state_dir.join("layout.json").exists());
    assert_eq!(
        std::fs::read(state_dir.join("notes.txt")).unwrap(),
        b"not ours\n"
    );
}

/// The same for an owned entry of the wrong shape: preview and apply agree.
#[cfg(unix)]
#[test]
fn the_dry_run_refuses_a_symlinked_run_tree_beside_an_existing_receipt() {
    let (_temp, project, env) = fixture();
    let state_dir = state_dir_for(&project, &env);
    run_init(&project, &env, "1").unwrap();
    std::fs::remove_file(state_dir.join("layout.json")).unwrap();
    let outside = state_dir.parent().unwrap().join("outside-runs");
    std::fs::create_dir_all(&outside).unwrap();
    symlink(&outside, &state_dir.join("runs"));

    let error = plan_init(&receipt_only_request(&project), &env)
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("runs is not a directory"), "{error}");
    assert!(!state_dir.join("layout.json").exists());
}

/// A claimed directory is not re-policed by the preview either: the marker is
/// what settles ownership, exactly as it does at apply time.
#[test]
fn the_dry_run_does_not_re_police_a_claimed_directory() {
    let (_temp, project, env) = fixture();
    let state_dir = state_dir_for(&project, &env);
    run_init(&project, &env, "1").unwrap();
    std::fs::write(state_dir.join("notes.txt"), b"added later\n").unwrap();

    assert!(plan_init(&receipt_only_request(&project), &env).is_ok());
}

// --- names that cannot be shown as a command -----------------------------

/// A name that is not valid UTF-8 on disk is described, never turned into a
/// command whose source path would not match the real bytes.
#[cfg(unix)]
#[test]
fn a_non_utf8_entry_is_described_without_a_command() {
    use std::os::unix::ffi::OsStrExt;
    let temp = TempDir::new().unwrap();
    let state_dir = temp.path().join("projects").join("app-0000");
    std::fs::create_dir_all(&state_dir).unwrap();
    let name = std::ffi::OsStr::from_bytes(b"bad-\xff-name").to_os_string();
    std::fs::write(state_dir.join(&name), b"x").unwrap();

    let error = state::claim_layout(&state_dir).unwrap_err().to_string();
    assert!(error.contains("not valid UTF-8"), "{error}");
    assert!(!error.contains("mv -n"), "{error}");
    assert!(error.contains("Move it aside yourself"), "{error}");
    assert!(!state_dir.join("layout.json").exists());
}

/// Sorted entry names of a directory.
fn entry_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

// --- failure after a claim -----------------------------------------------

/// A marker this run published is a real change, so a later failure cannot be
/// reported as a clean rollback with nothing changed.
#[test]
fn a_failed_apply_after_a_new_claim_reports_the_marker_as_a_residual() {
    let (_temp, project, env) = fixture();
    let plan = plan_init(&receipt_only_request(&project), &env).unwrap();
    // The reported directory, so the residual is compared against the same
    // physical path the report names (Windows resolves the temp root
    // differently from the path the environment was built with).
    let state_dir = PathBuf::from(&plan.report.state_dir);

    // The receipt target drifts between planning and applying: the plan was
    // made for a directory with no receipt, and one appeared meanwhile, so the
    // transaction's drift check fails the apply. The drifted receipt is a
    // regular file, so the directory is still adoptable and the claim really
    // does happen before the failure — which is the point of this test.
    std::fs::create_dir_all(&state_dir).unwrap();
    std::fs::write(state_dir.join("project.json"), b"{\"drifted\":true}\n").unwrap();

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
