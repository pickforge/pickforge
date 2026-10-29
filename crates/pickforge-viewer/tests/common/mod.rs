//! Test Xvfb servers on explicit free displays, and an X client to draw
//! on them. Tests skip when Xvfb is missing, unless
//! `PICKFORGE_REQUIRE_XVFB=1`.

#![allow(dead_code)]

use pickforge_viewer::capture::connect_display;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    ChangeGCAux, ConnectionExt as _, CreateGCAux, CreateWindowAux, Gcontext, Rectangle, Window,
    WindowClass,
};
use x11rb::rust_connection::RustConnection;

const DISPLAY_MIN: u32 = 10000;
const DISPLAY_MAX: u32 = 50000;

pub fn on_path(program: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(program).is_file()))
        .unwrap_or(false)
}

/// True when Xvfb tests should run. Panics when they must run and cannot.
pub fn xvfb_ready(test: &str) -> bool {
    if on_path("Xvfb") {
        return true;
    }
    if std::env::var("PICKFORGE_REQUIRE_XVFB").as_deref() == Ok("1") {
        panic!("{test}: Xvfb is not on PATH and PICKFORGE_REQUIRE_XVFB=1");
    }
    eprintln!("{test}: skipped, Xvfb is not on PATH");
    false
}

fn random_display() -> u32 {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    let mut x = nanos
        ^ std::process::id().rotate_left(16)
        ^ COUNTER.fetch_add(0x9e37_79b9, Ordering::Relaxed);
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    DISPLAY_MIN + x % (DISPLAY_MAX - DISPLAY_MIN)
}

fn display_unused(display: u32) -> bool {
    !Path::new(&format!("/tmp/.X{display}-lock")).exists()
        && !Path::new(&format!("/tmp/.X11-unix/X{display}")).exists()
}

/// A display number that no lock file or socket claims now.
pub fn unused_display() -> u32 {
    for _ in 0..200 {
        let display = random_display();
        if display_unused(display) {
            return display;
        }
    }
    panic!("no unused X display found");
}

pub struct Xvfb {
    pub display: u32,
    pub pid: u32,
    pub start_ticks: u64,
    child: Option<Child>,
}

impl Xvfb {
    /// Starts `Xvfb :<n> -screen 0 <screen> -nolisten tcp -noreset` on a
    /// free explicit display and waits until it accepts clients.
    pub fn start(screen: &str) -> Xvfb {
        for _ in 0..5 {
            let display = unused_display();
            let mut child = Command::new("Xvfb")
                .arg(format!(":{display}"))
                .args(["-screen", "0", screen, "-nolisten", "tcp", "-noreset"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn Xvfb");
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if let Ok(Some(_)) = child.try_wait() {
                    // Another server won the race for this number.
                    break;
                }
                if connect_display(display).is_ok() {
                    let pid = child.id();
                    let start_ticks = pickforge_viewer::procstat::read_start_ticks(pid)
                        .expect("Xvfb start ticks");
                    return Xvfb {
                        display,
                        pid,
                        start_ticks,
                        child: Some(child),
                    };
                }
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        panic!("Xvfb did not start");
    }

    /// Stops the server with SIGTERM so it removes its lock file.
    pub fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            unsafe {
                libc::kill(child.id() as i32, libc::SIGTERM);
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                if let Ok(Some(_)) = child.try_wait() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for Xvfb {
    fn drop(&mut self) {
        self.stop();
    }
}

/// An X client that draws on a test display.
pub struct Painter {
    pub conn: RustConnection,
    pub root: Window,
    pub window: Window,
    gc: Gcontext,
}

impl Painter {
    /// Maps a window at `(x, y)` of `w` by `h` with a solid background.
    pub fn new(display: u32, x: i16, y: i16, w: u16, h: u16, background: u32) -> Painter {
        let conn = connect_display(display).expect("connect painter");
        let screen = &conn.setup().roots[0];
        let root = screen.root;
        let window = conn.generate_id().unwrap();
        conn.create_window(
            0,
            window,
            root,
            x,
            y,
            w,
            h,
            0,
            WindowClass::INPUT_OUTPUT,
            0,
            &CreateWindowAux::new()
                .background_pixel(background)
                .override_redirect(1),
        )
        .unwrap();
        conn.map_window(window).unwrap();
        let gc = conn.generate_id().unwrap();
        conn.create_gc(
            gc,
            window,
            &CreateGCAux::new()
                .foreground(background)
                .graphics_exposures(0),
        )
        .unwrap();
        let painter = Painter {
            conn,
            root,
            window,
            gc,
        };
        painter.sync();
        painter
    }

    pub fn fill(&self, x: i16, y: i16, w: u16, h: u16, color: u32) {
        self.conn
            .change_gc(self.gc, &ChangeGCAux::new().foreground(color))
            .unwrap();
        self.conn
            .poly_fill_rectangle(
                self.window,
                self.gc,
                &[Rectangle {
                    x,
                    y,
                    width: w,
                    height: h,
                }],
            )
            .unwrap();
        self.sync();
    }

    /// Waits until the server has handled every request so far.
    pub fn sync(&self) {
        self.conn.get_input_focus().unwrap().reply().unwrap();
    }
}

/// Polls `check` until it returns true or `timeout` passes.
pub fn wait_until(timeout: Duration, mut check: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if check() {
            return true;
        }
        if Instant::now() > deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// True when every channel of two `0x00RRGGBB` colors is within `tolerance`.
pub fn near(a: u32, b: u32, tolerance: u32) -> bool {
    [16, 8, 0]
        .iter()
        .all(|&shift| ((a >> shift) & 0xff).abs_diff((b >> shift) & 0xff) <= tolerance)
}
