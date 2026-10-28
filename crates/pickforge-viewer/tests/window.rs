//! Windowed smoke tests. The real binary watches one Xvfb and opens its
//! window on a second Xvfb, so no window ever reaches the host desktop.
//! Set `PICKFORGE_VIEWER_SCREENSHOTS=<dir>` to save PNG captures.

#![cfg(target_os = "linux")]

mod common;

use common::{near, wait_until, xvfb_ready, Painter, Xvfb};
use pickforge_viewer::capture::{connect_display, Capture, Frame};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt as _, InputFocus, MapState};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;

const BLUE: u32 = 0x0024_58c8;
const YELLOW: u32 = 0x00e0_c040;
const WHITE: u32 = 0x00ff_ffff;
const RED: u32 = 0x00d0_2020;
/// `--color-surface-1`, the bar.
const BAR: u32 = 0x000f_0f11;
const WAIT: Duration = Duration::from_secs(10);

struct Viewer {
    child: Child,
    stdin: Option<ChildStdin>,
    events: Receiver<Value>,
}

impl Viewer {
    fn spawn(
        session: &Xvfb,
        host_display: u32,
        class: &str,
        placement: &str,
        scale: &str,
    ) -> Viewer {
        let mut child = Command::new(env!("CARGO_BIN_EXE_pickforge-viewer"))
            .args(["--display", &format!(":{}", session.display)])
            .args(["--xvfb-pid", &session.pid.to_string()])
            .args(["--xvfb-start-ticks", &session.start_ticks.to_string()])
            .args(["--width", "640", "--height", "480"])
            .args(["--class", class, "--thumbnail-width", "384"])
            .args(["--placement", placement])
            // The window goes to the second Xvfb, never to the host desktop.
            .env_remove("WAYLAND_DISPLAY")
            .env_remove("WAYLAND_SOCKET")
            .env("DISPLAY", format!(":{host_display}"))
            .env("XAUTHORITY", "/dev/null")
            .env("WINIT_X11_SCALE_FACTOR", scale)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn pickforge-viewer");
        let stdout = child.stdout.take().unwrap();
        let (tx, events) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let value: Value = serde_json::from_str(&line)
                    .unwrap_or_else(|e| panic!("bad event {line:?}: {e}"));
                if tx.send(value).is_err() {
                    break;
                }
            }
        });
        Viewer {
            stdin: child.stdin.take(),
            child,
            events,
        }
    }

    /// Waits for the next event named `name`. Other events fail the test.
    fn expect(&self, name: &str) -> Value {
        match self.events.recv_timeout(WAIT) {
            Ok(event) if event["event"] == name => event,
            Ok(event) => panic!("expected {name}, got {event}"),
            Err(_) => panic!("no {name} event"),
        }
    }

    fn expect_quiet(&self, wait: Duration) {
        if let Ok(event) = self.events.recv_timeout(wait) {
            panic!("unexpected event {event}");
        }
    }

    fn send(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().unwrap();
        writeln!(stdin, "{line}").unwrap();
        stdin.flush().unwrap();
    }

    fn wait_exit(&mut self, timeout: Duration) -> Option<i32> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status.code();
            }
            thread::sleep(Duration::from_millis(5));
        }
        panic!("the viewer did not exit within {timeout:?}");
    }
}

impl Drop for Viewer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Placed {
    id: u32,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

/// The display that hosts the viewer window.
struct Screen {
    conn: RustConnection,
    root: u32,
    capture: Capture,
}

impl Screen {
    fn new(display: u32) -> Screen {
        let conn = connect_display(display).unwrap();
        let root = conn.setup().roots[0].root;
        Screen {
            conn,
            root,
            capture: Capture::connect(display).unwrap(),
        }
    }

    /// The mapped window whose WM_CLASS holds `class`.
    fn find(&self, class: &str) -> Option<Placed> {
        let tree = self.conn.query_tree(self.root).ok()?.reply().ok()?;
        for window in tree.children {
            let Ok(prop) = self
                .conn
                .get_property(false, window, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, 256)
                .unwrap()
                .reply()
            else {
                continue;
            };
            let names: Vec<&[u8]> = prop.value.split(|&b| b == 0).collect();
            if !names.contains(&class.as_bytes()) {
                continue;
            }
            let attrs = self.conn.get_window_attributes(window).ok()?.reply().ok()?;
            if attrs.map_state != MapState::VIEWABLE {
                continue;
            }
            let geometry = self.conn.get_geometry(window).ok()?.reply().ok()?;
            let at = self
                .conn
                .translate_coordinates(window, self.root, 0, 0)
                .ok()?
                .reply()
                .ok()?;
            return Some(Placed {
                id: window,
                x: at.dst_x as i32,
                y: at.dst_y as i32,
                w: geometry.width as u32,
                h: geometry.height as u32,
            });
        }
        None
    }

    fn wait_size(&self, class: &str, w: u32, h: u32) -> Placed {
        let mut last = None;
        let found = wait_until(WAIT, || {
            last = self.find(class);
            last.is_some_and(|p| p.w == w && p.h == h)
        });
        assert!(found, "window {w}x{h} expected, found {last:?}");
        // Let the viewer present after the resize.
        thread::sleep(Duration::from_millis(300));
        last.unwrap()
    }

    fn shot(&mut self) -> Frame {
        self.capture.snapshot().unwrap()
    }

    fn input(&self, kind: u8, detail: u8, x: i16, y: i16) {
        self.conn
            .xtest_fake_input(kind, detail, 0, self.root, x, y, 0)
            .unwrap();
        self.conn.get_input_focus().unwrap().reply().unwrap();
    }

    fn move_to(&self, x: i32, y: i32) {
        self.input(6, 0, x as i16, y as i16);
    }

    fn click(&self, x: i32, y: i32) {
        self.move_to(x, y);
        thread::sleep(Duration::from_millis(50));
        self.input(4, 1, 0, 0);
        self.input(5, 1, 0, 0);
    }

    /// Gives the window keyboard focus, as a window manager would after a
    /// click. The viewer never asks for focus itself.
    fn focus(&self, window: Placed) {
        self.conn
            .set_input_focus(InputFocus::PARENT, window.id, x11rb::CURRENT_TIME)
            .unwrap();
        self.conn.get_input_focus().unwrap().reply().unwrap();
    }

    fn press_escape(&self) {
        let setup = self.conn.setup();
        let (min, max) = (setup.min_keycode, setup.max_keycode);
        let map = self
            .conn
            .get_keyboard_mapping(min, max - min + 1)
            .unwrap()
            .reply()
            .unwrap();
        let per = map.keysyms_per_keycode as usize;
        let index = map
            .keysyms
            .iter()
            .position(|&k| k == 0xff1b)
            .expect("Escape keysym");
        let keycode = min + (index / per) as u8;
        self.input(2, keycode, 0, 0);
        self.input(3, keycode, 0, 0);
    }
}

fn at(frame: &Frame, window: Placed, x: u32, y: u32) -> u32 {
    frame.pixel(window.x as u32 + x, window.y as u32 + y)
}

fn assert_near(frame: &Frame, window: Placed, x: u32, y: u32, want: u32, what: &str) {
    let got = at(frame, window, x, y);
    assert!(
        near(got, want, 12),
        "{what} at {x},{y}: got {got:06x}, want {want:06x}"
    );
}

fn save(frame: &Frame, window: Placed, name: &str) {
    let Some(dir) = std::env::var_os("PICKFORGE_VIEWER_SCREENSHOTS") else {
        return;
    };
    let dir = std::path::PathBuf::from(dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut rgb = Vec::with_capacity((window.w * window.h * 3) as usize);
    for y in 0..window.h {
        for x in 0..window.w {
            let p = at(frame, window, x, y);
            rgb.extend_from_slice(&[(p >> 16) as u8, (p >> 8) as u8, p as u8]);
        }
    }
    image::save_buffer(
        dir.join(name),
        &rgb,
        window.w,
        window.h,
        image::ExtendedColorType::Rgb8,
    )
    .unwrap();
}

/// A session with a known picture: blue top, yellow bottom, a white square.
fn paint_session(session: &Xvfb) -> Painter {
    let painter = Painter::new(session.display, 0, 0, 640, 480, BLUE);
    painter.fill(0, 240, 640, 240, YELLOW);
    painter.fill(40, 40, 80, 80, WHITE);
    painter
}

#[test]
fn watches_a_session_then_shows_session_end() {
    if !xvfb_ready("watches_a_session") {
        return;
    }
    let mut session = Xvfb::start("640x480x24");
    let host = Xvfb::start("1280x1024x24");
    let painter = paint_session(&session);
    let class = "pickforge-viewer-smoke";
    let mut viewer = Viewer::spawn(&session, host.display, class, "self", "1");

    let ready = viewer.expect("ready");
    assert_eq!(ready["backend"], "x11");
    assert_eq!(ready["pid"], viewer.child.id());
    assert_eq!(ready["scale"], 1.0);
    assert_eq!(ready["version"], env!("CARGO_PKG_VERSION"));

    let mut screen = Screen::new(host.display);
    let thumb = screen.wait_size(class, 384, 288);
    let shot = screen.shot();
    assert_near(&shot, thumb, 300, 60, BLUE, "top half");
    assert_near(&shot, thumb, 300, 230, YELLOW, "bottom half");
    assert_near(&shot, thumb, 48, 48, WHITE, "white square");
    save(&shot, thumb, "thumbnail.png");

    // Drawing in the session reaches the window.
    painter.fill(400, 300, 100, 100, RED);
    assert!(
        wait_until(WAIT, || near(at(&screen.shot(), thumb, 270, 210), RED, 12)),
        "live update"
    );

    // A click expands the window to the session size plus the bar.
    screen.click(thumb.x + 300, thumb.y + 100);
    assert_eq!(viewer.expect("mode")["mode"], "expanded");
    let expanded = screen.wait_size(class, 640, 512);
    let shot = screen.shot();
    assert_eq!(at(&shot, expanded, 4, 4), BAR, "bar color");
    assert_near(&shot, expanded, 320, 32 + 100, BLUE, "image below the bar");
    assert_near(&shot, expanded, 450, 32 + 350, RED, "live content");

    // Hovering a button changes its look.
    let close = (expanded.w - 4 - 12, 16);
    let plain = at(&shot, expanded, close.0 - 9, close.1);
    screen.move_to(expanded.x + close.0 as i32, expanded.y + close.1 as i32);
    assert!(
        wait_until(WAIT, || at(&screen.shot(), expanded, close.0 - 9, close.1)
            != plain),
        "hover state"
    );
    save(&screen.shot(), expanded, "expanded.png");
    screen.move_to(expanded.x + 300, expanded.y + 200);

    // The session ends: the last frame stays and the status shows it.
    let pill = (24, 512 - 20);
    assert_near(
        &screen.shot(),
        expanded,
        pill.0,
        pill.1,
        YELLOW,
        "before the status",
    );
    session.stop();
    assert_eq!(viewer.expect("sessionEnded")["reason"], "x11-eof");
    assert!(
        wait_until(WAIT, || !near(
            at(&screen.shot(), expanded, pill.0, pill.1),
            YELLOW,
            40
        )),
        "status pill"
    );
    let shot = screen.shot();
    assert_near(&shot, expanded, 320, 32 + 100, BLUE, "last frame kept");
    save(&shot, expanded, "session-ended.png");

    // End of file on stdin exits within one second.
    let start = Instant::now();
    drop(viewer.stdin.take());
    assert_eq!(viewer.wait_exit(Duration::from_secs(3)), Some(0));
    let took = start.elapsed();
    assert!(took < Duration::from_secs(1), "exit took {took:?}");
}

#[test]
fn host_placement_asks_before_resizing() {
    if !xvfb_ready("host_placement") {
        return;
    }
    let session = Xvfb::start("640x480x24");
    let host = Xvfb::start("1280x1024x24");
    let _painter = paint_session(&session);
    let class = "pickforge-viewer-host";
    let mut viewer = Viewer::spawn(&session, host.display, class, "host", "1");
    viewer.expect("ready");
    let screen = Screen::new(host.display);
    let thumb = screen.wait_size(class, 384, 288);

    screen.click(thumb.x + 200, thumb.y + 100);
    viewer.expect("expandRequested");
    viewer.expect_quiet(Duration::from_millis(300));
    assert_eq!(screen.find(class).map(|p| (p.w, p.h)), Some((384, 288)));

    viewer.send(r#"{"cmd":"setMode","mode":"expanded","width":500,"height":407,"note":"extra"}"#);
    assert_eq!(viewer.expect("mode")["mode"], "expanded");
    let expanded = screen.wait_size(class, 500, 407);

    // Unknown and malformed lines are ignored.
    viewer.send(r#"{"cmd":"attention","message":"later"}"#);
    viewer.send("not json");
    viewer.send(r#"{"cmd":"status","code":"stopping"}"#);

    // Esc collapses in watch mode.
    screen.focus(expanded);
    thread::sleep(Duration::from_millis(100));
    screen.press_escape();
    viewer.expect("collapseRequested");

    viewer.send(r#"{"cmd":"setMode","mode":"thumbnail"}"#);
    assert_eq!(viewer.expect("mode")["mode"], "thumbnail");
    screen.wait_size(class, 384, 288);

    viewer.send(r#"{"cmd":"shutdown"}"#);
    assert_eq!(viewer.wait_exit(Duration::from_secs(3)), Some(0));
}

#[test]
fn close_button_reports_closed_and_exits() {
    if !xvfb_ready("close_button") {
        return;
    }
    let session = Xvfb::start("640x480x24");
    let host = Xvfb::start("1280x1024x24");
    let _painter = paint_session(&session);
    let class = "pickforge-viewer-close";
    let mut viewer = Viewer::spawn(&session, host.display, class, "self", "1");
    viewer.expect("ready");
    let screen = Screen::new(host.display);
    let thumb = screen.wait_size(class, 384, 288);
    screen.click(thumb.x + 200, thumb.y + 100);
    viewer.expect("mode");
    let expanded = screen.wait_size(class, 640, 512);
    screen.click(expanded.x + 640 - 4 - 12, expanded.y + 16);
    viewer.expect("closed");
    assert_eq!(viewer.wait_exit(Duration::from_secs(3)), Some(0));
}

#[test]
fn scales_with_the_host_scale_factor() {
    if !xvfb_ready("hidpi") {
        return;
    }
    let session = Xvfb::start("640x480x24");
    let host = Xvfb::start("2560x1600x24");
    let _painter = paint_session(&session);
    let class = "pickforge-viewer-hidpi";
    let viewer = Viewer::spawn(&session, host.display, class, "self", "2");
    assert_eq!(viewer.expect("ready")["scale"], 2.0);
    let mut screen = Screen::new(host.display);
    let thumb = screen.wait_size(class, 768, 576);
    save(&screen.shot(), thumb, "thumbnail-2x.png");
    screen.click(thumb.x + 600, thumb.y + 200);
    viewer.expect("mode");
    let expanded = screen.wait_size(class, 1280, 1024);
    let shot = screen.shot();
    assert_eq!(at(&shot, expanded, 8, 8), BAR, "bar color");
    assert_eq!(at(&shot, expanded, 8, 60), BAR, "bar is 64 px");
    assert_near(&shot, expanded, 8, 66, BLUE, "image starts below the bar");
    assert_near(&shot, expanded, 640, 64 + 200, BLUE, "upscaled image");
    save(&shot, expanded, "expanded-2x.png");
}
