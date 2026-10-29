//! A focused full-screen window on a session display that records the
//! input that reaches it.

#![allow(dead_code)]

use super::common::wait_until;
use pickforge_viewer::capture::connect_display;
use pickforge_viewer::input::{read_keyboard, use_xkb};
use pickforge_viewer::keysyms::{is_plain_modifier, keysym_to_codepoint, named};
use std::time::Duration;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    ConnectionExt as _, CreateWindowAux, EventMask, InputFocus, KeyButMask, WindowClass,
};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;
use x11rb::CURRENT_TIME;

pub const WAIT: Duration = Duration::from_secs(3);
pub const QUIET: Duration = Duration::from_millis(200);

/// A focused full-screen window that records input events.
pub struct Listener {
    pub conn: RustConnection,
    pub root: u32,
    pub events: Vec<Event>,
}

impl Listener {
    pub fn new(display: u32) -> Listener {
        let conn = connect_display(display).expect("connect listener");
        let screen = &conn.setup().roots[0];
        let (root, w, h) = (screen.root, screen.width_in_pixels, screen.height_in_pixels);
        let window = conn.generate_id().unwrap();
        let mask = EventMask::KEY_PRESS
            | EventMask::KEY_RELEASE
            | EventMask::BUTTON_PRESS
            | EventMask::BUTTON_RELEASE
            | EventMask::POINTER_MOTION;
        conn.create_window(
            0,
            window,
            root,
            0,
            0,
            w,
            h,
            0,
            WindowClass::INPUT_OUTPUT,
            0,
            &CreateWindowAux::new().override_redirect(1).event_mask(mask),
        )
        .unwrap();
        conn.map_window(window).unwrap();
        conn.set_input_focus(InputFocus::PARENT, window, CURRENT_TIME)
            .unwrap();
        conn.get_input_focus().unwrap().reply().unwrap();
        use_xkb(&conn).unwrap();
        Listener {
            conn,
            root,
            events: Vec::new(),
        }
    }

    pub fn poll(&mut self) {
        self.conn.get_input_focus().unwrap().reply().unwrap();
        while let Some(event) = self.conn.poll_for_event().unwrap() {
            if matches!(
                event,
                Event::KeyPress(_)
                    | Event::KeyRelease(_)
                    | Event::ButtonPress(_)
                    | Event::ButtonRelease(_)
                    | Event::MotionNotify(_)
            ) {
                self.events.push(event);
            }
        }
    }

    /// Waits until `count` key presses arrived, then for stragglers.
    pub fn key_presses(&mut self, count: usize) -> Vec<(u8, u16)> {
        wait_until(WAIT, || {
            self.poll();
            self.presses().len() >= count
        });
        std::thread::sleep(QUIET);
        self.poll();
        self.presses()
    }

    pub fn presses(&self) -> Vec<(u8, u16)> {
        self.events
            .iter()
            .filter_map(|e| match e {
                Event::KeyPress(k) => Some((k.detail, u16::from(k.state))),
                _ => None,
            })
            .collect()
    }

    /// Takes every event that arrives within `QUIET`.
    pub fn take_quiet(&mut self) -> Vec<Event> {
        std::thread::sleep(QUIET);
        self.poll();
        std::mem::take(&mut self.events)
    }

    /// Decodes key presses through the live session keymap. Modifier keys
    /// are dropped, Control chords become `^x` and named keys `<Name>`.
    pub fn decode(&self, presses: &[(u8, u16)]) -> String {
        let keyboard = read_keyboard(&self.conn).unwrap();
        let mut out = String::new();
        for &(code, state) in presses {
            let keysym = keyboard.keysym(code, state);
            if is_plain_modifier(keysym) {
                continue;
            }
            let name = match keysym {
                named::RETURN => Some("<Return>"),
                named::TAB => Some("<Tab>"),
                named::LEFT => Some("<Left>"),
                named::RIGHT => Some("<Right>"),
                named::UP => Some("<Up>"),
                named::DOWN => Some("<Down>"),
                named::ESCAPE => Some("<Escape>"),
                _ => None,
            };
            if let Some(name) = name {
                out.push_str(name);
                continue;
            }
            let c = char::from_u32(keysym_to_codepoint(keysym)).unwrap_or('\u{fffd}');
            if state & u16::from(KeyButMask::CONTROL) != 0 {
                out.push('^');
            }
            out.push(c);
        }
        out
    }

    pub fn down_keys(&self) -> Vec<u8> {
        let keys = self.conn.query_keymap().unwrap().reply().unwrap().keys;
        (0..=255u8)
            .filter(|&code| keys[code as usize / 8] & (1 << (code % 8)) != 0)
            .collect()
    }

    pub fn buttons_down(&self) -> u16 {
        let mask = self
            .conn
            .query_pointer(self.root)
            .unwrap()
            .reply()
            .unwrap()
            .mask;
        u16::from(mask) & 0x1f00
    }

    /// Held keycodes and pointer buttons once the server settled.
    pub fn settled_state(&self) -> (Vec<u8>, u16) {
        let mut state = (self.down_keys(), self.buttons_down());
        wait_until(WAIT, || {
            state = (self.down_keys(), self.buttons_down());
            state.0.is_empty() && state.1 == 0
        });
        state
    }
}
