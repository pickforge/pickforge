//! Headless capture against a real Xvfb: pixels, DAMAGE delivery, pause,
//! session end and the cursor.

#![cfg(target_os = "linux")]

mod common;

use common::{wait_until, xvfb_ready, Painter, Xvfb};
use pickforge_viewer::capture::{Capture, Control, Shared};
use pickforge_viewer::geometry::Rect;
use pickforge_viewer::protocol::EndReason;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{ChangeWindowAttributesAux, ConnectionExt as _};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::NONE;

const SCREEN: &str = "640x480x24";
const WAIT: Duration = Duration::from_secs(3);

struct Running {
    shared: Arc<Mutex<Shared>>,
    control: Arc<Control>,
    thread: Option<JoinHandle<()>>,
}

impl Running {
    fn start(capture: Capture, xvfb: Option<(u32, u64)>) -> Running {
        let (w, h) = capture.size();
        let shared = Arc::new(Mutex::new(Shared::new(w, h)));
        let control = Control::new().unwrap();
        let thread = {
            let (shared, control) = (shared.clone(), control.clone());
            thread::spawn(move || capture.run(shared, control, xvfb, || {}))
        };
        let running = Running {
            shared,
            control,
            thread: Some(thread),
        };
        assert!(wait_until(WAIT, || running.fetches() >= 1), "first fetch");
        running
    }

    fn fetches(&self) -> u64 {
        self.shared.lock().unwrap().fetches
    }

    fn pixel(&self, x: u32, y: u32) -> u32 {
        self.shared.lock().unwrap().frame.pixel(x, y)
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.control.stop();
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}

fn check_pixels(capture: &mut Capture) {
    let frame = capture.snapshot().unwrap();
    assert_eq!((frame.width, frame.height), (640, 480));
    assert_eq!(frame.pixel(20, 20), 0x00c0_3020, "window background");
    assert_eq!(frame.pixel(70, 40), 0x0020_c040, "filled rectangle");
    assert_eq!(frame.pixel(109, 54), 0x0020_c040, "rectangle corner");
    assert_eq!(frame.pixel(110, 55), 0x00c0_3020, "past the rectangle");
}

#[test]
fn captures_drawn_pixels_with_and_without_shared_memory() {
    if !xvfb_ready("captures_drawn_pixels") {
        return;
    }
    let xvfb = Xvfb::start(SCREEN);
    let painter = Painter::new(xvfb.display, 0, 0, 200, 100, 0x00c0_3020);
    painter.fill(50, 25, 60, 30, 0x0020_c040);

    let mut capture = Capture::connect(xvfb.display).unwrap();
    assert!(capture.uses_shm(), "Xvfb supports MIT-SHM");
    check_pixels(&mut capture);

    let mut plain = Capture::connect(xvfb.display).unwrap().without_shm();
    assert!(!plain.uses_shm());
    check_pixels(&mut plain);
}

#[test]
fn damage_drives_updates_and_pause_stops_them() {
    if !xvfb_ready("damage_drives_updates") {
        return;
    }
    let xvfb = Xvfb::start(SCREEN);
    let painter = Painter::new(xvfb.display, 0, 0, 640, 480, 0x0010_1010);
    let running = Running::start(Capture::connect(xvfb.display).unwrap(), None);
    running.shared.lock().unwrap().dirty = None;

    painter.fill(100, 120, 30, 20, 0x0000_00ff);
    assert!(
        wait_until(WAIT, || running.pixel(110, 130) == 0x0000_00ff),
        "damage update"
    );
    let dirty = running.shared.lock().unwrap().dirty.expect("dirty area");
    assert_eq!(
        dirty.intersect(&Rect::new(100, 120, 30, 20)),
        Rect::new(100, 120, 30, 20)
    );
    assert!(
        dirty.w < 640 || dirty.h < 480,
        "fetches only the damaged area, got {dirty:?}"
    );

    // Bursts of drawing are coalesced, not fetched one by one.
    let before = running.fetches();
    for i in 0..60 {
        painter.fill(i * 5, 300, 5, 5, 0x00ff_ff00);
    }
    assert!(wait_until(WAIT, || running.pixel(297, 302) == 0x00ff_ff00));
    let burst = running.fetches() - before;
    assert!(burst < 60, "{burst} fetches for 60 draws");

    running.control.set_paused(true);
    thread::sleep(Duration::from_millis(100));
    let paused_at = running.fetches();
    painter.fill(100, 120, 30, 20, 0x00ff_0000);
    thread::sleep(Duration::from_millis(300));
    assert_eq!(
        running.pixel(110, 130),
        0x0000_00ff,
        "no fetch while paused"
    );
    assert_eq!(running.fetches(), paused_at);

    running.control.set_paused(false);
    assert!(
        wait_until(WAIT, || running.pixel(110, 130) == 0x00ff_0000),
        "resume fetches"
    );
}

#[test]
fn idle_session_does_not_fetch() {
    if !xvfb_ready("idle_session_does_not_fetch") {
        return;
    }
    let xvfb = Xvfb::start(SCREEN);
    let _painter = Painter::new(xvfb.display, 0, 0, 640, 480, 0x0010_1010);
    let running = Running::start(Capture::connect(xvfb.display).unwrap(), None);
    thread::sleep(Duration::from_millis(200));
    let settled = running.fetches();
    thread::sleep(Duration::from_millis(500));
    assert_eq!(running.fetches(), settled);
}

#[test]
fn reports_x11_eof_when_xvfb_exits() {
    if !xvfb_ready("reports_x11_eof") {
        return;
    }
    let mut xvfb = Xvfb::start(SCREEN);
    let watch = Some((xvfb.pid, xvfb.start_ticks));
    let running = Running::start(Capture::connect(xvfb.display).unwrap(), watch);
    xvfb.stop();
    assert!(wait_until(WAIT, || running
        .shared
        .lock()
        .unwrap()
        .ended
        .is_some()));
    let ended = running.shared.lock().unwrap().ended;
    assert!(
        matches!(ended, Some(EndReason::X11Eof) | Some(EndReason::XvfbGone)),
        "{ended:?}"
    );
}

#[test]
fn reports_xvfb_gone_on_a_changed_identity() {
    if !xvfb_ready("reports_xvfb_gone") {
        return;
    }
    let xvfb = Xvfb::start(SCREEN);
    let watch = Some((xvfb.pid, xvfb.start_ticks + 1));
    let capture = Capture::connect(xvfb.display).unwrap();
    let shared = Arc::new(Mutex::new(Shared::new(640, 480)));
    let control = Control::new().unwrap();
    let thread = {
        let (shared, control) = (shared.clone(), control.clone());
        thread::spawn(move || capture.run(shared, control, watch, || {}))
    };
    assert!(wait_until(WAIT, || shared.lock().unwrap().ended.is_some()));
    assert_eq!(shared.lock().unwrap().ended, Some(EndReason::XvfbGone));
    thread.join().unwrap();
}

#[test]
fn tracks_cursor_image_and_position() {
    if !xvfb_ready("tracks_cursor") {
        return;
    }
    let xvfb = Xvfb::start(SCREEN);
    let painter = Painter::new(xvfb.display, 100, 100, 200, 200, 0x0030_3030);

    let capture = Capture::connect(xvfb.display).unwrap();
    let (image, _) = capture.cursor().unwrap().expect("XFIXES cursor");
    assert!(image.width > 0 && image.height > 0);
    assert!(
        image.pixels.iter().any(|p| p >> 24 != 0),
        "visible cursor pixels"
    );
    let first_serial = image.serial;

    let running = Running::start(capture, None);

    // A different cursor on the window, then the pointer moves onto it.
    let conn = &painter.conn;
    let font = conn.generate_id().unwrap();
    conn.open_font(font, b"cursor").unwrap();
    let cursor = conn.generate_id().unwrap();
    conn.create_glyph_cursor(cursor, font, font, 58, 59, 0, 0, 0, 0xffff, 0xffff, 0xffff)
        .unwrap();
    conn.change_window_attributes(
        painter.window,
        &ChangeWindowAttributesAux::new().cursor(cursor),
    )
    .unwrap();
    conn.warp_pointer(NONE, painter.root, 0, 0, 0, 0, 150, 160)
        .unwrap();
    painter.sync();
    assert!(
        wait_until(WAIT, || {
            let s = running.shared.lock().unwrap();
            s.cursor.as_ref().is_some_and(|c| c.serial != first_serial)
                && s.cursor_pos == (150, 160)
        }),
        "cursor change and position"
    );

    // Pointer motion from an input device arrives through XInput 2.
    conn.xtest_fake_input(6, 0, 0, painter.root, 420, 330, 0)
        .unwrap();
    painter.sync();
    assert!(
        wait_until(WAIT, || running.shared.lock().unwrap().cursor_pos
            == (420, 330)),
        "pointer motion"
    );
    conn.flush().unwrap();
}
