//! Process-level checks: version, self-test, argument errors and refused
//! displays. None of them opens a window: `DISPLAY` points at a display no
//! server owns, and the Wayland variables are removed.

use std::process::{Command, Output};

#[cfg(target_os = "linux")]
mod common;

fn viewer(args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_pickforge-viewer"));
    command
        .args(args)
        .env_remove("WAYLAND_DISPLAY")
        .env_remove("WAYLAND_SOCKET")
        .env("DISPLAY", ":49999");
    command
}

fn run(args: &[&str]) -> Output {
    viewer(args).output().expect("run pickforge-viewer")
}

#[test]
fn prints_version() {
    let out = run(&["--version"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(
        String::from_utf8(out.stdout).unwrap(),
        format!("pickforge-viewer {}\n", env!("CARGO_PKG_VERSION"))
    );
}

#[test]
fn self_test_passes() {
    let out = run(&["--self-test"]);
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn invalid_arguments_exit_2() {
    for args in [
        &[][..],
        &["--display"],
        &["--display", "1", "--xvfb-pid", "1"],
        &["--version", "--extra"],
        &["--nope"],
    ] {
        let out = run(args);
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert!(out.stdout.is_empty(), "{args:?}: no protocol output");
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use pickforge_viewer::procstat::read_start_ticks;

    fn launch(display: u32, ticks: u64) -> Vec<String> {
        let pid = std::process::id();
        vec![
            "--display".into(),
            format!(":{display}"),
            "--xvfb-pid".into(),
            pid.to_string(),
            "--xvfb-start-ticks".into(),
            ticks.to_string(),
            "--width".into(),
            "640".into(),
            "--height".into(),
            "480".into(),
            "--class".into(),
            "pickforge-viewer-test".into(),
        ]
    }

    fn error_code(out: &Output) -> String {
        let line = String::from_utf8(out.stdout.clone()).unwrap();
        let value: serde_json::Value = serde_json::from_str(line.trim()).expect("one error event");
        assert_eq!(value["event"], "error");
        value["code"].as_str().unwrap().to_string()
    }

    fn own_ticks() -> u64 {
        read_start_ticks(std::process::id()).unwrap()
    }

    #[test]
    fn refuses_its_own_display() {
        let display = common::unused_display();
        let args = launch(display, own_ticks());
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = viewer(&args)
            .env("DISPLAY", format!(":{display}.0"))
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(3));
        assert_eq!(error_code(&out), "display-refused");
    }

    #[test]
    fn refuses_a_changed_xvfb_identity() {
        let args = launch(common::unused_display(), own_ticks() + 1);
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = run(&args);
        assert_eq!(out.status.code(), Some(3));
        assert_eq!(error_code(&out), "xvfb-mismatch");
    }

    #[test]
    fn missing_display_exits_3() {
        let args = launch(common::unused_display(), own_ticks());
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = run(&args);
        assert_eq!(out.status.code(), Some(3));
        assert_eq!(error_code(&out), "display-open");
    }
}
