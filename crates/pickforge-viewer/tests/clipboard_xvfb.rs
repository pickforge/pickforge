//! The X11 clipboard reader against a test owner on a private Xvfb.

#![cfg(target_os = "linux")]

mod common;
#[path = "common/selection.rs"]
mod selection;

use common::{xvfb_ready, Xvfb};
use pickforge_viewer::capture::connect_display;
use pickforge_viewer::clipboard::{read_x11, Refusal, Secret, MAX_PASTE_BYTES};
use pickforge_viewer::input::MAX_TEXT_CHARS;
use selection::{Owner, Serve};
use std::time::{Duration, Instant};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::ConnectionExt as _;

const TIMEOUT: Duration = Duration::from_millis(500);

fn read(display: u32) -> Result<Secret, Refusal> {
    let conn = connect_display(display).unwrap();
    let result = read_x11(&conn, 0, TIMEOUT);
    // The reader leaves no window of its own behind.
    let root = conn.setup().roots[0].root;
    let windows = conn.query_tree(root).unwrap().reply().unwrap().children;
    let base = conn.setup().resource_id_base;
    let mask = conn.setup().resource_id_mask;
    assert!(
        windows.iter().all(|&w| w & !mask != base),
        "a reader window is left"
    );
    result
}

#[test]
fn reads_utf8_text_once() {
    if !xvfb_ready("clipboard_text") {
        return;
    }
    let display = Xvfb::start("64x64x24");
    let owner = Owner::start(display.display, Serve::Text("Olá ß €\tx\r\n".into()));
    let text = read(display.display).unwrap();
    assert_eq!(text.as_str(), "Olá ß €\tx");
    assert_eq!(owner.requests(), 1);

    let full = "é".repeat(MAX_TEXT_CHARS);
    let owner = Owner::start(display.display, Serve::Text(full.clone().into_bytes()));
    assert_eq!(read(display.display).unwrap().as_str(), full);
    assert_eq!(owner.requests(), 1);
}

#[test]
fn refuses_empty_non_text_and_long_clipboards() {
    if !xvfb_ready("clipboard_refusals") {
        return;
    }
    let display = Xvfb::start("64x64x24");
    // No owner.
    assert_eq!(read(display.display).unwrap_err(), Refusal::Empty);

    let owner = Owner::start(display.display, Serve::ImageOnly);
    assert_eq!(read(display.display).unwrap_err(), Refusal::Empty);
    assert_eq!(owner.requests(), 1, "only UTF8_STRING is asked for");

    let owner = Owner::start(display.display, Serve::Text(b"\n".to_vec()));
    assert_eq!(read(display.display).unwrap_err(), Refusal::Empty);
    drop(owner);

    let owner = Owner::start(display.display, Serve::Text(vec![0xff, 0xfe]));
    assert_eq!(read(display.display).unwrap_err(), Refusal::Empty);
    drop(owner);

    let over = "a".repeat(MAX_TEXT_CHARS + 1).into_bytes();
    let owner = Owner::start(display.display, Serve::Text(over));
    assert_eq!(read(display.display).unwrap_err(), Refusal::TooLong);
    drop(owner);

    // More bytes than one bounded read takes.
    let huge = vec![b'a'; 4 * MAX_PASTE_BYTES];
    let owner = Owner::start(display.display, Serve::Text(huge));
    assert_eq!(read(display.display).unwrap_err(), Refusal::TooLong);
    assert_eq!(owner.requests(), 1);
}

#[test]
fn refuses_incr_without_starting_it() {
    if !xvfb_ready("clipboard_incr") {
        return;
    }
    let display = Xvfb::start("64x64x24");
    let owner = Owner::start(display.display, Serve::Incr);
    assert_eq!(read(display.display).unwrap_err(), Refusal::TooLong);
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(owner.requests(), 1, "one conversion, no INCR chunks");
}

#[test]
fn gives_up_on_an_owner_that_never_answers() {
    if !xvfb_ready("clipboard_silent") {
        return;
    }
    let display = Xvfb::start("64x64x24");
    let owner = Owner::start(display.display, Serve::Silent);
    let start = Instant::now();
    assert_eq!(read(display.display).unwrap_err(), Refusal::Unavailable);
    let took = start.elapsed();
    assert!(took >= TIMEOUT && took < TIMEOUT + Duration::from_millis(500));
    assert_eq!(owner.requests(), 1);
}
