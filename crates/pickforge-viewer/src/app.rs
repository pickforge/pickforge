//! The window: winit events, softbuffer presentation, modes and the stdio
//! host channel.

use crate::args::{self, Config, Placement};
use crate::capture::{Capture, Control, CursorImage, Shared};
use crate::geometry::{self, Rect};
use crate::protocol::{
    self, Backend, Command, Event, HostMode, Line, LineReader, Mode, StatusCode,
};
use crate::scale::Scaler;
use crate::ui::{self, palette, Bar, Button, Canvas, Metrics, Text};
use crate::{procstat, EXIT_DISPLAY, EXIT_NO_WINDOW_SYSTEM};
use softbuffer::{Context, Surface};
use std::io;
use std::num::NonZeroU32;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use winit::application::ApplicationHandler;
use winit::dpi::{LogicalSize, PhysicalSize};
use winit::event::{ElementState, KeyEvent, MouseButton, StartCause, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::{Key, NamedKey};
use winit::platform::wayland::{ActiveEventLoopExtWayland, WindowAttributesExtWayland};
use winit::platform::x11::WindowAttributesExtX11;
use winit::window::{CursorIcon, Fullscreen, Window, WindowAttributes, WindowId};

/// A redraw that waits longer than this for a frame callback means the
/// compositor hides the window, so capture pauses.
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

    let mut app = App::new(config, session, shared, control, capture_pending);
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

    pointer: Option<(f64, f64)>,
    hover: Option<Button>,
    pressed: Option<Button>,
    thumb_press: bool,

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
    ) -> Self {
        Self {
            config,
            session,
            shared,
            control,
            capture_pending,
            window: None,
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
            pointer: None,
            hover: None,
            pressed: None,
            thumb_press: false,
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
            .with_title("Pickforge viewer")
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
        if w == 0 || h == 0 {
            return;
        }
        self.canvas.resize((w * h) as usize, palette::SURFACE);
        self.bar = (self.mode != Mode::Thumbnail).then(|| {
            Bar::layout(
                w,
                self.metrics,
                self.mode == Mode::Fullscreen,
                &mut self.text,
            )
        });
        let top = self.bar.as_ref().map_or(0, |b| b.rect.h).min(h);
        let content = Rect::new(0, top as i32, w, h - top);
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

    fn update_pause(&mut self) {
        let zero = self.size.width == 0 || self.size.height == 0;
        let minimized = self
            .window
            .as_ref()
            .and_then(|w| w.is_minimized())
            .unwrap_or(false);
        self.control
            .set_paused(self.occluded || self.hidden || zero || minimized);
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

    fn close(&mut self) {
        emit(&Event::Closed);
        self.exit = Some(0);
    }

    fn activate(&mut self, button: Button) {
        match button {
            Button::Fullscreen => self.toggle_fullscreen(),
            Button::Collapse => self.collapse(),
            Button::Close => self.close(),
        }
    }

    fn update_hover(&mut self) {
        let hover = match (&self.bar, self.pointer) {
            (Some(bar), Some((x, y))) => bar.hit(x, y),
            _ => None,
        };
        if hover != self.hover {
            self.hover = hover;
            self.damage_bar();
        }
    }

    fn on_mouse(&mut self, state: ElementState, button: MouseButton) {
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
        let Some(bar) = &self.bar else {
            return;
        };
        if let Some(hit) = bar.hit(x, y) {
            self.pressed = Some(hit);
            self.damage_bar();
        } else if bar.rect.contains(x, y) {
            if let Some(window) = &self.window {
                let _ = window.drag_window();
            }
        }
    }

    fn release_bar(&mut self) {
        if let Some(pressed) = self.pressed.take() {
            self.damage_bar();
            if self.hover == Some(pressed) {
                self.activate(pressed);
            }
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
            Command::Shutdown => self.exit = Some(0),
            Command::Unknown(name) => log(&format!("ignored unknown command {name:?}")),
        }
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
            self.cursor = image;
            self.cursor_pos = pos;
            self.request_redraw();
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
        let mut canvas = Canvas::new(&mut self.canvas, w, h, clip);
        canvas.fill(clip, palette::SURFACE);
        canvas.blit(image, &self.scaled, image.w as usize);
        if let (Some((x, y, factor)), Some(c)) = (cursor, &self.cursor) {
            canvas.clip = clip.intersect(&image);
            canvas.premultiplied(x, y, c.width, c.height, &c.pixels, factor);
            canvas.clip = clip;
        }
        if let Some(status) = self.status {
            let top = self.bar.as_ref().map_or(0, |b| b.rect.h);
            let area = Rect::new(0, top as i32, w, h.saturating_sub(top));
            let rect = ui::status_rect(area, status.text(), self.metrics, &mut self.text);
            ui::draw_status(
                &mut canvas,
                rect,
                status.text(),
                self.metrics,
                &mut self.text,
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
            UserEvent::StdinClosed => self.exit = Some(0),
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
            }
            WindowEvent::CursorLeft { .. } => {
                self.pointer = None;
                self.update_hover();
            }
            WindowEvent::MouseInput { state, button, .. } => self.on_mouse(state, button),
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
        match self.redraw_since {
            Some(since) if !self.hidden => {
                event_loop.set_control_flow(ControlFlow::WaitUntil(since + HIDDEN_AFTER));
            }
            _ => event_loop.set_control_flow(ControlFlow::Wait),
        }
    }
}
