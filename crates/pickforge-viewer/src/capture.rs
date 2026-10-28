//! Reads the session's X display: MIT-SHM image capture of damaged areas
//! with a GetImage fallback, DAMAGE events, and the XFIXES cursor. It has no
//! window code, so tests run it against a bare Xvfb.

use crate::geometry::Rect;
use crate::procstat;
use crate::protocol::EndReason;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use x11rb::connection::{Connection, RequestConnection};
use x11rb::errors::{ConnectionError, ReplyError};
use x11rb::protocol::damage::{self, ConnectionExt as _};
use x11rb::protocol::shm::{self, ConnectionExt as _};
use x11rb::protocol::xfixes::{self, ConnectionExt as _};
use x11rb::protocol::xinput::{self, ConnectionExt as _};
use x11rb::protocol::xproto::{self, ConnectionExt as _, ImageFormat, ImageOrder};
use x11rb::protocol::Event;
use x11rb::rust_connection::{DefaultStream, RustConnection};
use x11rb::NONE;

/// At most one fetch per this interval.
pub const FETCH_INTERVAL: Duration = Duration::from_millis(16);
/// How often the Xvfb identity is checked.
pub const PROC_INTERVAL: Duration = Duration::from_secs(5);
/// Pointer polling interval when XInput 2 is missing.
const POINTER_POLL: Duration = Duration::from_millis(50);

#[derive(Debug)]
pub enum CaptureError {
    /// The display socket could not be opened or the setup failed.
    Connect(String),
    /// The display lacks something the viewer needs.
    Unsupported(String),
    /// The connection to the display is gone.
    Closed(String),
    /// The server refused a request.
    Request(String),
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CaptureError::Connect(m) => write!(f, "cannot open the session display: {m}"),
            CaptureError::Unsupported(m) => write!(f, "unsupported session display: {m}"),
            CaptureError::Closed(m) => write!(f, "session display connection closed: {m}"),
            CaptureError::Request(m) => write!(f, "session display request failed: {m}"),
        }
    }
}

impl From<ConnectionError> for CaptureError {
    fn from(e: ConnectionError) -> Self {
        CaptureError::Closed(e.to_string())
    }
}

impl From<ReplyError> for CaptureError {
    fn from(e: ReplyError) -> Self {
        match e {
            ReplyError::ConnectionError(e) => e.into(),
            ReplyError::X11Error(e) => CaptureError::Request(format!("{:?}", e.error_kind)),
        }
    }
}

/// Opens `/tmp/.X11-unix/X<display>` with empty authorization. It never
/// reads `XAUTHORITY`.
pub fn connect_display(display: u32) -> Result<RustConnection, CaptureError> {
    let path = format!("/tmp/.X11-unix/X{display}");
    let stream =
        UnixStream::connect(&path).map_err(|e| CaptureError::Connect(format!("{path}: {e}")))?;
    let (stream, _) = DefaultStream::from_unix_stream(stream)
        .map_err(|e| CaptureError::Connect(e.to_string()))?;
    RustConnection::connect_to_stream_with_auth_info(stream, 0, Vec::new(), Vec::new())
        .map_err(|e| CaptureError::Connect(e.to_string()))
}

/// The session image as `0x00RRGGBB` pixels.
#[derive(Debug, Clone, Default)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u32>,
}

impl Frame {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            pixels: vec![0; (width * height) as usize],
        }
    }

    pub fn pixel(&self, x: u32, y: u32) -> u32 {
        self.pixels[(y * self.width + x) as usize]
    }
}

/// The session cursor as premultiplied ARGB pixels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CursorImage {
    pub width: u32,
    pub height: u32,
    pub xhot: u32,
    pub yhot: u32,
    pub serial: u32,
    pub pixels: Vec<u32>,
}

/// A cursor image and the pointer position in session pixels.
pub type CursorAt = (CursorImage, (i32, i32));

/// State the capture thread shares with the window.
#[derive(Debug, Default)]
pub struct Shared {
    pub frame: Frame,
    /// Area changed since the window last took it.
    pub dirty: Option<Rect>,
    pub cursor: Option<Arc<CursorImage>>,
    pub cursor_pos: (i32, i32),
    /// The cursor image or position changed since the window last looked.
    pub cursor_changed: bool,
    pub ended: Option<EndReason>,
    /// Number of image fetches so far.
    pub fetches: u64,
}

impl Shared {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            frame: Frame::new(width, height),
            ..Self::default()
        }
    }
}

/// Lets the window pause or stop the capture thread.
pub struct Control {
    paused: AtomicBool,
    stopped: AtomicBool,
    wake_tx: UnixStream,
    wake_rx: UnixStream,
}

impl Control {
    pub fn new() -> io::Result<Arc<Self>> {
        let (wake_tx, wake_rx) = UnixStream::pair()?;
        wake_tx.set_nonblocking(true)?;
        wake_rx.set_nonblocking(true)?;
        Ok(Arc::new(Self {
            paused: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            wake_tx,
            wake_rx,
        }))
    }

    /// Pausing stops fetches. Resuming fetches the whole image once.
    pub fn set_paused(&self, paused: bool) {
        if self.paused.swap(paused, Ordering::SeqCst) != paused {
            self.wake();
        }
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.wake();
    }

    fn wake(&self) {
        let _ = (&self.wake_tx).write(&[1]);
    }

    fn drain(&self) {
        let mut buf = [0u8; 64];
        while matches!((&self.wake_rx).read(&mut buf), Ok(n) if n > 0) {}
    }
}

/// A memfd segment attached to the server with MIT-SHM 1.2.
struct ShmSegment {
    seg: shm::Seg,
    ptr: *mut u8,
    len: usize,
}

// The mapping is owned by this value and used by one thread at a time.
unsafe impl Send for ShmSegment {}

impl Drop for ShmSegment {
    fn drop(&mut self) {
        unsafe {
            libc::munmap(self.ptr.cast(), self.len);
        }
    }
}

impl ShmSegment {
    fn attach(conn: &RustConnection, len: usize) -> Result<Self, String> {
        if conn
            .extension_information(shm::X11_EXTENSION_NAME)
            .map_err(|e| e.to_string())?
            .is_none()
        {
            return Err("no MIT-SHM extension".into());
        }
        let version = conn
            .shm_query_version()
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?;
        if (version.major_version, version.minor_version) < (1, 2) {
            return Err("MIT-SHM older than 1.2".into());
        }
        let fd = unsafe { libc::memfd_create(c"pickforge-viewer".as_ptr(), libc::MFD_CLOEXEC) };
        if fd < 0 {
            return Err(format!("memfd_create: {}", io::Error::last_os_error()));
        }
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        if unsafe { libc::ftruncate(fd.as_raw_fd(), len as libc::off_t) } != 0 {
            return Err(format!("ftruncate: {}", io::Error::last_os_error()));
        }
        let ptr = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                len,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                fd.as_raw_fd(),
                0,
            )
        };
        if ptr == libc::MAP_FAILED {
            return Err(format!("mmap: {}", io::Error::last_os_error()));
        }
        let mut segment = ShmSegment {
            seg: 0,
            ptr: ptr.cast(),
            len,
        };
        segment.seg = conn.generate_id().map_err(|e| e.to_string())?;
        conn.shm_attach_fd(segment.seg, fd, false)
            .map_err(|e| e.to_string())?
            .check()
            .map_err(|e| e.to_string())?;
        Ok(segment)
    }

    fn bytes(&self, len: usize) -> &[u8] {
        assert!(len <= self.len);
        unsafe { std::slice::from_raw_parts(self.ptr, len) }
    }
}

/// One connection to the session display.
pub struct Capture {
    conn: RustConnection,
    root: xproto::Window,
    width: u32,
    height: u32,
    damage: damage::Damage,
    shm: Option<ShmSegment>,
    xfixes: bool,
    xi2: bool,
    msb_first: bool,
}

fn has_extension(conn: &RustConnection, name: &'static str) -> Result<bool, CaptureError> {
    Ok(conn.extension_information(name)?.is_some())
}

fn select_xi2_motion(
    conn: &RustConnection,
    root: xproto::Window,
    version: Result<xinput::XIQueryVersionReply, ReplyError>,
) -> Result<bool, CaptureError> {
    if !version.is_ok_and(|v| v.major_version >= 2) {
        return Ok(false);
    }
    Ok(conn
        .xinput_xi_select_events(
            root,
            &[xinput::EventMask {
                deviceid: xinput::Device::ALL_MASTER.into(),
                mask: vec![xinput::XIEventMask::RAW_MOTION],
            }],
        )?
        .check()
        .is_ok())
}

impl Capture {
    /// Connects and subscribes to damage and cursor changes.
    pub fn connect(display: u32) -> Result<Self, CaptureError> {
        let conn = connect_display(display)?;
        let setup = conn.setup();
        let screen = setup
            .roots
            .first()
            .ok_or_else(|| CaptureError::Unsupported("no screen".into()))?;
        let (root, depth) = (screen.root, screen.root_depth);
        let (width, height) = (
            screen.width_in_pixels as u32,
            screen.height_in_pixels as u32,
        );
        let bpp = setup
            .pixmap_formats
            .iter()
            .find(|f| f.depth == depth)
            .map(|f| f.bits_per_pixel);
        if !(depth == 24 || depth == 32) || bpp != Some(32) {
            return Err(CaptureError::Unsupported(format!(
                "depth {depth} with {bpp:?} bits per pixel; need 24 or 32 bit color"
            )));
        }
        let msb_first = setup.image_byte_order == ImageOrder::MSB_FIRST;

        if !has_extension(&conn, damage::X11_EXTENSION_NAME)? {
            return Err(CaptureError::Unsupported("no DAMAGE extension".into()));
        }
        conn.damage_query_version(1, 1)?.reply()?;
        let damage = conn
            .generate_id()
            .map_err(|e| CaptureError::Closed(e.to_string()))?;
        conn.damage_create(damage, root, damage::ReportLevel::BOUNDING_BOX)?
            .check()?;

        let xfixes = has_extension(&conn, xfixes::X11_EXTENSION_NAME)?
            && conn.xfixes_query_version(4, 0)?.reply()?.major_version >= 2;
        if xfixes {
            conn.xfixes_select_cursor_input(root, xfixes::CursorNotifyMask::DISPLAY_CURSOR)?
                .check()?;
        } else {
            log("no XFIXES 2; the cursor is not shown");
        }

        let xi2 = has_extension(&conn, xinput::X11_EXTENSION_NAME)?
            && select_xi2_motion(&conn, root, conn.xinput_xi_query_version(2, 2)?.reply())?;
        if !xi2 {
            log("no XInput 2; polling the pointer position");
        }

        let shm = match ShmSegment::attach(&conn, (width * height * 4) as usize) {
            Ok(segment) => Some(segment),
            Err(reason) => {
                log(&format!(
                    "shared memory capture unavailable ({reason}); using GetImage"
                ));
                None
            }
        };

        Ok(Self {
            conn,
            root,
            width,
            height,
            damage,
            shm,
            xfixes,
            xi2,
            msb_first,
        })
    }

    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub fn uses_shm(&self) -> bool {
        self.shm.is_some()
    }

    /// Forces the GetImage path. Tests use it to cover the fallback.
    #[doc(hidden)]
    pub fn without_shm(mut self) -> Self {
        self.detach_shm();
        self
    }

    fn detach_shm(&mut self) {
        if let Some(segment) = self.shm.take() {
            let _ = self
                .conn
                .shm_detach(segment.seg)
                .map(|cookie| cookie.ignore_error());
        }
    }

    /// Fetches `rect` of the root window and copies it into `frame`.
    fn fetch_into(&mut self, rect: Rect, frame: &Mutex<Shared>) -> Result<(), CaptureError> {
        let rect = rect.intersect(&Rect::new(0, 0, self.width, self.height));
        if rect.is_empty() {
            return Ok(());
        }
        let (x, y, w, h) = (rect.x as i16, rect.y as i16, rect.w as u16, rect.h as u16);
        let len = (rect.w * rect.h * 4) as usize;
        if let Some(segment) = &self.shm {
            let reply = self
                .conn
                .shm_get_image(
                    self.root,
                    x,
                    y,
                    w,
                    h,
                    !0,
                    ImageFormat::Z_PIXMAP.into(),
                    segment.seg,
                    0,
                )?
                .reply();
            match reply {
                Ok(_) => {
                    copy_rect(
                        &mut frame.lock().unwrap(),
                        rect,
                        segment.bytes(len),
                        self.msb_first,
                    );
                    return Ok(());
                }
                Err(ReplyError::X11Error(e)) => {
                    log(&format!(
                        "shared memory capture failed ({:?}); using GetImage",
                        e.error_kind
                    ));
                    self.detach_shm();
                }
                Err(e) => return Err(e.into()),
            }
        }
        let reply = self
            .conn
            .get_image(ImageFormat::Z_PIXMAP, self.root, x, y, w, h, !0)?
            .reply()?;
        if reply.data.len() < len {
            return Err(CaptureError::Request("short GetImage reply".into()));
        }
        copy_rect(
            &mut frame.lock().unwrap(),
            rect,
            &reply.data,
            self.msb_first,
        );
        Ok(())
    }

    /// Fetches the whole root window once.
    pub fn snapshot(&mut self) -> Result<Frame, CaptureError> {
        let shared = Mutex::new(Shared::new(self.width, self.height));
        self.fetch_into(Rect::new(0, 0, self.width, self.height), &shared)?;
        Ok(shared.into_inner().unwrap().frame)
    }

    /// The cursor image and its hotspot position, when XFIXES is there.
    pub fn cursor(&self) -> Result<Option<CursorAt>, CaptureError> {
        if !self.xfixes {
            return Ok(None);
        }
        let reply = self.conn.xfixes_get_cursor_image()?.reply()?;
        let (width, height) = (reply.width as u32, reply.height as u32);
        if width == 0 || height == 0 || reply.cursor_image.len() < (width * height) as usize {
            return Ok(None);
        }
        let image = CursorImage {
            width,
            height,
            xhot: reply.xhot as u32,
            yhot: reply.yhot as u32,
            serial: reply.cursor_serial,
            pixels: reply.cursor_image,
        };
        Ok(Some((image, (reply.x as i32, reply.y as i32))))
    }

    fn pointer(&self) -> Result<(i32, i32), CaptureError> {
        let reply = self.conn.query_pointer(self.root)?.reply()?;
        Ok((reply.root_x as i32, reply.root_y as i32))
    }

    /// Runs until the session ends or `control` stops it. `notify` is
    /// called after each change to `shared`. `xvfb` is the pid and start
    /// ticks to watch.
    pub fn run(
        mut self,
        shared: Arc<Mutex<Shared>>,
        control: Arc<Control>,
        xvfb: Option<(u32, u64)>,
        notify: impl Fn(),
    ) {
        let end = |reason: EndReason, detail: &str| {
            log(&format!("session ended: {detail}"));
            shared.lock().unwrap().ended = Some(reason);
            notify();
        };
        let mut state = CaptureSchedule::new(self.width, self.height, self.xfixes);
        let mut next_proc = Instant::now();

        loop {
            if control.stopped.load(Ordering::SeqCst) {
                return;
            }
            if let Err(e) = self.drain_events(&mut state) {
                return end(EndReason::X11Eof, &e.to_string());
            }

            let now = Instant::now();
            if now >= next_proc {
                if xvfb.is_some_and(|(pid, ticks)| procstat::read_start_ticks(pid) != Some(ticks)) {
                    return end(EndReason::XvfbGone, "the Xvfb process changed or exited");
                }
                next_proc = now + PROC_INTERVAL;
            }

            let timeout = match self.capture_due(&shared, &control, &mut state, now, next_proc) {
                Ok(CaptureStep::Fetched(true)) => {
                    notify();
                    continue;
                }
                Ok(CaptureStep::Fetched(false)) => continue,
                Ok(CaptureStep::Wait(timeout)) => timeout,
                Err(CaptureError::Closed(e)) => return end(EndReason::X11Eof, &e),
                Err(e) => {
                    log(&e.to_string());
                    continue;
                }
            };

            if let Err(e) = self.conn.flush() {
                return end(EndReason::X11Eof, &e.to_string());
            }
            wait_readable(
                &[self.conn.stream().as_raw_fd(), control.wake_rx.as_raw_fd()],
                timeout,
            );
            control.drain();
        }
    }

    fn drain_events(&self, state: &mut CaptureSchedule) -> Result<(), ConnectionError> {
        loop {
            match self.conn.poll_for_event() {
                Ok(Some(Event::DamageNotify(e))) => {
                    let area = Rect::new(
                        e.area.x as i32,
                        e.area.y as i32,
                        e.area.width as u32,
                        e.area.height as u32,
                    );
                    state.pending = Some(state.pending.map_or(area, |p| p.union(&area)));
                }
                Ok(Some(Event::XfixesCursorNotify(_))) => state.cursor_shape = true,
                Ok(Some(Event::XinputRawMotion(_))) => state.cursor_moved = true,
                Ok(Some(Event::Error(e))) => log(&format!("X error {:?}", e.error_kind)),
                Ok(Some(_)) => {}
                Ok(None) => return Ok(()),
                Err(e) => return Err(e),
            }
        }
    }

    fn capture_due(
        &mut self,
        shared: &Mutex<Shared>,
        control: &Control,
        state: &mut CaptureSchedule,
        now: Instant,
        next_proc: Instant,
    ) -> Result<CaptureStep, CaptureError> {
        let full = Rect::new(0, 0, self.width, self.height);
        let paused = control.is_paused();
        state.resume(paused, full, self.xfixes);
        let mut timeout = next_proc.saturating_duration_since(now);
        if paused {
            return Ok(CaptureStep::Wait(timeout));
        }
        timeout = state.pointer_timeout(self.xi2, now, timeout);
        if state.pending.is_none() && !state.cursor_shape && !state.cursor_moved {
            return Ok(CaptureStep::Wait(timeout));
        }
        let due = state.last_fetch.map_or(now, |t| t + FETCH_INTERVAL);
        if now < due {
            return Ok(CaptureStep::Wait(timeout.min(due - now)));
        }
        state.last_fetch = Some(now);
        let area = state.pending.take();
        match self.update(shared, area, state.cursor_shape, state.cursor_moved) {
            Ok(changed) => {
                state.cursor_shape = false;
                state.cursor_moved = false;
                Ok(CaptureStep::Fetched(changed))
            }
            Err(error) => {
                state.pending = area;
                Err(error)
            }
        }
    }

    fn update(
        &mut self,
        shared: &Mutex<Shared>,
        area: Option<Rect>,
        shape: bool,
        moved: bool,
    ) -> Result<bool, CaptureError> {
        let mut changed = false;
        if let Some(area) = area {
            // Clear the damage first, so drawing during the fetch reports
            // again.
            self.conn.damage_subtract(self.damage, NONE, NONE)?;
            self.fetch_into(area, shared)?;
            let mut s = shared.lock().unwrap();
            s.dirty = Some(s.dirty.map_or(area, |d| d.union(&area)));
            s.fetches += 1;
            changed = true;
        }
        if shape {
            if let Some((image, pos)) = self.cursor()? {
                let mut s = shared.lock().unwrap();
                s.cursor = Some(Arc::new(image));
                s.cursor_pos = pos;
                s.cursor_changed = true;
                changed = true;
            }
        } else if moved {
            let pos = self.pointer()?;
            let mut s = shared.lock().unwrap();
            if s.cursor_pos != pos {
                s.cursor_pos = pos;
                s.cursor_changed = true;
                changed = true;
            }
        }
        Ok(changed)
    }
}

enum CaptureStep {
    Fetched(bool),
    Wait(Duration),
}

struct CaptureSchedule {
    pending: Option<Rect>,
    cursor_shape: bool,
    cursor_moved: bool,
    last_fetch: Option<Instant>,
    next_pointer_poll: Instant,
    was_paused: bool,
}

impl CaptureSchedule {
    fn new(width: u32, height: u32, xfixes: bool) -> Self {
        Self {
            pending: Some(Rect::new(0, 0, width, height)),
            cursor_shape: xfixes,
            cursor_moved: true,
            last_fetch: None,
            next_pointer_poll: Instant::now(),
            was_paused: false,
        }
    }

    fn resume(&mut self, paused: bool, full: Rect, xfixes: bool) {
        if self.was_paused && !paused {
            self.pending = Some(full);
            self.cursor_shape = xfixes;
            self.cursor_moved = true;
        }
        self.was_paused = paused;
    }

    fn pointer_timeout(&mut self, xi2: bool, now: Instant, timeout: Duration) -> Duration {
        if xi2 {
            return timeout;
        }
        if now >= self.next_pointer_poll {
            self.cursor_moved = true;
            self.next_pointer_poll = now + POINTER_POLL;
        }
        timeout.min(self.next_pointer_poll.saturating_duration_since(now))
    }
}

/// Copies a tightly packed 32-bit ZPixmap of `rect` into the frame.
fn copy_rect(shared: &mut Shared, rect: Rect, bytes: &[u8], msb_first: bool) {
    let frame = &mut shared.frame;
    let w = rect.w as usize;
    for row in 0..rect.h as usize {
        let src = &bytes[row * w * 4..][..w * 4];
        let start = (rect.y as usize + row) * frame.width as usize + rect.x as usize;
        let dst = &mut frame.pixels[start..start + w];
        for (pixel, chunk) in dst.iter_mut().zip(src.chunks_exact(4)) {
            let raw = [chunk[0], chunk[1], chunk[2], chunk[3]];
            let value = if msb_first {
                u32::from_be_bytes(raw)
            } else {
                u32::from_le_bytes(raw)
            };
            *pixel = value & 0x00ff_ffff;
        }
    }
}

fn wait_readable(fds: &[i32], timeout: Duration) {
    let mut polls: Vec<libc::pollfd> = fds
        .iter()
        .map(|&fd| libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        })
        .collect();
    let ms = timeout.as_millis().clamp(0, i32::MAX as u128) as i32;
    // Round up so a 0.5 ms wait does not spin.
    let ms = if ms == 0 && !timeout.is_zero() { 1 } else { ms };
    unsafe {
        libc::poll(polls.as_mut_ptr(), polls.len() as libc::nfds_t, ms);
    }
}

fn log(message: &str) {
    eprintln!("pickforge-viewer: {message}");
}

#[cfg(test)]
#[path = "capture_tests.rs"]
mod tests;
