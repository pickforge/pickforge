//! The real viewer binary under test: it watches one Xvfb and opens its
//! window on a second Xvfb, so no window ever reaches the host desktop.
//! Set `PICKFORGE_VIEWER_SCREENSHOTS=<dir>` to save PNG captures.

#![allow(dead_code)]

use super::common::{near, wait_until, Painter, Xvfb};
use pickforge_viewer::capture::{connect_display, Capture, Frame};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    AtomEnum, ClientMessageEvent, ConnectionExt as _, EventMask, InputFocus, MapState,
};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;

pub const BLUE: u32 = 0x0024_58c8;
pub const YELLOW: u32 = 0x00e0_c040;
pub const WHITE: u32 = 0x00ff_ffff;
pub const RED: u32 = 0x00d0_2020;
/// `--color-surface-1`, the bar.
pub const BAR: u32 = 0x000f_0f11;
pub const WAIT: Duration = Duration::from_secs(10);

pub struct Viewer {
    pub child: Child,
    pub stdin: Option<ChildStdin>,
    pub events: Receiver<Value>,
}

impl Viewer {
    pub fn spawn(
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
    pub fn expect(&self, name: &str) -> Value {
        match self.events.recv_timeout(WAIT) {
            Ok(event) if event["event"] == name => event,
            Ok(event) => panic!("expected {name}, got {event}"),
            Err(_) => panic!("no {name} event"),
        }
    }

    pub fn expect_quiet(&self, wait: Duration) {
        if let Ok(event) = self.events.recv_timeout(wait) {
            panic!("unexpected event {event}");
        }
    }

    pub fn send(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().unwrap();
        writeln!(stdin, "{line}").unwrap();
        stdin.flush().unwrap();
    }

    pub fn wait_exit(&mut self, timeout: Duration) -> Option<i32> {
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
pub struct Placed {
    pub id: u32,
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// The display that hosts the viewer window.
pub struct Screen {
    pub conn: RustConnection,
    pub root: u32,
    pub capture: Capture,
}

impl Screen {
    pub fn new(display: u32) -> Screen {
        let conn = connect_display(display).unwrap();
        let root = conn.setup().roots[0].root;
        Screen {
            conn,
            root,
            capture: Capture::connect(display).unwrap(),
        }
    }

    /// The mapped window whose WM_CLASS holds `class`.
    pub fn find(&self, class: &str) -> Option<Placed> {
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

    pub fn wait_size(&self, class: &str, w: u32, h: u32) -> Placed {
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

    pub fn shot(&mut self) -> Frame {
        self.capture.snapshot().unwrap()
    }

    pub fn input(&self, kind: u8, detail: u8, x: i16, y: i16) {
        self.conn
            .xtest_fake_input(kind, detail, 0, self.root, x, y, 0)
            .unwrap();
        self.conn.get_input_focus().unwrap().reply().unwrap();
    }

    pub fn move_to(&self, x: i32, y: i32) {
        self.input(6, 0, x as i16, y as i16);
    }

    pub fn click(&self, x: i32, y: i32) {
        self.move_to(x, y);
        thread::sleep(Duration::from_millis(50));
        self.input(4, 1, 0, 0);
        self.input(5, 1, 0, 0);
    }

    /// Gives the window keyboard focus, as a window manager would after a
    /// click. The viewer never asks for focus itself.
    pub fn focus(&self, window: Placed) {
        self.conn
            .set_input_focus(InputFocus::PARENT, window.id, x11rb::CURRENT_TIME)
            .unwrap();
        self.conn.get_input_focus().unwrap().reply().unwrap();
    }

    /// The first keycode that carries `keysym` in the core map.
    pub fn keycode(&self, keysym: u32) -> u8 {
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
            .position(|&k| k == keysym)
            .unwrap_or_else(|| panic!("keysym {keysym:#x}"));
        min + (index / per) as u8
    }

    pub fn key(&self, keysym: u32, pressed: bool) {
        let keycode = self.keycode(keysym);
        self.input(if pressed { 2 } else { 3 }, keycode, 0, 0);
    }

    pub fn press_escape(&self) {
        self.key(0xff1b, true);
        self.key(0xff1b, false);
    }

    pub fn button(&self, button: u8, pressed: bool) {
        self.input(if pressed { 4 } else { 5 }, button, 0, 0);
    }

    /// Takes keyboard focus away from every window.
    pub fn unfocus(&self) {
        self.conn
            .set_input_focus(InputFocus::NONE, x11rb::NONE, x11rb::CURRENT_TIME)
            .unwrap();
        self.conn.get_input_focus().unwrap().reply().unwrap();
    }

    /// Asks the window to close, as a window manager does.
    pub fn close(&self, window: Placed) {
        let atom = |name: &[u8]| {
            self.conn
                .intern_atom(false, name)
                .unwrap()
                .reply()
                .unwrap()
                .atom
        };
        let (protocols, delete) = (atom(b"WM_PROTOCOLS"), atom(b"WM_DELETE_WINDOW"));
        let event = ClientMessageEvent::new(32, window.id, protocols, [delete, 0, 0, 0, 0]);
        self.conn
            .send_event(false, window.id, EventMask::NO_EVENT, event)
            .unwrap();
        self.conn.get_input_focus().unwrap().reply().unwrap();
    }
}

pub fn at(frame: &Frame, window: Placed, x: u32, y: u32) -> u32 {
    frame.pixel(window.x as u32 + x, window.y as u32 + y)
}

pub fn assert_near(frame: &Frame, window: Placed, x: u32, y: u32, want: u32, what: &str) {
    let got = at(frame, window, x, y);
    assert!(
        near(got, want, 12),
        "{what} at {x},{y}: got {got:06x}, want {want:06x}"
    );
}

pub fn save(frame: &Frame, window: Placed, name: &str) {
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
pub fn paint_session(session: &Xvfb) -> Painter {
    let painter = Painter::new(session.display, 0, 0, 640, 480, BLUE);
    painter.fill(0, 240, 640, 240, YELLOW);
    painter.fill(40, 40, 80, 80, WHITE);
    painter
}
