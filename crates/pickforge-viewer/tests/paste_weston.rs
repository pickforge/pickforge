//! Paste through the viewer window's own data device, on a Wayland
//! compositor without data-control. Weston runs nested in a private Xvfb
//! with a private runtime directory and socket, so no client reaches the
//! host desktop or its clipboard. The test skips when Xvfb, weston,
//! wl-copy or wl-paste is missing, unless `PICKFORGE_REQUIRE_WESTON=1`.

#![cfg(target_os = "linux")]

mod common;
#[path = "common/listener.rs"]
mod listener;
#[path = "common/viewer.rs"]
mod viewer;

use common::{on_path, wait_until, Xvfb};
use listener::{Listener, QUIET};
use pickforge_viewer::data_device::has_data_control;
use pickforge_viewer::input::MAX_TEXT_CHARS;
use std::io::Write;
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use viewer::*;
use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::wl_registry::{self, WlRegistry};
use wayland_client::{Connection, Dispatch, QueueHandle};

/// Clipboard text that must reach the session and nothing else.
const MARKER: &str = "marker-91d4";
const CLASS: &str = "pickforge-viewer-weston";

/// True when the test should run. Panics when it must run and cannot.
fn weston_ready(test: &str) -> bool {
    let missing: Vec<&str> = ["Xvfb", "weston", "wl-copy", "wl-paste"]
        .into_iter()
        .filter(|program| !on_path(program))
        .collect();
    if missing.is_empty() {
        return true;
    }
    if std::env::var("PICKFORGE_REQUIRE_WESTON").as_deref() == Ok("1") {
        panic!("{test}: {missing:?} not on PATH and PICKFORGE_REQUIRE_WESTON=1");
    }
    eprintln!("{test}: skipped, {missing:?} not on PATH");
    false
}

/// Weston with its x11 backend and kiosk shell inside a private Xvfb. The
/// kiosk shell shows the newest window full size at the output origin.
struct Weston {
    child: Child,
    dir: PathBuf,
    socket: String,
    /// The process that owns the selection.
    owner: Option<Child>,
}

impl Weston {
    fn start(host: &Xvfb) -> Weston {
        let dir = std::env::temp_dir().join(format!("pickforge-weston-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        let socket = format!("pf-weston-{}", std::process::id());
        let child = Command::new("weston")
            .args([
                "--backend=x11",
                "--renderer=pixman",
                "--shell=kiosk-shell.so",
            ])
            .args([
                "--no-config",
                "--idle-time=0",
                "--width=1200",
                "--height=900",
            ])
            .arg(format!("--socket={socket}"))
            .arg(format!("--log={}", dir.join("weston.log").display()))
            .env_remove("WAYLAND_DISPLAY")
            .env_remove("WAYLAND_SOCKET")
            .env("DISPLAY", format!(":{}", host.display))
            .env("XAUTHORITY", "/dev/null")
            .env("XDG_RUNTIME_DIR", &dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn weston");
        let weston = Weston {
            child,
            dir,
            socket,
            owner: None,
        };
        let path = weston.dir.join(&weston.socket);
        let up = wait_until(WAIT, || UnixStream::connect(&path).is_ok());
        assert!(up, "weston did not listen on {path:?}");
        weston
    }

    /// The interface names of the compositor's globals.
    fn globals(&self) -> Vec<String> {
        let stream = UnixStream::connect(self.dir.join(&self.socket)).unwrap();
        let conn = Connection::from_socket(stream).unwrap();
        let (globals, _queue) = registry_queue_init::<Globals>(&conn).unwrap();
        globals
            .contents()
            .with_list(|list| list.iter().map(|g| g.interface.clone()).collect())
    }

    fn client(&self, program: &str) -> Command {
        let mut command = Command::new(program);
        command
            .env_remove("WAYLAND_SOCKET")
            .env_remove("DISPLAY")
            .env("XDG_RUNTIME_DIR", &self.dir)
            .env("WAYLAND_DISPLAY", &self.socket);
        command
    }

    /// Sets the selection from a second client and waits until another
    /// client sees `mime` offered.
    fn copy(&mut self, mime: &str, bytes: &[u8]) {
        self.drop_owner();
        let mut owner = self
            .client("wl-copy")
            .args(["--foreground", "--type", mime])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn wl-copy");
        owner.stdin.take().unwrap().write_all(bytes).unwrap();
        self.owner = Some(owner);
        let offered = wait_until(WAIT, || {
            let out = self
                .client("wl-paste")
                .arg("--list-types")
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .any(|l| l == mime)
        });
        assert!(offered, "{mime} is not offered");
    }

    fn drop_owner(&mut self) {
        if let Some(mut owner) = self.owner.take() {
            let _ = owner.kill();
            let _ = owner.wait();
        }
    }
}

impl Drop for Weston {
    fn drop(&mut self) {
        self.drop_owner();
        unsafe {
            libc::kill(self.child.id() as i32, libc::SIGTERM);
        }
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

struct Globals;

impl Dispatch<WlRegistry, GlobalListContents> for Globals {
    fn event(
        _: &mut Self,
        _: &WlRegistry,
        _: wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

/// Clicks Paste and returns what reached the session. A refused paste
/// gets the full read time to type nothing.
fn paste(screen: &mut Screen, listener: &mut Listener, window: Placed, want: &str) -> String {
    let (x, y) = paste_point(screen, window);
    listener.take_quiet();
    screen.click(window.x + x as i32, window.y + y as i32);
    wait_until(Duration::from_millis(1500), || {
        listener.poll();
        !want.is_empty() && listener.decode(&listener.presses()) == want
    });
    std::thread::sleep(QUIET);
    listener.poll();
    listener.decode(&listener.presses())
}

#[test]
fn paste_reads_the_selection_through_the_window_data_device() {
    if !weston_ready("paste_weston") {
        return;
    }
    let session = Xvfb::start("640x480x24");
    let host = Xvfb::start("1280x1024x24");
    let mut weston = Weston::start(&host);
    let globals = weston.globals();
    assert!(globals.iter().any(|g| g == "wl_data_device_manager"));
    assert!(
        !has_data_control(globals.iter().map(String::as_str)),
        "weston offers data-control: {globals:?}"
    );

    let mut listener = Listener::new(session.display);
    let mut viewer = Viewer::spawn_wayland(&session, &weston.dir, &weston.socket, CLASS);
    assert_eq!(viewer.expect("ready")["backend"], "wayland");
    viewer.send(r#"{"cmd":"control","state":"granted","leaseId":"L1","grantMs":60000}"#);
    assert_eq!(viewer.expect("controlAck")["state"], "granted");
    assert_eq!(viewer.expect("mode")["mode"], "expanded");
    let mut screen = Screen::new(host.display);
    let window = Placed {
        id: 0,
        x: 0,
        y: 0,
        w: 1200,
        h: 900,
    };

    // No selection, an image only, and too long a text type nothing.
    assert_eq!(paste(&mut screen, &mut listener, window, ""), "");
    weston.copy("image/png", b"\x89PNG\r\n\x1a\n");
    assert_eq!(paste(&mut screen, &mut listener, window, ""), "");
    weston.copy("text/plain", "a".repeat(MAX_TEXT_CHARS + 1).as_bytes());
    assert_eq!(paste(&mut screen, &mut listener, window, ""), "");

    // One trailing line break is dropped; the tab is a Tab key.
    let text = format!("Olá ß €\t{MARKER}\n");
    weston.copy("text/plain;charset=utf-8", text.as_bytes());
    let want = format!("Olá ß €<Tab>{MARKER}");
    assert_eq!(paste(&mut screen, &mut listener, window, &want), want);
    assert_eq!(listener.settled_state(), (Vec::new(), 0), "held input");

    viewer.expect_quiet(Duration::from_millis(300));
    let output = viewer.output.lock().unwrap().clone();
    assert!(!output.contains(MARKER), "the text reached viewer output");
}
