//! Temporary diagnostic for #468, never merged: runs the publication race on
//! the fixed reader, with and without a stalled reader or publisher, and
//! always fails so the numbers show in the CI log.

use std::time::{Duration, Instant};

use pickforge_cli::state;
use tempfile::TempDir;

fn race(
    publisher_stall: Duration,
) -> (Result<Option<u32>, state::LayoutError>, Duration, Duration) {
    let temp = TempDir::new().unwrap();
    let state_dir = temp.path().join("projects").join("app-0000");
    std::fs::create_dir_all(&state_dir).unwrap();
    let staging = state_dir.join(".pickforge-tmp-layout-slowpublisher");
    std::fs::write(&staging, state::layout_marker_bytes()).unwrap();
    std::fs::hard_link(&staging, state_dir.join("layout.json")).unwrap();
    let began = Instant::now();
    let publisher = std::thread::spawn(move || {
        std::thread::sleep(publisher_stall);
        std::fs::remove_file(&staging).unwrap();
        began.elapsed()
    });
    let read = state::read_layout(&state_dir);
    let returned = began.elapsed();
    (read, publisher.join().unwrap(), returned)
}

fn phase(
    label: &str,
    rounds: u32,
    publisher_stall: Duration,
    lines: &mut Vec<String>,
) -> (u32, u32) {
    let (mut ok, mut refused) = (0, 0);
    for round in 0..rounds {
        let (read, published, returned) = race(publisher_stall);
        let outcome = match &read {
            Ok(_) => {
                ok += 1;
                "ok".to_string()
            }
            Err(state::LayoutError::Refused { .. }) => {
                refused += 1;
                "refused".to_string()
            }
            Err(error) => format!("error {error}"),
        };
        lines.push(format!(
            "{label} {round}: {outcome} published={}ms returned={}ms",
            published.as_millis(),
            returned.as_millis()
        ));
    }
    lines.push(format!(
        "{label} summary: ok={ok} refused={refused} of {rounds}"
    ));
    (ok, refused)
}

#[test]
fn diag_468_fixed_reader_on_this_runner() {
    let mut lines = vec![format!("temp={}", std::env::temp_dir().display())];
    phase(
        "A fixed reader, 400 ms publisher",
        40,
        Duration::from_millis(400),
        &mut lines,
    );
    std::env::set_var("PROBE_468_READER_STALL_MS", "1200");
    phase(
        "B fixed reader stalled 1200 ms",
        10,
        Duration::from_millis(400),
        &mut lines,
    );
    std::env::set_var("PROBE_468_OLD_DEADLINE", "1");
    phase(
        "C old deadline check, reader stalled 1200 ms",
        10,
        Duration::from_millis(400),
        &mut lines,
    );
    std::env::remove_var("PROBE_468_OLD_DEADLINE");
    std::env::remove_var("PROBE_468_READER_STALL_MS");
    phase(
        "D fixed reader, publisher stalled 1600 ms",
        5,
        Duration::from_millis(1600),
        &mut lines,
    );
    panic!(
        "diagnostic for #468 on the fixed reader\n{}",
        lines.join("\n")
    );
}
