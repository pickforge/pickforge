//! The Wayland clipboard reader without a compositor. It is one test in
//! its own binary because it sets `WAYLAND_DISPLAY` for the process.

#![cfg(target_os = "linux")]

use pickforge_viewer::clipboard::{read_wayland, wayland_refusal, Refusal};
use std::time::{Duration, Instant};
use wl_clipboard_rs::paste::Error;

#[test]
fn a_missing_compositor_or_protocol_means_paste_unavailable() {
    let dir = std::env::temp_dir().join(format!("pickforge-paste-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::env::set_var("WAYLAND_DISPLAY", dir.join("no-such-socket"));
    std::env::remove_var("WAYLAND_SOCKET");
    let start = Instant::now();
    assert_eq!(
        read_wayland(Duration::from_secs(1)).unwrap_err(),
        Refusal::Unavailable
    );
    assert!(start.elapsed() < Duration::from_secs(1));
    std::fs::remove_dir_all(&dir).unwrap();

    // GNOME has no data-control protocol.
    let missing = Error::MissingProtocol {
        name: "zwlr_data_control_manager_v1",
        version: 1,
    };
    assert_eq!(wayland_refusal(&missing), Refusal::Unavailable);
    for empty in [Error::NoSeats, Error::ClipboardEmpty, Error::NoMimeType] {
        assert_eq!(wayland_refusal(&empty), Refusal::Empty);
    }
}
