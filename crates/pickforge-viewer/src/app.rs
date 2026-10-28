//! The window: winit events, softbuffer presentation, modes and the stdio
//! host channel.

use crate::args::{self, Config, Placement};
use crate::capture::{Capture, Control, CursorImage, Shared};
use crate::control::{Controller, Effect};
use crate::geometry::{self, Rect};
use crate::input::{self, InjectError, Injector};
use crate::keysyms::{self, named};
use crate::protocol::{
    self, Backend, Command, Event, HostMode, Line, LineReader, Mode, StatusCode,
};
use crate::pulse::Pulse;
use crate::scale::Scaler;
use crate::ui::{self, palette, Banner, Bar, BarKind, Button, Canvas, Metrics, Text};
use crate::{procstat, EXIT_DISPLAY, EXIT_NO_WINDOW_SYSTEM};
use softbuffer::{Context, Surface};
use std::collections::HashMap;
use std::io;
use std::num::NonZeroU32;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use winit::application::ApplicationHandler;
use winit::dpi::{LogicalSize, PhysicalSize};
use winit::event::{
    ElementState, Ime, KeyEvent, Modifiers, MouseButton, MouseScrollDelta, StartCause, WindowEvent,
};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::{Key, KeyLocation, NamedKey, PhysicalKey};
use winit::platform::wayland::{ActiveEventLoopExtWayland, WindowAttributesExtWayland};
use winit::platform::x11::WindowAttributesExtX11;
use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
use winit::window::{CursorIcon, Fullscreen, Window, WindowAttributes, WindowId};
use x11rb::protocol::xproto::{ConnectionExt as _, MapState};
use x11rb::rust_connection::RustConnection;

/// Refresh X11 mapping and iconic state even without window events.
const X11_PAUSE_INTERVAL: Duration = Duration::from_millis(250);
/// A redraw waiting this long for a frame callback means capture pauses.
const HIDDEN_AFTER: Duration = Duration::from_millis(500);
/// After stdin closes, the process exits by this deadline even if the
/// event loop is stuck.
const STDIN_EXIT_DEADLINE: Duration = Duration::from_millis(900);

#[derive(Debug)]
enum UserEvent {
    Command(Command),
    StdinClosed,
    Capture,
}

fn log(message: &str) {
    eprintln!("pickforge-viewer: {message}");
}

fn emit(event: &Event) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    if let Err(e) = protocol::write_event(&mut out, event) {
        log(&format!("cannot write to the host: {e}"));
    }
}

fn fatal(exit: i32, code: &str, message: &str) -> i32 {
    log(message);
    emit(&Event::Error {
        code: code.into(),
        message: message.into(),
    });
    exit
}

pub fn run(config: Config) -> i32 {
    let own = std::env::var("DISPLAY").ok();
    if args::is_own_display(own.as_deref(), config.display) {
        return fatal(
            EXIT_DISPLAY,
            "display-refused",
            "the session display is the viewer's own DISPLAY",
        );
    }
    if procstat::read_start_ticks(config.xvfb_pid) != Some(config.xvfb_start_ticks) {
        return fatal(
            EXIT_DISPLAY,
            "xvfb-mismatch",
            "the Xvfb process is gone or its start time differs",
        );
    }
    let capture = match Capture::connect(config.display) {
        Ok(capture) => capture,
        Err(e) => return fatal(EXIT_DISPLAY, "display-open", &e.to_string()),
    };
    let session = capture.size();
    if session != (config.width, config.height) {
        log(&format!(
            "the session is {}x{}, not {}x{}; using the real size",
            session.0, session.1, config.width, config.height
        ));
    }

    let event_loop = match EventLoop::<UserEvent>::with_user_event().build() {
        Ok(event_loop) => event_loop,
        Err(e) => {
            return fatal(
                EXIT_NO_WINDOW_SYSTEM,
                "no-window-system",
                &format!("no window system: {e}"),
            )
        }
    };

    let control = match Control::new() {
        Ok(control) => control,
        Err(e) => {
            return fatal(
                1,
                "internal",
                &format!("cannot create the capture control: {e}"),
            )
        }
    };
    let shared = Arc::new(Mutex::new(Shared::new(session.0, session.1)));
    let capture_pending = Arc::new(AtomicBool::new(false));

    let proxy = event_loop.create_proxy();
    thread::spawn(move || read_host(proxy));

    {
        let proxy = event_loop.create_proxy();
        let (shared, control, pending) = (shared.clone(), control.clone(), capture_pending.clone());
        let xvfb = Some((config.xvfb_pid, config.xvfb_start_ticks));
        thread::spawn(move || {
            capture.run(shared, control, xvfb, move || {
                if !pending.swap(true, Ordering::SeqCst) {
                    let _ = proxy.send_event(UserEvent::Capture);
                }
            })
        });
    }

    // Input uses its own connection. Without XTEST or XKB the viewer stays
    // watch only and offers no Take control.
    let injector = match Injector::connect(config.display) {
        Ok(injector) => Some(injector),
        Err(e) => {
            log(&format!("input is unavailable: {e}"));
            None
        }
    };

    let mut app = App::new(config, session, shared, control, capture_pending, injector);
    event_loop.set_control_flow(ControlFlow::Wait);
    if let Err(e) = event_loop.run_app(&mut app) {
        return fatal(
            EXIT_NO_WINDOW_SYSTEM,
            "event-loop",
            &format!("event loop failed: {e}"),
        );
    }
    app.exit.unwrap_or(0)
}

/// Reads host commands until end of file, then makes sure the process
/// exits within one second.
fn read_host(proxy: winit::event_loop::EventLoopProxy<UserEvent>) {
    let stdin = io::stdin();
    let mut reader = LineReader::new(stdin.lock());
    loop {
        match reader.next_line() {
            Ok(Some(Line::Message(bytes))) => {
                if bytes.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                match protocol::parse_command(&bytes) {
                    Ok(Command::Unknown(name)) => log(&format!("ignored unknown command {name:?}")),
                    Ok(command) => {
                        if proxy.send_event(UserEvent::Command(command)).is_err() {
                            return;
                        }
                    }
                    Err(e) => log(&format!("ignored host message: {e}")),
                }
            }
            Ok(Some(Line::TooLong)) => log("ignored host message over 64 KiB"),
            Ok(None) => break,
            Err(e) => {
                log(&format!("cannot read from the host: {e}"));
                break;
            }
        }
    }
    let _ = proxy.send_event(UserEvent::StdinClosed);
    thread::sleep(STDIN_EXIT_DEADLINE);
    std::process::exit(0);
}

struct App {
    config: Config,
    session: (u32, u32),
    shared: Arc<Mutex<Shared>>,
    control: Arc<Control>,
    capture_pending: Arc<AtomicBool>,

    window: Option<Rc<Window>>,
    x11_visibility: Option<X11Visibility>,
    next_pause_check: Instant,
    surface: Option<Surface<Rc<Window>, Rc<Window>>>,
    backend: Backend,
    size: PhysicalSize<u32>,
    metrics: Metrics,
    text: Text,
    mode: Mode,

    canvas: Vec<u32>,
    scaled: Vec<u32>,
    scaler: Option<Scaler>,
    image: Rect,
    bar: Option<Bar>,
    rescale_all: bool,
    src_dirty: Option<Rect>,
    damage: Option<(i32, i32)>,

    cursor: Option<Arc<CursorImage>>,
    cursor_pos: (i32, i32),
    cursor_drawn: Option<Rect>,
    /// The ring of the last completed agent click, while it runs.
    pulse: Option<Pulse>,

    pointer: Option<(f64, f64)>,
    hover: Option<Button>,
    pressed: Option<Button>,
    thumb_press: bool,

    controller: Controller<Injector>,
    banner: Option<Banner>,
    /// The thumbnail's session label pill and its fitted text.
    label_pill: Option<(Rect, String)>,
    ime_allowed: bool,
    modifiers: Modifiers,
    /// What each held physical key sent, so its release matches.
    keys: HashMap<PhysicalKey, Sent>,

    status: Option<StatusCode>,
    ended: bool,
    have_frame: bool,
    ready_sent: bool,

    occluded: bool,
    hidden: bool,
    redraw_since: Option<Instant>,

    exit: Option<i32>,
}

impl App {
    fn new(
        config: Config,
        session: (u32, u32),
        shared: Arc<Mutex<Shared>>,
        control: Arc<Control>,
        capture_pending: Arc<AtomicBool>,
        injector: Option<Injector>,
    ) -> Self {
        Self {
            config,
            session,
            shared,
            control,
            capture_pending,
            window: None,
            x11_visibility: None,
            next_pause_check: Instant::now(),
            surface: None,
            backend: Backend::X11,
            size: PhysicalSize::new(0, 0),
            metrics: Metrics { scale: 1.0 },
            text: Text::new(),
            mode: Mode::Thumbnail,
            canvas: Vec::new(),
            scaled: Vec::new(),
            scaler: None,
            image: Rect::default(),
            bar: None,
            rescale_all: true,
            src_dirty: None,
            damage: None,
            cursor: None,
            cursor_pos: (0, 0),
            cursor_drawn: None,
            pulse: None,
            pointer: None,
            hover: None,
            pressed: None,
            thumb_press: false,
            controller: Controller::new(injector),
            banner: None,
            label_pill: None,
            ime_allowed: false,
            modifiers: Modifiers::default(),
            keys: HashMap::new(),
            status: Some(StatusCode::Connecting),
            ended: false,
            have_frame: false,
            ready_sent: false,
            occluded: false,
            hidden: false,
            redraw_since: None,
            exit: None,
        }
    }

    fn thumbnail_logical(&self) -> (u32, u32) {
        geometry::thumbnail_size(self.config.thumbnail_width, self.session.0, self.session.1)
    }

    /// The session size plus the bar, capped to 90 % of the monitor.
    fn expanded_logical(&self) -> (u32, u32) {
        let limit = self
            .window
            .as_ref()
            .and_then(|w| w.current_monitor())
            .map(|m| {
                let size = m.size().to_logical::<f64>(m.scale_factor());
                ((size.width * 0.9) as u32, (size.height * 0.9) as u32)
            });
        geometry::expanded_size(self.session.0, self.session.1, ui::BAR_HEIGHT, limit)
    }

    fn create_window(&mut self, event_loop: &ActiveEventLoop) -> Result<(), String> {
        let (w, h) = self.thumbnail_logical();
        let class = self.config.class.clone();
        let attributes: WindowAttributes = Window::default_attributes()
            .with_title(args::window_title(self.config.label.as_deref()))
            .with_decorations(false)
            .with_resizable(true)
            .with_active(false)
            .with_inner_size(LogicalSize::new(w, h))
            .with_min_inner_size(LogicalSize::new(64, 36));
        // Both set the Wayland app_id or the X11 WM_CLASS.
        let attributes = if event_loop.is_wayland() {
            self.backend = Backend::Wayland;
            WindowAttributesExtWayland::with_name(attributes, class.clone(), class)
        } else {
            self.backend = Backend::X11;
            WindowAttributesExtX11::with_name(attributes, class.clone(), class)
        };
        let window = Rc::new(
            event_loop
                .create_window(attributes)
                .map_err(|e| e.to_string())?,
        );
        let context = Context::new(window.clone()).map_err(|e| e.to_string())?;
        let surface = Surface::new(&context, window.clone()).map_err(|e| e.to_string())?;
        window.set_cursor(CursorIcon::Pointer);
        self.metrics = Metrics {
            scale: window.scale_factor(),
        };
        self.size = window.inner_size();
        if let Ok(handle) = window.window_handle() {
            if let RawWindowHandle::Xlib(handle) = handle.as_raw() {
                self.x11_visibility = X11Visibility::connect(handle.window as u32);
            }
        }
        self.window = Some(window);
        self.surface = Some(surface);
        self.relayout();
        Ok(())
    }

    fn request_redraw(&mut self) {
        if let Some(window) = &self.window {
            if self.redraw_since.is_none() {
                self.redraw_since = Some(Instant::now());
            }
            window.request_redraw();
        }
    }

    fn damage_rows(&mut self, y0: i32, y1: i32) {
        let y0 = y0.max(0);
        let y1 = y1.min(self.size.height as i32);
        if y1 <= y0 {
            return;
        }
        self.damage = Some(
            self.damage
                .map_or((y0, y1), |(a, b)| (a.min(y0), b.max(y1))),
        );
        self.request_redraw();
    }

    fn damage_all(&mut self) {
        self.damage_rows(0, self.size.height as i32);
    }

    fn damage_bar(&mut self) {
        if let Some(bar) = &self.bar {
            let h = bar.rect.h as i32;
            self.damage_rows(0, h);
        }
    }

    fn relayout(&mut self) {
        let (w, h) = (self.size.width, self.size.height);
        self.update_pause();
        self.sync_ime();
        if w == 0 || h == 0 {
            return;
        }
        self.canvas.resize((w * h) as usize, palette::SURFACE);
        let kind = if self.controller.controlling() {
            BarKind::Control
        } else {
            BarKind::Watch {
                take: self.controller.can_take(),
            }
        };
        self.bar = (self.mode != Mode::Thumbnail).then(|| {
            Bar::layout(
                w,
                self.metrics,
                self.mode == Mode::Fullscreen,
                kind,
                &mut self.text,
            )
        });
        let top = self.bar.as_ref().map_or(0, |b| b.rect.h).min(h);
        let content = Rect::new(0, top as i32, w, h - top);
        self.label_pill = match &self.config.label {
            Some(label) if self.mode == Mode::Thumbnail => {
                let shown = self.text.displayable(label);
                ui::session_label(content, &shown, self.metrics, &mut self.text)
            }
            _ => None,
        };
        // A thumbnail that asks for help still shows which session it is.
        let banner_area = match &self.label_pill {
            Some((pill, _)) => Rect::new(
                content.x,
                pill.bottom(),
                content.w,
                (content.bottom() - pill.bottom()).max(0) as u32,
            ),
            None => content,
        };
        self.layout_banner(banner_area);
        let image = geometry::fit(self.session.0, self.session.1, content);
        if image != self.image || self.scaler.is_none() {
            self.image = image;
            self.scaler = (!image.is_empty())
                .then(|| Scaler::new(self.session.0, self.session.1, image.w, image.h));
            self.scaled.resize((image.w * image.h) as usize, 0);
            self.rescale_all = true;
        }
        if let Some(surface) = &mut self.surface {
            if let (Some(nw), Some(nh)) = (NonZeroU32::new(w), NonZeroU32::new(h)) {
                if let Err(e) = surface.resize(nw, nh) {
                    log(&format!("cannot resize the surface: {e}"));
                }
            }
        }
        self.cursor_drawn = None;
        self.update_hover();
        self.damage_all();
    }

    fn sync_ime(&mut self) {
        // IME commits are text for the session, so IME is on only then.
        let ime = self.controller.forwarding(self.mode);
        if ime == self.ime_allowed {
            return;
        }
        if let Some(window) = &self.window {
            window.set_ime_allowed(ime);
            self.ime_allowed = ime;
        }
    }

    fn layout_banner(&mut self, content: Rect) {
        // The banner hides while controlling. The thumbnail shows the
        // message only, because a thumbnail click only expands.
        let with_button = self.mode != Mode::Thumbnail && self.controller.can_take();
        self.banner = match self.controller.attention() {
            Some(message) if !self.controller.controlling() => {
                Banner::layout(content, message, self.metrics, with_button, &mut self.text)
            }
            _ => None,
        };
    }

    fn update_pause(&mut self) {
        let zero = self.size.width == 0 || self.size.height == 0;
        let minimized = self
            .window
            .as_ref()
            .and_then(|w| w.is_minimized())
            .unwrap_or(false);
        let x11_hidden = self
            .x11_visibility
            .as_ref()
            .is_some_and(X11Visibility::is_hidden);
        let paused = [self.occluded, self.hidden, zero, minimized, x11_hidden]
            .into_iter()
            .any(|paused| paused);
        self.control.set_paused(paused);
    }

    fn refresh_x11_pause(&mut self, now: Instant) -> Option<Instant> {
        self.x11_visibility.as_ref()?;
        if now >= self.next_pause_check {
            self.update_pause();
            self.next_pause_check = now + X11_PAUSE_INTERVAL;
        }
        Some(self.next_pause_check)
    }

    fn set_status(&mut self, status: Option<StatusCode>) {
        if self.status != status {
            self.status = status;
            self.damage_all();
        }
    }

    fn end_session(&mut self) {
        if !self.ended {
            self.ended = true;
            self.control.stop();
            self.controller.end_session();
            self.keys.clear();
            self.relayout();
        }
        self.set_status(Some(StatusCode::SessionEnded));
    }

    fn set_mode(&mut self, mode: Mode, logical: Option<(u32, u32)>) {
        let Some(window) = self.window.clone() else {
            return;
        };
        if self.mode == Mode::Fullscreen && mode != Mode::Fullscreen {
            window.set_fullscreen(None);
        }
        let changed = self.mode != mode;
        if mode == Mode::Thumbnail && self.controller.controlling() {
            self.controller.release_held();
            self.keys.clear();
        }
        self.mode = mode;
        window.set_cursor(if mode == Mode::Thumbnail {
            CursorIcon::Pointer
        } else {
            CursorIcon::Default
        });
        if let Some((w, h)) = logical {
            if let Some(size) = window.request_inner_size(LogicalSize::new(w, h)) {
                self.size = size;
            }
        }
        self.pressed = None;
        self.thumb_press = false;
        self.relayout();
        if changed {
            emit(&Event::Mode { mode });
        }
    }

    fn expand(&mut self) {
        match self.config.placement {
            Placement::Host => emit(&Event::ExpandRequested),
            Placement::SelfPlaced => {
                let size = self.expanded_logical();
                self.set_mode(Mode::Expanded, Some(size));
            }
        }
    }

    fn collapse(&mut self) {
        if self.mode == Mode::Fullscreen {
            self.set_mode(Mode::Expanded, None);
        }
        match self.config.placement {
            Placement::Host => emit(&Event::CollapseRequested),
            Placement::SelfPlaced => {
                let size = self.thumbnail_logical();
                self.set_mode(Mode::Thumbnail, Some(size));
            }
        }
    }

    fn toggle_fullscreen(&mut self) {
        let Some(window) = self.window.clone() else {
            return;
        };
        if self.mode == Mode::Fullscreen {
            self.set_mode(Mode::Expanded, None);
        } else {
            window.set_fullscreen(Some(Fullscreen::Borderless(None)));
            self.set_mode(Mode::Fullscreen, None);
        }
    }

    /// Closing while controlling returns control first.
    fn close(&mut self) {
        for event in self.controller.close() {
            emit(&event);
        }
        self.exit = Some(0);
    }

    /// Ends control without asking the host and exits.
    fn quit(&mut self) {
        self.controller.stop();
        self.exit = Some(0);
    }

    fn activate(&mut self, button: Button) {
        match button {
            Button::Fullscreen => self.toggle_fullscreen(),
            Button::Collapse => self.collapse(),
            Button::Close => self.close(),
            Button::TakeControl | Button::BannerTake => {
                if let Some(event) = self.controller.take(Instant::now()) {
                    emit(&event);
                }
            }
            Button::ReturnControl => {
                self.keys.clear();
                if let Some(event) = self.controller.give_back() {
                    emit(&event);
                }
                self.control_changed();
            }
        }
    }

    /// Redraws the bar, banner and status after a control change.
    fn control_changed(&mut self) {
        if !self.controller.controlling() {
            self.keys.clear();
        } else {
            // The human clicks now, so an agent ring would mislead.
            self.pulse = None;
        }
        self.pressed = None;
        self.relayout();
    }

    fn hit(&self, x: f64, y: f64) -> Option<Button> {
        let bar = self.bar.as_ref().and_then(|bar| bar.hit(x, y));
        bar.or_else(|| self.banner.as_ref().and_then(|b| b.hit(x, y)))
    }

    fn update_hover(&mut self) {
        let hover = self.pointer.and_then(|(x, y)| self.hit(x, y));
        if hover != self.hover {
            self.hover = hover;
            self.damage_all_controls();
        }
    }

    fn damage_all_controls(&mut self) {
        if let Some(banner) = &self.banner {
            let rect = banner.rect;
            self.damage_rows(rect.y, rect.bottom());
        }
        self.damage_bar();
    }

    fn on_mouse(&mut self, state: ElementState, button: MouseButton) {
        if self.forward_button(state, button) {
            return;
        }
        if button != MouseButton::Left {
            return;
        }
        let Some((x, y)) = self.pointer else {
            return;
        };
        match (state, self.mode) {
            (ElementState::Pressed, Mode::Thumbnail) => self.thumb_press = true,
            (ElementState::Released, Mode::Thumbnail) => {
                if std::mem::take(&mut self.thumb_press) {
                    self.expand();
                }
            }
            (ElementState::Pressed, _) => {
                self.press_bar(x, y);
            }
            (ElementState::Released, _) => {
                self.release_bar();
            }
        }
    }

    fn press_bar(&mut self, x: f64, y: f64) {
        if let Some(hit) = self.hit(x, y) {
            self.pressed = Some(hit);
            self.damage_all_controls();
        } else if self.bar.as_ref().is_some_and(|bar| bar.rect.contains(x, y)) {
            if let Some(window) = &self.window {
                let _ = window.drag_window();
            }
        }
    }

    fn release_bar(&mut self) {
        if let Some(pressed) = self.pressed.take() {
            self.damage_all_controls();
            if self.hover == Some(pressed) {
                self.activate(pressed);
            }
        }
    }

    /// The session pixel under the pointer while input is forwarded. The
    /// bar, the letterbox and the thumbnail map to nothing.
    fn session_pointer(&self) -> Option<(i32, i32)> {
        if !self.controller.forwarding(self.mode) {
            return None;
        }
        let (x, y) = self.pointer?;
        if self.bar.as_ref().is_some_and(|bar| bar.rect.contains(x, y)) {
            return None;
        }
        let (sx, sy) = geometry::session_point(self.image, self.session.0, self.session.1, x, y)?;
        Some((sx as i32, sy as i32))
    }

    /// Runs `send` on the injector while input is forwarded. A refused
    /// grant ends control in the window too.
    fn forward(&mut self, send: impl FnOnce(&mut Injector) -> Result<(), InjectError>) {
        if !self.controller.forwarding(self.mode) {
            return;
        }
        let Some(injector) = self.controller.sink_mut() else {
            return;
        };
        match send(injector) {
            Ok(()) => {}
            Err(InjectError::NotGranted) => {
                if self.controller.tick(Instant::now()) {
                    self.control_changed();
                }
            }
            Err(e) => log(&format!("input not sent: {e}")),
        }
    }

    fn on_pointer_moved(&mut self) {
        if let Some((sx, sy)) = self.session_pointer() {
            self.forward(|injector| injector.motion(sx, sy));
        }
    }

    /// Sends a button to the session. A release always goes out when the
    /// session holds that button, wherever the pointer is. Returns true
    /// when the window must not handle the click itself.
    fn forward_button(&mut self, state: ElementState, button: MouseButton) -> bool {
        if !self.controller.forwarding(self.mode) {
            return false;
        }
        let Some(button) = input_button(button) else {
            return false;
        };
        let held = self
            .controller
            .sink_mut()
            .is_some_and(|injector| injector.held_buttons().any(|b| b == button.number()));
        match state {
            ElementState::Released if held => {
                self.forward(|injector| injector.button(button, false));
                true
            }
            ElementState::Pressed => match self.session_pointer() {
                Some((sx, sy)) => {
                    self.forward(|injector| {
                        injector.motion(sx, sy)?;
                        injector.button(button, true)
                    });
                    true
                }
                None => false,
            },
            ElementState::Released => false,
        }
    }

    fn on_wheel(&mut self, delta: MouseScrollDelta) {
        if self.session_pointer().is_none() {
            return;
        }
        match delta {
            MouseScrollDelta::LineDelta(x, y) => {
                self.forward(|injector| injector.scroll_lines(x as f64, y as f64))
            }
            MouseScrollDelta::PixelDelta(p) => {
                self.forward(|injector| injector.scroll_pixels(p.x, p.y))
            }
        }
    }

    /// Sends a key to the session while controlling. Composed text goes as
    /// text; named keys, modifiers and chords go as keys.
    fn on_key(&mut self, event: KeyEvent) {
        let physical = event.physical_key;
        if event.state == ElementState::Released {
            match self.keys.remove(&physical) {
                Some(Sent::Key(keysym)) => self.forward(|i| i.key(keysym, false)),
                Some(Sent::Char(c)) => self.forward(|i| i.key_char(c, false)),
                Some(Sent::Text) | None => {}
            }
            return;
        }
        let state = self.modifiers.state();
        let chord = state.control_key() || state.alt_key() || state.super_key();
        let sent = if let Some(keysym) = named_keysym(&event.logical_key, event.location) {
            self.forward(|i| i.key(keysym, true));
            Sent::Key(keysym)
        } else if let Key::Dead(_) = event.logical_key {
            // The host composes dead keys into the next key's text.
            return;
        } else if let Some(text) = event.text.as_ref().filter(|t| !chord && is_text(t)) {
            let text = text.to_string();
            self.forward(|i| i.type_text(&text));
            Sent::Text
        } else if let Some(c) = single_char(&event.logical_key) {
            self.forward(|i| i.key_char(c, true));
            Sent::Char(c)
        } else {
            return;
        };
        self.keys.insert(physical, sent);
    }

    fn on_focus_lost(&mut self) {
        self.keys.clear();
        if self.controller.controlling() {
            self.controller.release_held();
        }
    }

    fn on_command(&mut self, command: Command) {
        match command {
            Command::SetMode { mode, size } => match mode {
                HostMode::Thumbnail => {
                    let size = size.unwrap_or_else(|| self.thumbnail_logical());
                    self.set_mode(Mode::Thumbnail, Some(size));
                }
                HostMode::Expanded => {
                    let size = size.or_else(|| {
                        (self.config.placement == Placement::SelfPlaced)
                            .then(|| self.expanded_logical())
                    });
                    self.set_mode(Mode::Expanded, size);
                }
            },
            Command::Status(code) => self.set_status(Some(code)),
            Command::SessionEnded => self.end_session(),
            Command::Shutdown => self.quit(),
            Command::Pulse { x, y } => self.start_pulse(x, y, Instant::now()),
            Command::Unknown(name) => log(&format!("ignored unknown command {name:?}")),
            command @ (Command::Attention { .. }
            | Command::ClearAttention
            | Command::Grant { .. }
            | Command::Revoke { .. }) => {
                let effects = self
                    .controller
                    .on_command(&command, self.mode, Instant::now());
                self.control_changed();
                for effect in effects {
                    match effect {
                        Effect::Emit(event) => emit(&event),
                        Effect::Expand => {
                            if self.mode == Mode::Thumbnail {
                                self.expand();
                            }
                        }
                    }
                }
            }
        }
    }

    /// Shows a ring at a session pixel. There is none while the human holds
    /// control or after the session ended.
    fn start_pulse(&mut self, x: u32, y: u32, now: Instant) {
        if self.controller.controlling() || self.ended {
            return;
        }
        let Some(next) = Pulse::new(x, y, self.session, now) else {
            log("ignored a pulse outside the session");
            return;
        };
        self.damage_pulse();
        self.pulse = Some(next);
        self.damage_pulse();
    }

    fn damage_pulse(&mut self) {
        if let Some(pulse) = &self.pulse {
            let rect = pulse.bounds(self.image, self.session, self.metrics.scale);
            self.damage_rows(rect.y, rect.bottom());
        }
    }

    /// Redraws a running pulse at the frame rate and clears it at the end.
    /// Returns when the next frame is due.
    fn tick_pulse(&mut self, now: Instant) -> Option<Instant> {
        let pulse = self.pulse.as_mut()?;
        let done = pulse.done(now);
        if done || pulse.frame_due(now) {
            self.damage_pulse();
        }
        if done {
            self.pulse = None;
        }
        self.pulse.as_ref().map(Pulse::next_frame)
    }

    /// The status pill text: the host's status first, then a control note.
    fn status_text(&self) -> Option<&'static str> {
        self.status
            .map(StatusCode::text)
            .or_else(|| self.controller.note().map(|note| note.text()))
    }

    /// Takes what the capture thread produced since the last call.
    fn on_capture(&mut self) {
        self.capture_pending.store(false, Ordering::SeqCst);
        let (dirty, cursor, ended) = {
            let mut s = self.shared.lock().unwrap();
            let cursor =
                std::mem::take(&mut s.cursor_changed).then(|| (s.cursor.clone(), s.cursor_pos));
            (s.dirty.take(), cursor, s.ended)
        };
        if let Some(dirty) = dirty {
            self.src_dirty = Some(self.src_dirty.map_or(dirty, |d| d.union(&dirty)));
            self.have_frame = true;
            if self.status == Some(StatusCode::Connecting) {
                self.set_status(None);
            }
            self.request_redraw();
        }
        if let Some((image, pos)) = cursor {
            if let Some(rect) = self.cursor_drawn {
                self.damage_rows(rect.y, rect.bottom());
            }
            self.cursor = image;
            self.cursor_pos = pos;
            if let Some((rect, _)) = self.cursor_rect() {
                self.damage_rows(rect.y, rect.bottom());
            }
        }
        if let Some(reason) = ended {
            if !self.ended {
                emit(&Event::SessionEnded { reason });
                self.end_session();
            }
        }
    }

    /// Where the cursor sits in the window, clipped to the image.
    fn cursor_rect(&self) -> Option<(Rect, f64)> {
        let cursor = self.cursor.as_ref()?;
        if self.image.is_empty() {
            return None;
        }
        let factor = (self.image.w as f64 / self.session.0 as f64).max(0.5);
        let (vx, vy) = geometry::view_point(
            self.image,
            self.session.0,
            self.session.1,
            self.cursor_pos.0 as f64,
            self.cursor_pos.1 as f64,
        );
        let x = (vx - cursor.xhot as f64 * factor).round() as i32;
        let y = (vy - cursor.yhot as f64 * factor).round() as i32;
        let w = ((cursor.width as f64 * factor).round() as u32).max(1);
        let h = ((cursor.height as f64 * factor).round() as u32).max(1);
        let rect = Rect::new(x, y, w, h).intersect(&self.image);
        (!rect.is_empty()).then_some((Rect::new(x, y, w, h), factor))
    }

    fn draw(&mut self) {
        let (w, h) = (self.size.width, self.size.height);
        if w == 0 || h == 0 || self.surface.is_none() || self.canvas.len() < (w * h) as usize {
            return;
        }

        self.rescale_dirty_rows();

        let cursor = self.cursor_rect();
        let cursor_rect = cursor.map(|(r, _)| r.intersect(&self.image));
        if cursor_rect != self.cursor_drawn {
            for r in [self.cursor_drawn, cursor_rect].into_iter().flatten() {
                self.damage_rows(r.y, r.bottom());
            }
            self.cursor_drawn = cursor_rect;
        }

        let Some((y0, y1)) = self.damage.take() else {
            return;
        };
        self.compose(y0, y1, cursor.map(|(r, f)| (r.x, r.y, f)));

        let Some(surface) = self.surface.as_mut() else {
            return;
        };
        let mut buffer = match surface.buffer_mut() {
            Ok(buffer) => buffer,
            Err(e) => {
                log(&format!("cannot get the window buffer: {e}"));
                return;
            }
        };
        let (y0, y1) = if buffer.age() == 1 {
            (y0, y1)
        } else {
            (0, h as i32)
        };
        let range = (y0 as usize * w as usize)..(y1 as usize * w as usize);
        buffer[range.clone()].copy_from_slice(&self.canvas[range]);
        if let Some(window) = &self.window {
            window.pre_present_notify();
        }
        let damage = softbuffer::Rect {
            x: 0,
            y: y0 as u32,
            width: NonZeroU32::new(w).expect("nonzero"),
            height: NonZeroU32::new((y1 - y0) as u32).expect("nonzero"),
        };
        if let Err(e) = buffer.present_with_damage(&[damage]) {
            log(&format!("cannot present: {e}"));
            return;
        }

        if !self.ready_sent && (self.have_frame || self.ended) {
            self.ready_sent = true;
            emit(&Event::Ready {
                version: args::VERSION.into(),
                pid: std::process::id(),
                backend: self.backend,
                scale: self.metrics.scale,
            });
        }
    }

    fn rescale_dirty_rows(&mut self) {
        // Rescale the session rows that changed.
        if let Some(scaler) = &mut self.scaler {
            let rows = if self.rescale_all {
                0..self.image.h
            } else if let Some(d) = self.src_dirty {
                scaler.dst_rows_for(d.y.max(0) as u32..d.bottom().max(0) as u32)
            } else {
                0..0
            };
            if !rows.is_empty() {
                let shared = self.shared.clone();
                let s = shared.lock().unwrap();
                scaler.scale_rows(
                    &s.frame.pixels,
                    s.frame.width as usize,
                    &mut self.scaled,
                    self.image.w as usize,
                    rows.clone(),
                );
                drop(s);
                let top = self.image.y;
                self.damage_rows(top + rows.start as i32, top + rows.end as i32);
            }
        }
        self.rescale_all = false;
        self.src_dirty = None;
    }

    /// Repaints canvas rows `y0..y1`: letterbox, image, cursor, status and
    /// bar.
    fn compose(&mut self, y0: i32, y1: i32, cursor: Option<(i32, i32, f64)>) {
        let (w, h) = (self.size.width, self.size.height);
        let clip = Rect::new(0, y0, w, (y1 - y0) as u32);
        let image = self.image;
        let status = self.status_text();
        let mut canvas = Canvas::new(&mut self.canvas, w, h, clip);
        canvas.fill(clip, palette::SURFACE);
        canvas.blit(image, &self.scaled, image.w as usize);
        if let (Some((x, y, factor)), Some(c)) = (cursor, &self.cursor) {
            canvas.clip = clip.intersect(&image);
            canvas.premultiplied(x, y, c.width, c.height, &c.pixels, factor);
            canvas.clip = clip;
        }
        let ring = self
            .pulse
            .as_ref()
            .and_then(|p| p.ring(image, self.session, self.metrics.scale, Instant::now()));
        if let Some(ring) = ring {
            canvas.clip = clip.intersect(&image);
            let center = (ring.center.0 as f32, ring.center.1 as f32);
            canvas.ring(
                center,
                ring.radius as f32,
                ring.width as f32,
                palette::EMBER,
                ring.alpha,
            );
            canvas.clip = clip;
        }
        if let Some(label) = status {
            let top = self.bar.as_ref().map_or(0, |b| b.rect.h);
            let area = Rect::new(0, top as i32, w, h.saturating_sub(top));
            let rect = ui::status_rect(area, label, self.metrics, &mut self.text);
            ui::draw_status(&mut canvas, rect, label, self.metrics, &mut self.text);
        }
        if let Some((rect, label)) = &self.label_pill {
            ui::draw_status(&mut canvas, *rect, label, self.metrics, &mut self.text);
        }
        if let Some(banner) = &self.banner {
            banner.draw(
                &mut canvas,
                self.metrics,
                &mut self.text,
                self.hover,
                self.pressed,
            );
        }
        if let Some(bar) = &self.bar {
            bar.draw(
                &mut canvas,
                self.metrics,
                &mut self.text,
                self.hover,
                self.pressed,
            );
        }
    }
}

impl ApplicationHandler<UserEvent> for App {
    fn new_events(&mut self, _event_loop: &ActiveEventLoop, cause: StartCause) {
        if let StartCause::ResumeTimeReached { .. } = cause {
            if self
                .redraw_since
                .is_some_and(|t| t.elapsed() >= HIDDEN_AFTER)
                && !self.hidden
            {
                self.hidden = true;
                self.update_pause();
            }
        }
    }

    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        if let Err(e) = self.create_window(event_loop) {
            self.exit = Some(fatal(
                EXIT_NO_WINDOW_SYSTEM,
                "window",
                &format!("cannot open the viewer window: {e}"),
            ));
            event_loop.exit();
        }
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: UserEvent) {
        match event {
            UserEvent::Command(command) => self.on_command(command),
            UserEvent::Capture => self.on_capture(),
            UserEvent::StdinClosed => self.quit(),
        }
        if self.exit.is_some() {
            event_loop.exit();
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => self.close(),
            WindowEvent::Resized(size) => {
                if size != self.size {
                    self.size = size;
                    self.relayout();
                }
            }
            WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                self.metrics = Metrics {
                    scale: scale_factor,
                };
                self.relayout();
            }
            WindowEvent::Occluded(occluded) => {
                self.occluded = occluded;
                self.update_pause();
            }
            WindowEvent::RedrawRequested => {
                self.redraw_since = None;
                if self.hidden {
                    self.hidden = false;
                    self.update_pause();
                }
                self.draw();
            }
            WindowEvent::CursorMoved { position, .. } => {
                self.pointer = Some((position.x, position.y));
                self.update_hover();
                self.on_pointer_moved();
            }
            WindowEvent::CursorLeft { .. } => {
                self.pointer = None;
                self.update_hover();
            }
            WindowEvent::MouseInput { state, button, .. } => self.on_mouse(state, button),
            WindowEvent::MouseWheel { delta, .. } => self.on_wheel(delta),
            WindowEvent::ModifiersChanged(modifiers) => self.modifiers = modifiers,
            WindowEvent::Focused(false) => self.on_focus_lost(),
            WindowEvent::Ime(Ime::Commit(text)) => {
                if is_text(&text) {
                    self.forward(|i| i.type_text(&text));
                }
            }
            // All keys, Esc too, go to the session while controlling.
            WindowEvent::KeyboardInput { event, .. } if self.controller.controlling() => {
                self.on_key(event)
            }
            WindowEvent::KeyboardInput {
                event:
                    KeyEvent {
                        logical_key: Key::Named(NamedKey::Escape),
                        state: ElementState::Pressed,
                        repeat: false,
                        ..
                    },
                ..
            } => match self.mode {
                Mode::Fullscreen => self.toggle_fullscreen(),
                Mode::Expanded => self.collapse(),
                Mode::Thumbnail => {}
            },
            _ => {}
        }
        if self.exit.is_some() {
            event_loop.exit();
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        let now = Instant::now();
        if self.controller.tick(now) {
            self.control_changed();
        }
        let mut deadline = self
            .redraw_since
            .filter(|_| !self.hidden)
            .map(|t| t + HIDDEN_AFTER);
        for next in [
            self.refresh_x11_pause(now),
            self.controller.deadline(),
            self.tick_pulse(now),
        ]
        .into_iter()
        .flatten()
        {
            deadline = Some(deadline.map_or(next, |t| t.min(next)));
        }
        event_loop.set_control_flow(deadline.map_or(ControlFlow::Wait, ControlFlow::WaitUntil));
    }
}

/// What a held physical key sent, so its release matches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Sent {
    Key(u32),
    Char(char),
    /// Text is typed on press; its release sends nothing.
    Text,
}

fn input_button(button: MouseButton) -> Option<input::Button> {
    Some(match button {
        MouseButton::Left => input::Button::Left,
        MouseButton::Middle => input::Button::Middle,
        MouseButton::Right => input::Button::Right,
        MouseButton::Back => input::Button::Back,
        MouseButton::Forward => input::Button::Forward,
        MouseButton::Other(_) => return None,
    })
}

fn is_text(text: &str) -> bool {
    !text.is_empty() && !text.chars().any(char::is_control)
}

fn single_char(key: &Key) -> Option<char> {
    let Key::Character(s) = key else {
        return None;
    };
    let mut chars = s.chars();
    let c = chars.next()?;
    (chars.next().is_none() && !c.is_control()).then_some(c)
}

/// The keysym of a named or modifier key.
fn named_keysym(key: &Key, location: KeyLocation) -> Option<u32> {
    let Key::Named(key) = key else {
        return None;
    };
    let right = location == KeyLocation::Right;
    let pick = |left, right_sym| if right { right_sym } else { left };
    Some(match key {
        NamedKey::Enter => named::RETURN,
        NamedKey::Tab => named::TAB,
        NamedKey::Space => 0x20,
        NamedKey::Backspace => named::BACKSPACE,
        NamedKey::Escape => named::ESCAPE,
        NamedKey::Delete => named::DELETE,
        NamedKey::Insert => named::INSERT,
        NamedKey::Home => named::HOME,
        NamedKey::End => named::END,
        NamedKey::PageUp => named::PAGE_UP,
        NamedKey::PageDown => named::PAGE_DOWN,
        NamedKey::ArrowLeft => named::LEFT,
        NamedKey::ArrowRight => named::RIGHT,
        NamedKey::ArrowUp => named::UP,
        NamedKey::ArrowDown => named::DOWN,
        NamedKey::Shift => pick(named::SHIFT_L, named::SHIFT_R),
        NamedKey::Control => pick(named::CONTROL_L, named::CONTROL_R),
        NamedKey::Alt => pick(named::ALT_L, named::ALT_R),
        NamedKey::Super | NamedKey::Meta => pick(named::SUPER_L, named::SUPER_R),
        NamedKey::AltGraph => named::ISO_LEVEL3_SHIFT,
        NamedKey::CapsLock => named::CAPS_LOCK,
        NamedKey::NumLock => named::NUM_LOCK,
        NamedKey::F1 => keysyms::function_key(1)?,
        NamedKey::F2 => keysyms::function_key(2)?,
        NamedKey::F3 => keysyms::function_key(3)?,
        NamedKey::F4 => keysyms::function_key(4)?,
        NamedKey::F5 => keysyms::function_key(5)?,
        NamedKey::F6 => keysyms::function_key(6)?,
        NamedKey::F7 => keysyms::function_key(7)?,
        NamedKey::F8 => keysyms::function_key(8)?,
        NamedKey::F9 => keysyms::function_key(9)?,
        NamedKey::F10 => keysyms::function_key(10)?,
        NamedKey::F11 => keysyms::function_key(11)?,
        NamedKey::F12 => keysyms::function_key(12)?,
        _ => return None,
    })
}

// X11 can unmap or iconify without a winit resize or occlusion event.
struct X11Visibility {
    conn: RustConnection,
    window: u32,
    wm_state: u32,
}

impl X11Visibility {
    fn connect(window: u32) -> Option<Self> {
        let (conn, _) = x11rb::connect(None).ok()?;
        Self::new(conn, window)
    }

    fn new(conn: RustConnection, window: u32) -> Option<Self> {
        let wm_state = conn
            .intern_atom(false, b"WM_STATE")
            .ok()?
            .reply()
            .ok()?
            .atom;
        Some(Self {
            conn,
            window,
            wm_state,
        })
    }

    fn is_hidden(&self) -> bool {
        let attrs = self
            .conn
            .get_window_attributes(self.window)
            .ok()
            .and_then(|c| c.reply().ok());
        if attrs.is_some_and(|a| a.map_state != MapState::VIEWABLE) {
            return true;
        }
        self.conn
            .get_property(false, self.window, self.wm_state, self.wm_state, 0, 2)
            .ok()
            .and_then(|c| c.reply().ok())
            .and_then(|p| p.value32().and_then(|mut values| values.next()))
            == Some(3)
    }
}

#[cfg(test)]
#[path = "app_tests.rs"]
mod tests;
