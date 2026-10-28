//! Input injection against a real Xvfb: composed text through the session
//! keymap, chords and named keys, pointer and scroll, fail-closed grants
//! (I1) and release of held keys and buttons (I4).

#![cfg(target_os = "linux")]

mod common;
#[path = "common/listener.rs"]
mod listener;

use common::{wait_until, xvfb_ready, Xvfb};
use listener::{Listener, WAIT};
use pickforge_viewer::capture::connect_display;
use pickforge_viewer::input::{read_keyboard, Button, Clock, InjectError, Injector};
use pickforge_viewer::keysyms::named;
use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};
use x11rb::protocol::Event;

const SCREEN: &str = "640x480x24";
const TEXT: &str = "ção ÁÉ ñ ß € ";

#[derive(Clone)]
struct FakeClock(Rc<Cell<Instant>>);

impl FakeClock {
    fn advance(&self, by: Duration) {
        self.0.set(self.0.get() + by);
    }
}

impl Clock for FakeClock {
    fn now(&self) -> Instant {
        self.0.get()
    }
}

fn injector(display: u32) -> (Injector<FakeClock>, FakeClock) {
    let clock = FakeClock(Rc::new(Cell::new(Instant::now())));
    let conn = connect_display(display).unwrap();
    let injector = Injector::with_clock(conn, clock.clone()).unwrap();
    (injector, clock)
}

fn granted(display: u32) -> (Injector<FakeClock>, FakeClock) {
    let (mut injector, clock) = injector(display);
    injector
        .grant("lease-1", clock.now() + Duration::from_secs(10))
        .unwrap();
    (injector, clock)
}

fn tap(injector: &mut Injector<FakeClock>, keysym: u32) {
    injector.key(keysym, true).unwrap();
    injector.key(keysym, false).unwrap();
}

fn not_granted(result: Result<(), InjectError>) {
    assert!(matches!(result, Err(InjectError::NotGranted)), "{result:?}");
}

#[test]
fn types_composed_text_chords_and_named_keys() {
    if !xvfb_ready("types_composed_text") {
        return;
    }
    let xvfb = Xvfb::start(SCREEN);
    let mut listener = Listener::new(xvfb.display);
    let (mut injector, _clock) = granted(xvfb.display);

    injector.type_text(TEXT).unwrap();
    assert!(injector.bindings_made() > 0, "binds missing symbols");
    injector.key(named::CONTROL_L, true).unwrap();
    injector.key_char('c', true).unwrap();
    injector.key_char('c', false).unwrap();
    injector.key(named::CONTROL_L, false).unwrap();
    for keysym in [
        named::RETURN,
        named::LEFT,
        named::RIGHT,
        named::UP,
        named::DOWN,
    ] {
        tap(&mut injector, keysym);
    }

    let expected = format!("{TEXT}^c<Return><Left><Right><Up><Down>");
    let presses = listener.key_presses(expected.chars().count());
    assert_eq!(listener.decode(&presses), expected);
    assert_eq!(listener.down_keys(), Vec::<u8>::new(), "no key stays down");

    // Earlier bindings are reused, not bound again.
    let made = injector.bindings_made();
    listener.take_quiet();
    injector.type_text("Ñ€ç").unwrap();
    assert_eq!(injector.bindings_made(), made);
    let presses = listener.key_presses(3);
    assert_eq!(listener.decode(&presses), "Ñ€ç");
}

#[test]
fn held_modifiers_are_reconciled_and_lock_keys_dropped() {
    if !xvfb_ready("held_modifiers") {
        return;
    }
    let xvfb = Xvfb::start(SCREEN);
    let mut listener = Listener::new(xvfb.display);
    let (mut injector, _clock) = granted(xvfb.display);
    let shift = read_keyboard(&listener.conn)
        .unwrap()
        .find_keysym(0, named::SHIFT_L)
        .unwrap()
        .code;

    injector.key(named::SHIFT_L, true).unwrap();
    injector.type_text("aA").unwrap();
    injector.key_char('b', true).unwrap();
    injector.key_char('b', false).unwrap();
    let presses = listener.key_presses(3);
    assert_eq!(listener.decode(&presses), "aAB");
    assert_eq!(listener.down_keys(), vec![shift], "Shift is held again");
    // Shift released first: the release reports the lowercase key.
    injector.key_char('C', true).unwrap();
    injector.key(named::SHIFT_L, false).unwrap();
    injector.key_char('c', false).unwrap();
    assert_eq!(listener.settled_state(), (Vec::new(), 0));

    listener.take_quiet();
    injector.key(named::CAPS_LOCK, true).unwrap();
    injector.key(named::CAPS_LOCK, false).unwrap();
    injector.key(named::NUM_LOCK, true).unwrap();
    assert!(listener.take_quiet().is_empty(), "lock keys are dropped");
    injector.type_text("a").unwrap();
    let presses = listener.key_presses(1);
    assert_eq!(listener.decode(&presses), "a");
}

#[test]
fn sends_pointer_buttons_and_scroll() {
    if !xvfb_ready("sends_pointer") {
        return;
    }
    let xvfb = Xvfb::start(SCREEN);
    let mut listener = Listener::new(xvfb.display);
    let (mut injector, _clock) = granted(xvfb.display);

    injector.motion(120, 90).unwrap();
    injector.motion(5000, -20).unwrap();
    for button in [
        Button::Left,
        Button::Middle,
        Button::Right,
        Button::Back,
        Button::Forward,
    ] {
        injector.button(button, true).unwrap();
        injector.button(button, false).unwrap();
    }
    injector.scroll_pixels(0.0, 45.0).unwrap();
    injector.scroll_lines(-1.0, -1.0).unwrap();
    injector.scroll_lines(1.0, 0.0).unwrap();

    let mut motions = Vec::new();
    let mut buttons = Vec::new();
    wait_until(WAIT, || {
        listener.poll();
        listener.events.len() >= 22
    });
    for event in listener.take_quiet() {
        match event {
            Event::MotionNotify(m) => motions.push((m.root_x, m.root_y)),
            Event::ButtonPress(b) => buttons.push(b.detail),
            _ => {}
        }
    }
    assert_eq!(motions, vec![(120, 90), (639, 0)]);
    assert_eq!(buttons, vec![1, 2, 3, 8, 9, 4, 4, 5, 7, 6]);
    assert_eq!(listener.buttons_down(), 0);
}

#[test]
fn revoke_releases_held_input_and_stops_sending() {
    if !xvfb_ready("revoke_releases") {
        return;
    }
    let xvfb = Xvfb::start(SCREEN);
    let mut listener = Listener::new(xvfb.display);
    let (mut injector, _clock) = granted(xvfb.display);

    injector.key(named::SHIFT_L, true).unwrap();
    injector.motion(100, 100).unwrap();
    injector.button(Button::Left, true).unwrap();
    listener.poll();
    assert!(!listener.down_keys().is_empty());
    assert_ne!(listener.buttons_down(), 0);

    injector.revoke().unwrap();
    assert_eq!(listener.settled_state(), (Vec::new(), 0));
    listener.take_quiet();

    not_granted(injector.type_text("x"));
    not_granted(injector.key(named::RETURN, true));
    not_granted(injector.key_char('x', true));
    not_granted(injector.motion(10, 10));
    not_granted(injector.button(Button::Left, true));
    not_granted(injector.scroll_lines(0.0, 3.0));
    assert!(listener.take_quiet().is_empty(), "nothing after revoke");
}

#[test]
fn expired_grant_releases_and_refuses() {
    if !xvfb_ready("expired_grant") {
        return;
    }
    let xvfb = Xvfb::start(SCREEN);
    let mut listener = Listener::new(xvfb.display);
    let (mut injector, clock) = injector(xvfb.display);
    not_granted(injector.type_text("x"));

    injector
        .grant("lease-1", clock.now() + Duration::from_secs(10))
        .unwrap();
    injector.type_text("a").unwrap();
    let presses = listener.key_presses(1);
    assert_eq!(listener.decode(&presses), "a");
    injector.key(named::SHIFT_L, true).unwrap();
    injector.button(Button::Right, true).unwrap();
    listener.take_quiet();

    clock.advance(Duration::from_secs(10));
    assert!(!injector.is_granted());
    not_granted(injector.type_text("b"));
    assert_eq!(listener.settled_state(), (Vec::new(), 0));
    let after: Vec<Event> = listener
        .take_quiet()
        .into_iter()
        .filter(|e| matches!(e, Event::KeyPress(_) | Event::ButtonPress(_)))
        .collect();
    assert!(after.is_empty(), "only releases after expiry: {after:?}");
    not_granted(injector.motion(1, 1));
    not_granted(injector.scroll_pixels(0.0, 100.0));
    assert!(listener.take_quiet().is_empty(), "nothing after expiry");
}

#[test]
fn drop_releases_held_input() {
    if !xvfb_ready("drop_releases") {
        return;
    }
    let xvfb = Xvfb::start(SCREEN);
    let listener = Listener::new(xvfb.display);
    let (mut injector, _clock) = granted(xvfb.display);
    injector.key(named::CONTROL_L, true).unwrap();
    injector.button(Button::Middle, true).unwrap();
    assert_eq!(injector.held_buttons().collect::<Vec<_>>(), vec![2]);
    drop(injector);
    assert_eq!(listener.settled_state(), (Vec::new(), 0));
}

#[test]
fn refuses_text_beyond_spare_keycodes_before_sending() {
    if !xvfb_ready("refuses_text_beyond_spare") {
        return;
    }
    let xvfb = Xvfb::start(SCREEN);
    let mut listener = Listener::new(xvfb.display);
    let (mut injector, _clock) = granted(xvfb.display);
    let spare = read_keyboard(&listener.conn).unwrap().empty_codes().len();
    let text: String = (0..=spare as u32)
        .map(|i| char::from_u32(0x4e00 + i).unwrap())
        .collect();
    assert!(matches!(
        injector.type_text(&text),
        Err(InjectError::CapacityExhausted)
    ));
    assert_eq!(injector.bindings_made(), 0);
    assert!(listener.take_quiet().is_empty());
}
