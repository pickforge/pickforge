//! Take control through the real viewer on two Xvfb servers. Keys and
//! clicks go to the viewer window on the host Xvfb; a listener window on
//! the session Xvfb records what arrives. Covers invariants I1 (no input
//! without a live grant) and I4 (nothing stays held after any end).

#![cfg(target_os = "linux")]

mod common;
#[path = "common/listener.rs"]
mod listener;
#[path = "common/selection.rs"]
mod selection;
#[path = "common/viewer.rs"]
mod viewer;

use common::{near, wait_until, xvfb_ready, Xvfb};
use listener::Listener;
use selection::{selection_owner, Owner, Serve};
use std::thread;
use std::time::{Duration, Instant};
use viewer::*;
use x11rb::protocol::Event;

const SHIFT_L: u32 = 0xffe1;
const KEY_A: u32 = 0x61;
const KEY_B: u32 = 0x62;
const EMBER: u32 = 0x00ff_7a1a;
/// Clipboard text that must reach the session and nothing else.
const MARKER: &str = "marker-5e2a";
const LONG_MESSAGE: &str = "O agente precisa que você entre na conta do banco com a sua senha e confirme o código que chegou por SMS no seu celular. Depois volte o controle para o agente continuar a tarefa de conciliação das faturas abertas deste mês, sem fechar a janela do navegador nem trocar de aba enquanto a página carrega.";

struct Rig {
    _session: Xvfb,
    _host: Xvfb,
    listener: Listener,
    screen: Screen,
    viewer: Viewer,
    window: Placed,
}

impl Rig {
    /// A viewer in thumbnail mode over a session with a focused listener.
    fn start(class: &str, placement: &str) -> Rig {
        let session = Xvfb::start("640x480x24");
        let host = Xvfb::start("1280x1024x24");
        let listener = Listener::new(session.display);
        let viewer = Viewer::spawn(&session, host.display, class, placement, "1");
        viewer.expect("ready");
        let screen = Screen::new(host.display);
        let window = screen.wait_size(class, 384, 288);
        Rig {
            _session: session,
            _host: host,
            listener,
            screen,
            viewer,
            window,
        }
    }

    /// Grants control from the thumbnail; the viewer expands itself.
    fn start_controlling(class: &str) -> Rig {
        let mut rig = Rig::start(class, "self");
        rig.grant("L1", 10_000);
        assert_eq!(rig.viewer.expect("mode")["mode"], "expanded");
        rig.window = rig.screen.wait_size(class, 640, 512);
        rig.screen.focus(rig.window);
        rig
    }

    fn grant(&mut self, lease: &str, grant_ms: u64) {
        self.viewer.send(&format!(
            r#"{{"cmd":"control","state":"granted","leaseId":"{lease}","grantMs":{grant_ms}}}"#
        ));
        let ack = self.viewer.expect("controlAck");
        assert_eq!(
            (ack["leaseId"].as_str(), ack["state"].as_str()),
            (Some(lease), Some("granted"))
        );
    }

    fn revoke(&mut self, lease: &str, reason: &str) {
        self.viewer.send(&format!(
            r#"{{"cmd":"control","state":"revoked","leaseId":"{lease}","reason":"{reason}"}}"#
        ));
        let ack = self.viewer.expect("controlAck");
        assert_eq!(
            (ack["leaseId"].as_str(), ack["state"].as_str()),
            (Some(lease), Some("revoked"))
        );
    }

    /// A point in the session image of the expanded window.
    fn image_point(&self) -> (i32, i32) {
        (self.window.x + 320, self.window.y + 32 + 240)
    }

    /// Holds Shift and the left button on the host, and waits until the
    /// session holds them too.
    fn hold(&mut self) {
        let (x, y) = self.image_point();
        self.screen.move_to(x, y);
        thread::sleep(Duration::from_millis(50));
        self.screen.key(SHIFT_L, true);
        self.screen.button(1, true);
        let held = wait_until(WAIT, || {
            !self.listener.down_keys().is_empty() && self.listener.buttons_down() != 0
        });
        assert!(held, "the session holds Shift and button 1");
    }

    /// Lets go of the host keys and button after the viewer let go.
    fn release_host(&mut self) {
        self.screen.key(SHIFT_L, false);
        self.screen.button(1, false);
    }

    fn assert_released(&self) {
        assert_eq!(self.listener.settled_state(), (Vec::new(), 0), "held input");
    }

    /// Types `a` and clicks in the image, and checks nothing reaches the
    /// session.
    fn assert_no_input(&mut self) {
        self.listener.take_quiet();
        self.screen.key(KEY_A, true);
        self.screen.key(KEY_A, false);
        let (x, y) = self.image_point();
        self.screen.click(x, y);
        let presses: Vec<Event> = self
            .listener
            .take_quiet()
            .into_iter()
            .filter(|e| matches!(e, Event::KeyPress(_) | Event::ButtonPress(_)))
            .collect();
        assert!(presses.is_empty(), "input reached the session: {presses:?}");
    }

    /// Paste in the control bar, relative to the window: the bar's middle
    /// row, just right of Return control's ember outline.
    fn paste_point(&mut self) -> (u32, u32) {
        let window = self.window;
        let mut shot = self.screen.shot();
        wait_until(WAIT, || {
            shot = self.screen.shot();
            near(at(&shot, window, 320, 31), EMBER, 12)
        });
        let right = (0..300)
            .rev()
            .find(|&x| near(at(&shot, window, x, 16), EMBER, 60))
            .expect("Return control");
        (right + 4 + 24, 16)
    }

    fn click_paste(&mut self) {
        let (x, y) = self.paste_point();
        self.screen
            .click(self.window.x + x as i32, self.window.y + y as i32);
    }

    /// Key presses that reached the session since the last call, once no
    /// more arrive.
    fn presses_until_quiet(&mut self) -> usize {
        let mut total = 0;
        loop {
            let presses = self
                .listener
                .take_quiet()
                .into_iter()
                .filter(|e| matches!(e, Event::KeyPress(_)))
                .count();
            if presses == 0 {
                return total;
            }
            total += presses;
        }
    }

    fn assert_types(&mut self, keysym: u32, text: &str) {
        self.listener.take_quiet();
        self.screen.key(keysym, true);
        self.screen.key(keysym, false);
        let presses = self.listener.key_presses(1);
        assert_eq!(self.listener.decode(&presses), text);
    }
}

#[test]
fn revoke_expiry_focus_loss_and_session_end_release_input() {
    if !xvfb_ready("control_end_reasons") {
        return;
    }
    let mut rig = Rig::start_controlling("pickforge-viewer-control");

    // Text and every key, Esc too, reach the session.
    rig.assert_types(KEY_A, "a");
    rig.listener.take_quiet();
    rig.screen.press_escape();
    let presses = rig.listener.key_presses(1);
    assert_eq!(rig.listener.decode(&presses), "<Escape>");
    rig.viewer.expect_quiet(Duration::from_millis(200));

    // Revoke.
    rig.hold();
    rig.revoke("L1", "returned");
    rig.assert_released();
    rig.release_host();
    rig.assert_no_input();

    // Expiry without renewal.
    rig.grant("L2", 1500);
    rig.hold();
    rig.assert_released();
    rig.release_host();
    rig.assert_no_input();
    rig.viewer.expect_quiet(Duration::from_millis(100));

    // A renewal keeps control past the first grant's end.
    rig.grant("L3", 1500);
    thread::sleep(Duration::from_millis(1000));
    rig.grant("L3", 10_000);
    thread::sleep(Duration::from_millis(1000));
    rig.assert_types(KEY_B, "b");

    // Focus loss releases held input but keeps control.
    rig.hold();
    rig.screen.unfocus();
    rig.assert_released();
    rig.release_host();
    rig.screen.focus(rig.window);
    thread::sleep(Duration::from_millis(100));
    rig.assert_types(KEY_A, "a");

    // Unavailable answers with an empty lease id and ends nothing new.
    rig.revoke("", "unavailable");
    rig.assert_no_input();

    // The host reports the session end.
    rig.grant("L4", 10_000);
    rig.hold();
    rig.viewer.send(r#"{"cmd":"sessionEnded"}"#);
    rig.assert_released();
    rig.release_host();
    rig.assert_no_input();
    // A grant after the session ended is ignored.
    rig.viewer
        .send(r#"{"cmd":"control","state":"granted","leaseId":"L5","grantMs":10000}"#);
    rig.viewer.expect_quiet(Duration::from_millis(300));
    rig.assert_no_input();
}

#[test]
fn return_control_releases_before_asking() {
    if !xvfb_ready("control_return") {
        return;
    }
    let mut rig = Rig::start_controlling("pickforge-viewer-return");
    rig.hold();
    // The button release goes to the session; Shift stays held.
    rig.screen.button(1, false);
    assert!(wait_until(WAIT, || rig.listener.buttons_down() == 0));
    // Return control sits at the left of the bar.
    rig.screen.click(rig.window.x + 40, rig.window.y + 16);
    assert_eq!(rig.viewer.expect("returnRequested")["reason"], "button");
    rig.assert_released();
    rig.screen.key(SHIFT_L, false);
    rig.assert_no_input();
    rig.revoke("L1", "returned");
}

#[test]
fn closing_while_controlling_returns_then_closes() {
    if !xvfb_ready("control_close") {
        return;
    }
    let mut rig = Rig::start_controlling("pickforge-viewer-control-close");
    rig.hold();
    rig.screen.close(rig.window);
    assert_eq!(rig.viewer.expect("returnRequested")["reason"], "closed");
    rig.viewer.expect("closed");
    assert_eq!(rig.viewer.wait_exit(Duration::from_secs(3)), Some(0));
    rig.assert_released();
}

#[test]
fn stdin_end_of_file_releases_input() {
    if !xvfb_ready("control_stdin_eof") {
        return;
    }
    let mut rig = Rig::start_controlling("pickforge-viewer-control-eof");
    rig.hold();
    let start = Instant::now();
    drop(rig.viewer.stdin.take());
    assert_eq!(rig.viewer.wait_exit(Duration::from_secs(3)), Some(0));
    assert!(start.elapsed() < Duration::from_secs(1));
    rig.assert_released();
}

#[test]
fn thumbnail_and_letterbox_never_forward() {
    if !xvfb_ready("control_thumbnail") {
        return;
    }
    let class = "pickforge-viewer-control-host";
    let mut rig = Rig::start(class, "host");
    rig.grant("L1", 10_000);
    rig.viewer.expect("expandRequested");
    rig.screen.focus(rig.window);
    // Keys and a click on the thumbnail stay out of the session; the
    // click only asks to expand.
    rig.listener.take_quiet();
    rig.screen.key(KEY_A, true);
    rig.screen.key(KEY_A, false);
    rig.screen.click(rig.window.x + 100, rig.window.y + 100);
    rig.viewer.expect("expandRequested");
    let presses: Vec<Event> = rig
        .listener
        .take_quiet()
        .into_iter()
        .filter(|e| matches!(e, Event::KeyPress(_) | Event::ButtonPress(_)))
        .collect();
    assert!(presses.is_empty(), "thumbnail forwarded {presses:?}");

    // Wider than the session: 80 px of letterbox on each side.
    rig.viewer
        .send(r#"{"cmd":"setMode","mode":"expanded","width":800,"height":512}"#);
    assert_eq!(rig.viewer.expect("mode")["mode"], "expanded");
    rig.window = rig.screen.wait_size(class, 800, 512);
    rig.screen.focus(rig.window);
    rig.listener.take_quiet();
    rig.screen.click(rig.window.x + 20, rig.window.y + 200);
    rig.screen.click(rig.window.x + 300, rig.window.y + 10);
    let presses: Vec<Event> = rig
        .listener
        .take_quiet()
        .into_iter()
        .filter(|e| matches!(e, Event::ButtonPress(_)))
        .collect();
    assert!(presses.is_empty(), "letterbox or bar forwarded {presses:?}");

    // The image maps through the scale and the letterbox.
    rig.screen
        .click(rig.window.x + 80 + 100, rig.window.y + 32 + 50);
    assert!(wait_until(WAIT, || {
        rig.listener.poll();
        rig.listener
            .events
            .iter()
            .any(|e| matches!(e, Event::ButtonPress(b) if (b.root_x, b.root_y) == (100, 50)))
    }));
    rig.assert_types(KEY_A, "a");
}

/// Saves the watch bar, the banner and the control bar, and checks the
/// ember highlights.
#[test]
fn renders_the_bar_banner_and_control_states() {
    if !xvfb_ready("control_render") {
        return;
    }
    let class = "pickforge-viewer-control-render";
    let mut rig = Rig::start(class, "self");
    let _painter = paint_session(&rig._session);
    let thumb = rig.window;
    rig.viewer.send(&format!(
        r#"{{"cmd":"attention","message":"{LONG_MESSAGE}"}}"#
    ));
    thread::sleep(Duration::from_millis(300));
    save(&rig.screen.shot(), thumb, "thumbnail-banner.png");
    rig.viewer.send(r#"{"cmd":"clearAttention"}"#);

    rig.screen.click(thumb.x + 200, thumb.y + 200);
    assert_eq!(rig.viewer.expect("mode")["mode"], "expanded");
    let window = rig.screen.wait_size(class, 640, 512);
    rig.window = window;
    rig.screen.move_to(window.x + 320, window.y + 300);
    thread::sleep(Duration::from_millis(200));
    save(&rig.screen.shot(), window, "watch-bar.png");

    rig.viewer.send(&format!(
        r#"{{"cmd":"attention","message":"{LONG_MESSAGE}"}}"#
    ));
    let has_ember = |frame: &_, window: Placed, rows: std::ops::Range<u32>| {
        rows.into_iter()
            .any(|y| (0..window.w).any(|x| near(at(frame, window, x, y), EMBER, 24)))
    };
    assert!(
        wait_until(WAIT, || has_ember(&rig.screen.shot(), window, 40..200)),
        "highlighted Take control in the banner"
    );
    let shot = rig.screen.shot();
    assert!(
        !has_ember(&shot, window, 0..32),
        "the watch bar has no ember"
    );
    save(&shot, window, "banner-long.png");

    // A narrow window wraps the message and puts the button below it.
    rig.viewer
        .send(r#"{"cmd":"setMode","mode":"expanded","width":360,"height":300}"#);
    let narrow = rig.screen.wait_size(class, 360, 300);
    save(&rig.screen.shot(), narrow, "banner-narrow.png");
    rig.viewer
        .send(r#"{"cmd":"setMode","mode":"expanded","width":640,"height":512}"#);
    rig.window = rig.screen.wait_size(class, 640, 512);

    // Take control in the banner asks the host once.
    let shot = rig.screen.shot();
    let button = (40..200)
        .flat_map(|y| (0..window.w).map(move |x| (x, y)))
        .find(|&(x, y)| near(at(&shot, window, x, y), EMBER, 4))
        .expect("ember button");
    rig.screen.click(
        window.x + button.0 as i32 + 6,
        window.y + button.1 as i32 + 6,
    );
    rig.viewer.expect("takeRequested");
    rig.screen.click(
        window.x + button.0 as i32 + 6,
        window.y + button.1 as i32 + 6,
    );
    rig.viewer.expect_quiet(Duration::from_millis(300));

    // The host cannot grant: the status says so.
    rig.revoke("", "unavailable");
    thread::sleep(Duration::from_millis(300));
    save(&rig.screen.shot(), window, "status-unavailable.png");

    rig.grant("L1", 10_000);
    rig.screen.move_to(window.x + 320, window.y + 300);
    assert!(
        wait_until(WAIT, || {
            let shot = rig.screen.shot();
            near(at(&shot, window, 320, 31), EMBER, 12) && !has_ember(&shot, window, 40..200)
        }),
        "control bar with an ember line and no banner"
    );
    rig.window = window;
    let (px, py) = rig.paste_point();
    let shot = rig.screen.shot();
    let label = (px - 16..px + 16)
        .any(|x| (py - 4..py + 4).any(|y| !near(at(&shot, window, x, y), BAR, 40)));
    assert!(label, "Paste right of Return control");
    assert!(
        !near(at(&shot, window, px, 6), EMBER, 60),
        "only Return control has an ember outline"
    );
    save(&shot, window, "control-bar.png");

    rig.revoke("L1", "lease-lost");
    thread::sleep(Duration::from_millis(300));
    save(&rig.screen.shot(), window, "status-ended.png");
}

#[test]
fn paste_types_host_text_into_the_session_only() {
    if !xvfb_ready("paste_text") {
        return;
    }
    let class = "pickforge-viewer-paste";
    let mut rig = Rig::start(class, "self");
    let text = format!("Olá ß €\t{MARKER}\n");
    let owner = Owner::start(rig._host.display, Serve::Text(text.into_bytes()));

    // The thumbnail and the watch bar offer no Paste.
    let thumb = rig.window;
    rig.screen.click(thumb.x + 150, thumb.y + 16);
    assert_eq!(rig.viewer.expect("mode")["mode"], "expanded");
    rig.window = rig.screen.wait_size(class, 640, 512);
    rig.screen.click(rig.window.x + 150, rig.window.y + 16);
    rig.viewer.expect_quiet(Duration::from_millis(300));
    assert_eq!(owner.requests(), 0, "no clipboard read without control");

    rig.grant("L1", 10_000);
    rig.listener.take_quiet();
    rig.click_paste();
    // One trailing line break is dropped; the tab is a Tab key.
    let want = format!("Olá ß €<Tab>{MARKER}");
    let mut got = String::new();
    let typed = wait_until(WAIT, || {
        rig.listener.poll();
        got = rig.listener.decode(&rig.listener.presses());
        got == want
    });
    assert!(typed, "typed {got:?}");
    rig.viewer.expect_quiet(Duration::from_millis(300));
    rig.listener.events.clear();
    assert_eq!(rig.presses_until_quiet(), 0, "no Return after the text");
    assert_eq!(owner.requests(), 1, "one read per click");
    rig.assert_released();

    let output = rig.viewer.output.lock().unwrap().clone();
    assert!(!output.contains(MARKER), "the text reached viewer output");
    for selection in ["CLIPBOARD", "PRIMARY"] {
        assert_eq!(
            selection_owner(rig._session.display, selection),
            x11rb::NONE,
            "{selection} on the session display has an owner"
        );
    }
}

#[test]
fn a_long_paste_stops_at_lease_loss_and_collapse() {
    if !xvfb_ready("paste_stops") {
        return;
    }
    let class = "pickforge-viewer-paste-stop";
    let mut rig = Rig::start_controlling(class);
    let long = "a".repeat(4000);
    let _owner = Owner::start(rig._host.display, Serve::Text(long.into_bytes()));

    for stop in ["lease-lost", "collapse"] {
        rig.listener.take_quiet();
        rig.click_paste();
        let started = wait_until(WAIT, || {
            rig.listener.poll();
            !rig.listener.presses().is_empty()
        });
        assert!(started, "{stop}: the paste started");
        if stop == "lease-lost" {
            rig.revoke("L1", "lease-lost");
        } else {
            rig.viewer.send(r#"{"cmd":"setMode","mode":"thumbnail"}"#);
            assert_eq!(rig.viewer.expect("mode")["mode"], "thumbnail");
        }
        let typed = rig.presses_until_quiet();
        assert!(typed > 0 && typed < 4000, "{stop}: {typed} presses");
        thread::sleep(Duration::from_millis(300));
        assert_eq!(rig.presses_until_quiet(), 0, "{stop}: typing went on");
        rig.assert_released();
        if stop == "lease-lost" {
            rig.grant("L2", 10_000);
        }
    }
}
