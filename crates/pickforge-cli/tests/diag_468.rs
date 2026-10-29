//! Temporary diagnostic for #468, never merged: times the publication window
//! on a Windows runner and always fails so the numbers show in the CI log.
#![cfg(windows)]

use std::path::Path;
use std::time::{Duration, Instant};

use pickforge_cli::state;
use tempfile::TempDir;

fn rounds(base: Option<&Path>, label: &str, lines: &mut Vec<String>) -> usize {
    let mut refused = 0;
    for round in 0..40 {
        let temp = match base {
            Some(base) => TempDir::new_in(base).unwrap(),
            None => TempDir::new().unwrap(),
        };
        let state_dir = temp.path().join("projects").join("app-0000");
        std::fs::create_dir_all(&state_dir).unwrap();
        let staging = state_dir.join(".pickforge-tmp-layout-slowpublisher");
        std::fs::write(&staging, state::layout_marker_bytes()).unwrap();
        std::fs::hard_link(&staging, state_dir.join("layout.json")).unwrap();
        let start = Instant::now();
        let publisher = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            let woke = start.elapsed();
            let result = std::fs::remove_file(&staging);
            (woke, start.elapsed(), result.err().map(|error| format!("{error:?}")))
        });
        let read = state::read_layout(&state_dir);
        let read_at = start.elapsed();
        let (woke, removed, error) = publisher.join().unwrap();
        if read.is_err() {
            refused += 1;
        }
        lines.push(format!(
            "{label} {round}: ok={} read={}ms woke={}ms removed={}ms error={error:?}",
            read.is_ok(),
            read_at.as_millis(),
            woke.as_millis(),
            removed.as_millis(),
        ));
    }
    refused
}

#[test]
fn diag_468_publication_window_timing() {
    let mut lines = vec![format!("temp={}", std::env::temp_dir().display())];
    let default = rounds(None, "default-temp", &mut lines);
    let runner = std::env::var_os("RUNNER_TEMP").map(std::path::PathBuf::from);
    lines.push(format!("runner_temp={runner:?}"));
    let other = runner.as_deref().map(|dir| rounds(Some(dir), "runner-temp", &mut lines));
    panic!("diagnostic for #468: refused default={default} runner={other:?}\n{}", lines.join("\n"));
}
