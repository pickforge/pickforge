//! Sends the human's pointer and keyboard input to the session display with
//! XTEST while a control grant is valid (invariant I1), and releases every
//! held key and button when control ends (invariant I4).
//!
//! Text arrives already composed by the host, so dead keys and IME commits
//! are plain strings here. Each character is typed on the key that carries
//! it, with the modifiers its level needs. Missing symbols are bound to
//! spare keycodes, which are never restored, as in `docs/desktop-typing.md`.

use crate::capture::{connect_display, CaptureError};
use crate::keymap::{
    plan_bindings, reconcile, verify_bindings, Binding, KeyLevel, Keyboard, KeymapError,
    XKB_MAP_PARTS,
};
use crate::keysyms::{binding_symbols, codepoint_to_keysym, is_lock, named};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::net::Shutdown;
use std::os::fd::AsFd;
use std::os::unix::net::UnixStream;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};
use x11rb::connection::{Connection, RequestConnection};
use x11rb::errors::{ConnectionError, ReplyError};
use x11rb::protocol::xkb::{self, ConnectionExt as _};
use x11rb::protocol::xproto::{self, ConnectionExt as _, Mapping};
use x11rb::protocol::xtest::{self, ConnectionExt as _};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;
use x11rb::NONE;

/// Pixel scroll distance that makes one wheel step.
pub const PIXELS_PER_STEP: f64 = 20.0;
/// The most wheel steps one scroll event sends per axis.
pub const MAX_SCROLL_STEPS: u32 = 32;
/// Most new keycode bindings one injector makes. The spare keycodes are
/// shared with the agent's typing, so a long session must not use them all.
pub const MAX_BINDINGS: usize = 64;
/// Longest text one call types, in characters.
pub const MAX_TEXT_CHARS: usize = 4096;
/// Longest a drop waits for the server to apply its releases.
const CLOSE_SYNC: Duration = Duration::from_secs(1);
/// The Control, Mod1 (Alt) and Mod4 (Super) state bits.
const SHORTCUT_MASK: u8 = 0x04 | 0x08 | 0x40;
/// The Shift state bit.
const SHIFT_MASK: u8 = 0x01;

#[derive(Debug)]
pub enum InjectError {
    /// No grant, an expired grant, or a revoked one. Nothing was sent.
    NotGranted,
    /// The display cannot be opened or lacks XTEST or XKB.
    Display(String),
    /// The connection to the display is gone or a request failed.
    Request(String),
    /// The keyboard map is malformed or a binding failed.
    Keymap(KeymapError),
    /// The text has a character that cannot be typed.
    InvalidText,
    /// No key can type a character in the current state.
    Unmappable,
    /// This injector reached `MAX_BINDINGS`.
    CapacityExhausted,
}

impl std::fmt::Display for InjectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InjectError::NotGranted => write!(f, "input control is not granted"),
            InjectError::Display(m) => write!(f, "session display unavailable: {m}"),
            InjectError::Request(m) => write!(f, "session display request failed: {m}"),
            InjectError::Keymap(e) => write!(f, "{e}"),
            InjectError::InvalidText => write!(f, "text has a character that cannot be typed"),
            InjectError::Unmappable => write!(f, "no key types this character"),
            InjectError::CapacityExhausted => write!(f, "keyboard binding limit reached"),
        }
    }
}

impl std::error::Error for InjectError {}

impl From<ConnectionError> for InjectError {
    fn from(e: ConnectionError) -> Self {
        InjectError::Request(e.to_string())
    }
}

impl From<ReplyError> for InjectError {
    fn from(e: ReplyError) -> Self {
        match e {
            ReplyError::ConnectionError(e) => e.into(),
            ReplyError::X11Error(e) => InjectError::Request(format!("{:?}", e.error_kind)),
        }
    }
}

impl From<KeymapError> for InjectError {
    fn from(e: KeymapError) -> Self {
        match e {
            KeymapError::CapacityExhausted => InjectError::CapacityExhausted,
            other => InjectError::Keymap(other),
        }
    }
}

impl From<CaptureError> for InjectError {
    fn from(e: CaptureError) -> Self {
        InjectError::Display(e.to_string())
    }
}

/// The time source for grant checks. Tests inject a fake one.
pub trait Clock {
    fn now(&self) -> Instant;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

/// The current control grant: a lease and the instant it ends.
#[derive(Debug, Clone, Default)]
pub struct Gate {
    lease: Option<(String, Instant)>,
}

impl Gate {
    /// Grants control under `lease_id` until `until`. Returns true when
    /// this replaces a grant of another lease.
    pub fn grant(&mut self, lease_id: &str, until: Instant) -> bool {
        let other = self.lease.as_ref().is_some_and(|(id, _)| id != lease_id);
        self.lease = Some((lease_id.to_owned(), until));
        other
    }

    pub fn revoke(&mut self) {
        self.lease = None;
    }

    pub fn lease_id(&self) -> Option<&str> {
        self.lease.as_ref().map(|(id, _)| id.as_str())
    }

    /// Ok while a grant exists and `now` is before its end. An expired
    /// grant is dropped.
    pub fn check(&mut self, now: Instant) -> Result<(), InjectError> {
        match &self.lease {
            Some((_, until)) if now < *until => Ok(()),
            _ => {
                self.lease = None;
                Err(InjectError::NotGranted)
            }
        }
    }
}

/// Pointer buttons the viewer forwards.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Left,
    Middle,
    Right,
    Back,
    Forward,
}

impl Button {
    pub fn number(self) -> u8 {
        match self {
            Button::Left => 1,
            Button::Middle => 2,
            Button::Right => 3,
            Button::Back => 8,
            Button::Forward => 9,
        }
    }
}

/// Turns fractional line and pixel scroll deltas into whole wheel steps.
/// The signs follow winit, the inverse of its X11 mapping: positive `y`
/// is button 4 and positive `x` is button 6.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ScrollAccumulator {
    x: f64,
    y: f64,
}

impl ScrollAccumulator {
    /// Adds a delta in lines and returns `(button, steps)` to send.
    /// A change of direction drops the remainder of the old one.
    pub fn lines(&mut self, dx: f64, dy: f64) -> Vec<(u8, u32)> {
        add_delta(&mut self.x, dx);
        add_delta(&mut self.y, dy);
        let mut steps = Vec::new();
        take_steps(&mut self.y, 4, 5, &mut steps);
        take_steps(&mut self.x, 6, 7, &mut steps);
        steps
    }

    /// Adds a delta in pixels, `PIXELS_PER_STEP` to a line.
    pub fn pixels(&mut self, dx: f64, dy: f64) -> Vec<(u8, u32)> {
        self.lines(dx / PIXELS_PER_STEP, dy / PIXELS_PER_STEP)
    }
}

fn add_delta(total: &mut f64, delta: f64) {
    if *total * delta < 0.0 {
        *total = 0.0;
    }
    *total += delta;
}

fn take_steps(total: &mut f64, positive: u8, negative: u8, steps: &mut Vec<(u8, u32)>) {
    if !total.is_finite() {
        *total = 0.0;
        return;
    }
    let whole = total.trunc();
    *total -= whole;
    if whole != 0.0 {
        let button = if whole > 0.0 { positive } else { negative };
        steps.push((button, whole.abs().min(f64::from(MAX_SCROLL_STEPS)) as u32));
    }
}

/// One typed character: a keysym typed as is, or a codepoint typed with
/// the modifiers its level needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stroke {
    Key(u32),
    Char(u32),
}

fn strokes(text: &str) -> Result<Vec<Stroke>, InjectError> {
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(InjectError::InvalidText);
    }
    text.chars().map(stroke).collect()
}

fn stroke(c: char) -> Result<Stroke, InjectError> {
    Ok(match c {
        '\r' | '\n' => Stroke::Key(named::RETURN),
        '\t' => Stroke::Key(named::TAB),
        '\u{8}' => Stroke::Key(named::BACKSPACE),
        '\u{1b}' => Stroke::Key(named::ESCAPE),
        '\u{7f}' => Stroke::Key(named::DELETE),
        c if c.is_control() => return Err(InjectError::InvalidText),
        c => Stroke::Char(c as u32),
    })
}

/// Raw modifier, core and XKB map replies, in the order
/// `Keyboard::parse` takes them.
pub fn read_keymap_replies(conn: &RustConnection) -> Result<(u8, u8, [Vec<u8>; 3]), InjectError> {
    let setup = conn.setup();
    let (min, max) = (setup.min_keycode, setup.max_keycode);
    let modifiers = conn.get_modifier_mapping()?.raw_reply()?;
    let core = conn.get_keyboard_mapping(min, max - min + 1)?.raw_reply()?;
    let parts = xkb::MapPart::from(XKB_MAP_PARTS);
    let spec = xkb::DeviceSpec::from(xkb::ID::USE_CORE_KBD);
    let xkb = conn
        .xkb_get_map(
            spec,
            parts,
            0u16.into(),
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0u16.into(),
            0,
            0,
            0,
            0,
            0,
            0,
        )?
        .raw_reply()?;
    Ok((min, max, [modifiers.to_vec(), core.to_vec(), xkb.to_vec()]))
}

/// Reads and parses the session keyboard map. XKB must already be in use
/// on `conn`.
pub fn read_keyboard(conn: &RustConnection) -> Result<Keyboard, InjectError> {
    let (min, max, [modifiers, core, xkb]) = read_keymap_replies(conn)?;
    Ok(Keyboard::parse(min, max, &modifiers, &core, &xkb)?)
}

/// Enables XKB on `conn`, which `read_keyboard` needs.
pub fn use_xkb(conn: &RustConnection) -> Result<(), InjectError> {
    if conn
        .extension_information(xkb::X11_EXTENSION_NAME)?
        .is_none()
    {
        return Err(InjectError::Display("XKEYBOARD is missing".into()));
    }
    if !conn.xkb_use_extension(1, 0)?.reply()?.supported {
        return Err(InjectError::Display("XKEYBOARD 1.0 is refused".into()));
    }
    Ok(())
}

fn use_xtest(conn: &RustConnection) -> Result<(), InjectError> {
    if conn
        .extension_information(xtest::X11_EXTENSION_NAME)?
        .is_none()
    {
        return Err(InjectError::Display("XTEST is missing".into()));
    }
    conn.xtest_get_version(2, 2)?.reply()?;
    Ok(())
}

/// Sends input to one session display. Every sending method checks the
/// grant first and sends nothing without a valid one.
pub struct Injector<C: Clock = SystemClock> {
    conn: RustConnection,
    root: xproto::Window,
    size: (u16, u16),
    clock: C,
    gate: Gate,
    keyboard: Option<Keyboard>,
    held_keys: BTreeSet<u8>,
    held_buttons: BTreeSet<u8>,
    /// The keycode each held keysym was pressed on, so its release still
    /// matches after a map change.
    pressed_symbols: HashMap<u32, u8>,
    scroll: ScrollAccumulator,
    bindings: usize,
}

impl Injector<SystemClock> {
    /// Opens `/tmp/.X11-unix/X<display>` and prepares XTEST and XKB.
    pub fn connect(display: u32) -> Result<Self, InjectError> {
        Self::with_clock(connect_display(display)?, SystemClock)
    }
}

impl<C: Clock> Injector<C> {
    pub fn with_clock(conn: RustConnection, clock: C) -> Result<Self, InjectError> {
        use_xtest(&conn)?;
        use_xkb(&conn)?;
        let screen = &conn.setup().roots[0];
        let (root, size) = (
            screen.root,
            (screen.width_in_pixels, screen.height_in_pixels),
        );
        Ok(Injector {
            conn,
            root,
            size,
            clock,
            gate: Gate::default(),
            keyboard: None,
            held_keys: BTreeSet::new(),
            held_buttons: BTreeSet::new(),
            pressed_symbols: HashMap::new(),
            scroll: ScrollAccumulator::default(),
            bindings: 0,
        })
    }

    /// Allows input under `lease_id` until `until`. A grant for another
    /// lease first releases everything the old one held.
    pub fn grant(&mut self, lease_id: &str, until: Instant) -> Result<(), InjectError> {
        if self.gate.grant(lease_id, until) {
            self.release_all()?;
        }
        Ok(())
    }

    /// Ends control and releases every held key and button.
    pub fn revoke(&mut self) -> Result<(), InjectError> {
        self.gate.revoke();
        self.release_all()
    }

    pub fn lease_id(&self) -> Option<&str> {
        self.gate.lease_id()
    }

    /// True while a grant is valid now.
    pub fn is_granted(&mut self) -> bool {
        self.gate.check(self.clock.now()).is_ok()
    }

    /// Keycode bindings this injector made.
    pub fn bindings_made(&self) -> usize {
        self.bindings
    }

    pub fn held_keys(&self) -> impl Iterator<Item = u8> + '_ {
        self.held_keys.iter().copied()
    }

    pub fn held_buttons(&self) -> impl Iterator<Item = u8> + '_ {
        self.held_buttons.iter().copied()
    }

    /// Fails closed: an expired or revoked grant releases what is held and
    /// returns `NotGranted`.
    fn check(&mut self) -> Result<(), InjectError> {
        if let Err(e) = self.gate.check(self.clock.now()) {
            let _ = self.release_all();
            return Err(e);
        }
        Ok(())
    }

    /// Moves the pointer to session pixel `(x, y)`, clamped to the screen.
    pub fn motion(&mut self, x: i32, y: i32) -> Result<(), InjectError> {
        self.check()?;
        let x = x.clamp(0, i32::from(self.size.0) - 1) as i16;
        let y = y.clamp(0, i32::from(self.size.1) - 1) as i16;
        self.conn
            .xtest_fake_input(xproto::MOTION_NOTIFY_EVENT, 0, 0, self.root, x, y, 0)?;
        self.conn.flush()?;
        Ok(())
    }

    pub fn button(&mut self, button: Button, pressed: bool) -> Result<(), InjectError> {
        self.check()?;
        self.send_button(button.number(), pressed)?;
        self.conn.flush()?;
        Ok(())
    }

    /// Scrolls by whole and fractional lines.
    pub fn scroll_lines(&mut self, dx: f64, dy: f64) -> Result<(), InjectError> {
        self.check()?;
        let steps = self.scroll.lines(dx, dy);
        self.send_steps(steps)
    }

    /// Scrolls by pixels, as touchpads report.
    pub fn scroll_pixels(&mut self, dx: f64, dy: f64) -> Result<(), InjectError> {
        self.check()?;
        let steps = self.scroll.pixels(dx, dy);
        self.send_steps(steps)
    }

    fn send_steps(&mut self, steps: Vec<(u8, u32)>) -> Result<(), InjectError> {
        for (button, count) in steps {
            for _ in 0..count {
                // A grant can end partway through a burst.
                if let Err(e) = self.check() {
                    self.conn.flush()?;
                    return Err(e);
                }
                self.send_button(button, true)?;
                self.send_button(button, false)?;
            }
        }
        self.conn.flush()?;
        Ok(())
    }

    /// Presses or releases the key of a named or modifier keysym with the
    /// current modifiers. Lock keys are dropped. A press of a held key is a
    /// repeat and is sent as release and press.
    pub fn key(&mut self, keysym: u32, pressed: bool) -> Result<(), InjectError> {
        self.check()?;
        if is_lock(keysym) {
            return Ok(());
        }
        self.refresh()?;
        let find = move |kb: &Keyboard, group| kb.find_keysym(group, keysym);
        if !pressed {
            return self.release_symbol(keysym, find);
        }
        let code = self.code_for(keysym, find)?;
        self.press_symbol(keysym, code)
    }

    /// Presses or releases the key that carries `c` without changing the
    /// modifiers, for chords such as Ctrl+C whose key event has no text.
    pub fn key_char(&mut self, c: char, pressed: bool) -> Result<(), InjectError> {
        let cp = c as u32;
        let keysym = codepoint_to_keysym(cp);
        self.check()?;
        if c.is_control() {
            return Err(InjectError::InvalidText);
        }
        self.refresh()?;
        let find = move |kb: &Keyboard, group| kb.find_codepoint(group, cp);
        if !pressed {
            return self.release_symbol(keysym, find);
        }
        let code = self.code_for(keysym, find)?;
        self.press_symbol(keysym, code)
    }

    /// Types composed text, such as a key's text or an IME commit. Each
    /// character gets the modifiers its level needs; held modifiers that
    /// conflict are released for that character and pressed again.
    pub fn type_text(&mut self, text: &str) -> Result<(), InjectError> {
        let strokes = strokes(text)?;
        self.bind_strokes(&strokes)?;
        for stroke in strokes {
            self.check()?;
            self.type_stroke(stroke)?;
        }
        Ok(())
    }

    /// Binds every character of `text` that the map lacks and types
    /// nothing. A paste calls it first, so text over `MAX_BINDINGS` is
    /// refused before any of it is typed.
    pub fn bind_text(&mut self, text: &str) -> Result<(), InjectError> {
        self.bind_strokes(&strokes(text)?)
    }

    fn bind_strokes(&mut self, strokes: &[Stroke]) -> Result<(), InjectError> {
        self.check()?;
        self.refresh()?;
        let points: Vec<u32> = strokes
            .iter()
            .filter_map(|s| match s {
                Stroke::Char(cp) => Some(*cp),
                Stroke::Key(_) => None,
            })
            .collect();
        self.bind_codepoints(&points)
    }

    /// Releases every key and button this injector holds. It sends only
    /// releases, so it runs without a grant.
    pub fn release_all(&mut self) -> Result<(), InjectError> {
        self.pressed_symbols.clear();
        let keys: Vec<u8> = self.held_keys.iter().rev().copied().collect();
        let buttons: Vec<u8> = self.held_buttons.iter().copied().collect();
        for code in keys {
            self.send_key(code, false)?;
        }
        for button in buttons {
            self.send_button(button, false)?;
        }
        self.conn.flush()?;
        Ok(())
    }

    /// Releases held input and waits for a reply, so the server applies the
    /// releases before the connection closes. The server can discard
    /// requests that a closed connection left unread. A watchdog shuts the
    /// socket down after `CLOSE_SYNC`, so a stalled or grabbed server cannot
    /// hang the writes or the wait.
    fn release_before_close(&mut self) {
        let Ok(fd) = self.conn.stream().as_fd().try_clone_to_owned() else {
            let _ = self.release_all();
            return;
        };
        let socket = UnixStream::from(fd);
        let (done, wait) = mpsc::channel::<()>();
        let watchdog = std::thread::spawn(move || {
            if wait.recv_timeout(CLOSE_SYNC) == Err(RecvTimeoutError::Timeout) {
                let _ = socket.shutdown(Shutdown::Both);
            }
        });
        let _ = self.release_all();
        let _ = self.conn.get_input_focus().map(|cookie| cookie.reply());
        let _ = done.send(());
        let _ = watchdog.join();
    }

    fn send_key(&mut self, code: u8, pressed: bool) -> Result<(), InjectError> {
        let kind = if pressed {
            xproto::KEY_PRESS_EVENT
        } else {
            xproto::KEY_RELEASE_EVENT
        };
        if pressed {
            self.held_keys.insert(code);
        } else {
            self.held_keys.remove(&code);
        }
        self.conn.xtest_fake_input(kind, code, 0, NONE, 0, 0, 0)?;
        Ok(())
    }

    fn send_button(&mut self, button: u8, pressed: bool) -> Result<(), InjectError> {
        let kind = if pressed {
            xproto::BUTTON_PRESS_EVENT
        } else {
            xproto::BUTTON_RELEASE_EVENT
        };
        if pressed {
            self.held_buttons.insert(button);
        } else {
            self.held_buttons.remove(&button);
        }
        self.conn.xtest_fake_input(kind, button, 0, NONE, 0, 0, 0)?;
        Ok(())
    }

    fn press_symbol(&mut self, keysym: u32, code: u8) -> Result<(), InjectError> {
        if self.held_keys.contains(&code) {
            self.send_key(code, false)?;
        }
        self.send_key(code, true)?;
        self.pressed_symbols.insert(keysym, code);
        self.conn.flush()?;
        Ok(())
    }

    /// Releases the key pressed for `keysym`, or else the key `find` gives,
    /// so Shift+C pressed and c released still pair up.
    fn release_symbol(
        &mut self,
        keysym: u32,
        find: impl Fn(&Keyboard, usize) -> Option<KeyLevel>,
    ) -> Result<(), InjectError> {
        let code = match self.pressed_symbols.remove(&keysym) {
            Some(code) => Some(code),
            None => find(self.keyboard(), self.group()?).map(|found| found.code),
        };
        let Some(code) = code.filter(|code| self.held_keys.contains(code)) else {
            return Ok(());
        };
        self.pressed_symbols.retain(|_, held| *held != code);
        self.send_key(code, false)?;
        self.conn.flush()?;
        Ok(())
    }

    /// Rereads the map when a `MappingNotify` arrived or none was read yet.
    fn refresh(&mut self) -> Result<(), InjectError> {
        while let Some(event) = self.conn.poll_for_event()? {
            match event {
                Event::MappingNotify(e) if e.request != Mapping::POINTER => {
                    self.keyboard = None;
                }
                Event::Error(e) => {
                    return Err(InjectError::Request(format!("{:?}", e.error_kind)));
                }
                _ => {}
            }
        }
        if self.keyboard.is_none() {
            self.keyboard = Some(read_keyboard(&self.conn)?);
        }
        Ok(())
    }

    fn keyboard(&self) -> &Keyboard {
        self.keyboard.as_ref().expect("keyboard read by refresh")
    }

    /// Core state: modifiers in bits 0 to 7, buttons, group in 13 and 14.
    fn state(&self) -> Result<u16, InjectError> {
        Ok(self.conn.query_pointer(self.root)?.reply()?.mask.into())
    }

    fn group(&self) -> Result<usize, InjectError> {
        Ok((self.state()? >> 13) as usize & 3)
    }

    /// The keycode `find` gives, binding `keysym` to the highest empty
    /// code first when the map lacks it.
    fn code_for(
        &mut self,
        keysym: u32,
        find: impl Fn(&Keyboard, usize) -> Option<KeyLevel>,
    ) -> Result<u8, InjectError> {
        let group = self.group()?;
        if let Some(found) = find(self.keyboard(), group) {
            return Ok(found.code);
        }
        let code = *self
            .keyboard()
            .empty_codes()
            .first()
            .ok_or(InjectError::CapacityExhausted)?;
        self.write_bindings(&[Binding {
            code,
            symbols: [keysym, keysym],
        }])?;
        find(self.keyboard(), group)
            .map(|found| found.code)
            .ok_or(InjectError::Keymap(KeymapError::BindingFailed))
    }

    /// Binds the missing codepoints of `points` and checks the reread map.
    fn bind_codepoints(&mut self, points: &[u32]) -> Result<(), InjectError> {
        let set: HashSet<u32> = points.iter().copied().collect();
        let desired = binding_symbols(points);
        let group = self.group()?;
        let plan = plan_bindings(self.keyboard(), &desired, &set, group)?;
        if plan.is_empty() {
            return Ok(());
        }
        self.write_bindings(&plan)?;
        verify_bindings(self.keyboard(), &plan, &set, group)?;
        Ok(())
    }

    /// Writes each binding as two groups of its two levels and rereads the
    /// map. Bindings are never restored.
    fn write_bindings(&mut self, plan: &[Binding]) -> Result<(), InjectError> {
        if self.bindings + plan.len() > MAX_BINDINGS {
            return Err(InjectError::CapacityExhausted);
        }
        for binding in plan {
            let [a, b] = binding.symbols;
            self.bindings += 1;
            self.conn
                .change_keyboard_mapping(1, binding.code, 4, &[a, b, a, b])?
                .check()?;
        }
        self.keyboard = Some(read_keyboard(&self.conn)?);
        Ok(())
    }

    fn type_stroke(&mut self, stroke: Stroke) -> Result<(), InjectError> {
        match stroke {
            Stroke::Key(keysym) => {
                let code = self.code_for(keysym, |kb, group| kb.find_keysym(group, keysym))?;
                // A Tab or line break in text is never a shortcut or a
                // Shift+Tab either.
                let held = self.down_keycodes()?;
                let release = self.state()? as u8
                    & self.releasable_mask(&held)
                    & (SHORTCUT_MASK | SHIFT_MASK);
                let changes = self.modifier_changes(0, release, &held);
                self.tap_with(code, &changes)
            }
            Stroke::Char(cp) => self.type_codepoint(cp),
        }
    }

    /// Taps `code` with modifier `changes` applied, then undoes them.
    fn tap_with(&mut self, code: u8, changes: &[(u8, bool)]) -> Result<(), InjectError> {
        for &(code, pressed) in changes {
            self.send_key(code, pressed)?;
        }
        self.tap(code)?;
        for &(code, pressed) in changes.iter().rev() {
            self.send_key(code, !pressed)?;
        }
        self.conn.flush()?;
        Ok(())
    }

    fn tap(&mut self, code: u8) -> Result<(), InjectError> {
        if self.held_keys.contains(&code) {
            self.send_key(code, false)?;
        }
        self.send_key(code, true)?;
        self.send_key(code, false)?;
        self.conn.flush()?;
        Ok(())
    }

    fn type_codepoint(&mut self, cp: u32) -> Result<(), InjectError> {
        let state = self.state()?;
        let group = (state >> 13) as usize & 3;
        let keyboard = self.keyboard();
        let found = keyboard
            .find_codepoint(group, cp)
            .ok_or(InjectError::Unmappable)?;
        let key_type = keyboard
            .type_of(found.code, group)
            .ok_or(InjectError::Unmappable)?;
        let held = self.down_keycodes()?;
        let releasable = self.releasable_mask(&held);
        let mut plan = reconcile(
            key_type,
            found.level,
            state as u8,
            self.keyboard().pressable_mask(),
            releasable,
        )
        .ok_or(InjectError::Unmappable)?;
        // Text is never a shortcut: a held Control, Alt or Super that the
        // level does not use is released for the character.
        plan.release |= state as u8 & releasable & SHORTCUT_MASK & !key_type.mask;
        let changes = self.modifier_changes(plan.press, plan.release, &held);
        self.tap_with(found.code, &changes)
    }

    /// Keycodes the server reports down now.
    fn down_keycodes(&self) -> Result<Vec<u8>, InjectError> {
        let keys = self.conn.query_keymap()?.reply()?.keys;
        Ok((0..=255u8)
            .filter(|&code| keys[code as usize / 8] & (1 << (code % 8)) != 0)
            .collect())
    }

    /// Modifier bits that some held key of ours sets, so releasing it turns
    /// the bit off. Locked bits have none.
    fn releasable_mask(&self, held: &[u8]) -> u8 {
        let rows = &self.keyboard().modifiers.rows;
        (0..8)
            .filter(|&bit| {
                let codes: Vec<u8> = rows[bit]
                    .iter()
                    .copied()
                    .filter(|code| held.contains(code))
                    .collect();
                !codes.is_empty() && codes.iter().all(|code| self.held_keys.contains(code))
            })
            .fold(0, |mask, bit| mask | 1 << bit)
    }

    /// Key presses and releases that turn on `press` and turn off `release`.
    fn modifier_changes(&self, press: u8, release: u8, held: &[u8]) -> Vec<(u8, bool)> {
        let keyboard = self.keyboard();
        let mut changes = Vec::new();
        for bit in 0..8 {
            if press & (1 << bit) != 0 {
                if let Some(code) = keyboard.press_code(bit) {
                    changes.push((code, true));
                }
            }
            if release & (1 << bit) != 0 {
                let codes = keyboard.modifiers.rows[bit].iter();
                changes.extend(codes.filter(|c| held.contains(c)).map(|&c| (c, false)));
            }
        }
        changes
    }
}

impl<C: Clock> crate::control::Sink for Injector<C> {
    fn grant(&mut self, lease_id: &str, until: Instant) -> Result<(), String> {
        Injector::grant(self, lease_id, until).map_err(|e| e.to_string())
    }

    fn revoke(&mut self) -> Result<(), String> {
        Injector::revoke(self).map_err(|e| e.to_string())
    }

    fn release_all(&mut self) -> Result<(), String> {
        Injector::release_all(self).map_err(|e| e.to_string())
    }
}

impl<C: Clock> Drop for Injector<C> {
    fn drop(&mut self) {
        self.release_before_close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn gate_refuses_after_expiry_and_revoke() {
        let start = Instant::now();
        let mut gate = Gate::default();
        assert!(matches!(gate.check(start), Err(InjectError::NotGranted)));

        assert!(!gate.grant("lease-1", start + Duration::from_secs(10)));
        assert!(gate.check(start).is_ok());
        assert!(gate.check(start + Duration::from_secs(9)).is_ok());
        assert!(matches!(
            gate.check(start + Duration::from_secs(10)),
            Err(InjectError::NotGranted)
        ));
        // An expired grant stays gone even if the clock went back.
        assert!(gate.check(start).is_err());
        assert_eq!(gate.lease_id(), None);

        gate.grant("lease-1", start + Duration::from_secs(10));
        assert!(!gate.grant("lease-1", start + Duration::from_secs(20)));
        assert!(gate.check(start + Duration::from_secs(15)).is_ok());
        assert!(gate.grant("lease-2", start + Duration::from_secs(20)));
        assert_eq!(gate.lease_id(), Some("lease-2"));
        gate.revoke();
        assert!(gate.check(start).is_err());
    }

    #[test]
    fn grant_in_the_past_is_refused() {
        let now = Instant::now();
        let mut gate = Gate::default();
        gate.grant("lease", now);
        assert!(gate.check(now).is_err());
    }

    #[test]
    fn scroll_accumulates_lines_and_pixels() {
        let mut scroll = ScrollAccumulator::default();
        assert_eq!(scroll.lines(0.0, 1.0), vec![(4, 1)]);
        assert_eq!(scroll.lines(0.0, -3.0), vec![(5, 3)]);
        assert_eq!(scroll.lines(2.0, 0.0), vec![(6, 2)]);
        assert_eq!(scroll.lines(-1.0, 0.0), vec![(7, 1)]);
        assert_eq!(scroll.lines(0.0, 0.5), vec![]);
        assert_eq!(scroll.lines(0.0, 0.5), vec![(4, 1)]);

        let mut scroll = ScrollAccumulator::default();
        assert_eq!(scroll.pixels(0.0, 15.0), vec![]);
        assert_eq!(scroll.pixels(0.0, 15.0), vec![(4, 1)]);
        assert_eq!(scroll.pixels(0.0, 30.0), vec![(4, 2)]);
        assert_eq!(scroll.pixels(0.0, -50.0), vec![(5, 2)]);
        assert_eq!(scroll.pixels(-45.0, 0.0), vec![(7, 2)]);
        assert_eq!(scroll.pixels(5.0, 0.0), vec![]);
        assert_eq!(scroll.pixels(f64::NAN, f64::INFINITY), vec![]);
        assert_eq!(scroll.pixels(0.0, 20.0), vec![(4, 1)]);

        // Reversing drops the old remainder.
        let mut scroll = ScrollAccumulator::default();
        assert_eq!(scroll.pixels(0.0, 15.0), vec![]);
        assert_eq!(scroll.pixels(0.0, -15.0), vec![]);
        assert_eq!(scroll.pixels(0.0, -5.0), vec![(5, 1)]);
        assert_eq!(scroll.pixels(0.0, 45.0), vec![(4, 2)]);
        assert_eq!(scroll.lines(0.0, -1.0), vec![(5, 1)]);

        let mut scroll = ScrollAccumulator::default();
        assert_eq!(
            scroll.lines(-1e9, 1e9),
            vec![(4, MAX_SCROLL_STEPS), (7, MAX_SCROLL_STEPS)]
        );
    }

    #[test]
    fn maps_buttons_and_text_strokes() {
        let numbers: Vec<u8> = [
            Button::Left,
            Button::Middle,
            Button::Right,
            Button::Back,
            Button::Forward,
        ]
        .iter()
        .map(|b| b.number())
        .collect();
        assert_eq!(numbers, vec![1, 2, 3, 8, 9]);
        assert_eq!(
            strokes("a\r\n\té").unwrap(),
            vec![
                Stroke::Char(0x61),
                Stroke::Key(named::RETURN),
                Stroke::Key(named::RETURN),
                Stroke::Key(named::TAB),
                Stroke::Char(0xe9),
            ]
        );
        assert!(matches!(strokes("\u{3}"), Err(InjectError::InvalidText)));
        assert!(matches!(strokes("\0"), Err(InjectError::InvalidText)));
        assert!(strokes(&"a".repeat(MAX_TEXT_CHARS)).is_ok());
        assert!(strokes(&"a".repeat(MAX_TEXT_CHARS + 1)).is_err());
    }
}
