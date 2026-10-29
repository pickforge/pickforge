//! Reads text from the host clipboard once, after the human clicks Paste.
//!
//! The text is often a password or a one-time code. It stays in this
//! process: no log line, error, event or panic holds it, and the clipboard
//! buffers are zeroed when dropped. Short-lived copies made for typing are
//! not. Only UTF-8 text is read; other formats count as
//! nothing to paste. A read is bounded in size and time, so a slow or huge
//! clipboard cannot block typing or fill memory. A read whose paste was
//! stopped, for example because control ended, starts no further step and
//! reads no further byte, and the app drops any result that arrives after
//! the stop.
//!
//! The X11 reader connects to the caller's `DISPLAY` with normal
//! authorization. The session display is never read or written here. On a
//! Wayland compositor without data-control, `data_device` asks the
//! selection for a pipe after the click, and `read_pipe` reads it.

use crate::input::MAX_TEXT_CHARS;
use crate::protocol::Backend;
use std::fmt;
use std::fs::File;
use std::io::Read;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, OwnedFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt as _, CreateWindowAux, WindowClass};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;
use x11rb::{CURRENT_TIME, NONE};
use zeroize::Zeroizing;

/// Most bytes one read accepts: `MAX_TEXT_CHARS` four-byte characters and
/// a trailing line break.
pub const MAX_PASTE_BYTES: usize = 4 * MAX_TEXT_CHARS + 2;
/// Longest one read may take, from the click to the last byte.
pub const READ_TIMEOUT: Duration = Duration::from_secs(1);

/// The Wayland MIME types read as text, most preferred first. Their bytes
/// must still be UTF-8.
pub(crate) const TEXT_TYPES: [&str; 3] = ["text/plain;charset=utf-8", "UTF8_STRING", "text/plain"];

/// Why a paste types nothing. It never holds clipboard content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// The clipboard is empty or holds no UTF-8 text.
    Empty,
    /// The text is over `MAX_TEXT_CHARS` characters.
    TooLong,
    /// The clipboard cannot be read now.
    Unavailable,
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Refusal::Empty => "the clipboard has no text",
            Refusal::TooLong => "the clipboard text is too long",
            Refusal::Unavailable => "the clipboard cannot be read",
        })
    }
}

impl std::error::Error for Refusal {}

/// Clipboard text that is zeroed when dropped and never printed.
pub struct Secret(Zeroizing<String>);

impl Secret {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(..)")
    }
}

/// Prepares clipboard text for typing. One trailing line break (`\n`,
/// `\r\n` or `\r`) is dropped, so a copied line does not submit a form,
/// and `\r\n` becomes one line break. Other control characters than line breaks and tabs refuse the
/// whole text.
pub fn prepare(raw: &str) -> Result<Secret, Refusal> {
    let body = raw
        .strip_suffix("\r\n")
        .or_else(|| raw.strip_suffix(['\n', '\r']))
        .unwrap_or(raw);
    // Never more bytes than `body`, so the buffer is not reallocated and
    // leaves no copy behind.
    let mut text = Zeroizing::new(String::with_capacity(body.len()));
    let mut chars = body.chars().peekable();
    let mut count = 0;
    while let Some(c) = chars.next() {
        if c == '\r' && chars.peek() == Some(&'\n') {
            continue;
        }
        if c.is_control() && !matches!(c, '\n' | '\r' | '\t') {
            return Err(Refusal::Empty);
        }
        count += 1;
        if count > MAX_TEXT_CHARS {
            return Err(Refusal::TooLong);
        }
        text.push(c);
    }
    if text.is_empty() {
        return Err(Refusal::Empty);
    }
    Ok(Secret(text))
}

/// Checks the size and encoding of read bytes and prepares the text.
fn finish(bytes: &[u8]) -> Result<Secret, Refusal> {
    if bytes.len() > MAX_PASTE_BYTES {
        return Err(Refusal::TooLong);
    }
    prepare(std::str::from_utf8(bytes).map_err(|_| Refusal::Empty)?)
}

/// Waits until `fd` is readable or `deadline` passes.
fn wait_readable(fd: BorrowedFd<'_>, deadline: Instant) -> Result<(), Refusal> {
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(Refusal::Unavailable);
        }
        let mut poll = libc::pollfd {
            fd: fd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let ms = left.as_millis().clamp(1, i32::MAX as u128) as i32;
        // SAFETY: one valid pollfd for the duration of the call.
        let n = unsafe { libc::poll(&mut poll, 1, ms) };
        if n > 0 {
            return Ok(());
        }
        if n < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return Err(Refusal::Unavailable);
        }
    }
}

/// Reads `fd` to its end, at most `max` bytes, before `deadline`. More
/// bytes refuse the text without reading the rest. Once `stopped` is set,
/// no further byte is read.
pub fn read_bounded(
    fd: BorrowedFd<'_>,
    deadline: Instant,
    max: usize,
    stopped: &PasteStop,
) -> Result<Zeroizing<Vec<u8>>, Refusal> {
    let mut file = File::from(fd.try_clone_to_owned().map_err(|_| Refusal::Unavailable)?);
    let mut buf = Zeroizing::new(vec![0u8; max + 1]);
    let mut len = 0;
    loop {
        wait_readable(fd, deadline)?;
        match stopped.while_wanted(|| file.read(&mut buf[len..]))? {
            Ok(0) => break,
            Ok(n) => len += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => return Err(Refusal::Unavailable),
        }
        if len > max {
            return Err(Refusal::TooLong);
        }
    }
    buf.truncate(len);
    Ok(buf)
}

/// Reads the clipboard of the host window system the viewer runs on. Once
/// `stopped` is set, the read starts no further step.
pub fn read(backend: Backend, stopped: &PasteStop) -> Result<Secret, Refusal> {
    match backend {
        Backend::Wayland => read_wayland(READ_TIMEOUT, stopped),
        Backend::X11 => {
            let (conn, screen) = x11rb::connect(None).map_err(unavailable)?;
            read_x11(&conn, screen, READ_TIMEOUT, stopped)
        }
    }
}

/// Set once the paste that asked for a read stops. A read step runs under
/// the lock and only while no stop is asked for, and a stop asks first and
/// then takes the lock. So a stop waits for at most the step under way, and
/// no step runs after it returns.
#[derive(Debug, Default)]
pub struct PasteStop {
    asked: AtomicBool,
    step: Mutex<()>,
}

impl PasteStop {
    /// A stop that is already set, for when no paste runs.
    pub fn stopped() -> PasteStop {
        PasteStop {
            asked: AtomicBool::new(true),
            step: Mutex::new(()),
        }
    }

    /// Stops the paste. Waits for a step under way to end.
    pub fn stop(&self) {
        self.asked.store(true, Ordering::SeqCst);
        drop(self.lock());
    }

    pub fn is_stopped(&self) -> bool {
        self.asked.load(Ordering::SeqCst)
    }

    fn lock(&self) -> MutexGuard<'_, ()> {
        self.step.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Runs `step` unless the paste has stopped, and keeps a stop from
    /// returning until `step` ends.
    fn while_wanted<T>(&self, step: impl FnOnce() -> T) -> Result<T, Refusal> {
        let _step = self.lock();
        if self.is_stopped() {
            return Err(Refusal::Unavailable);
        }
        Ok(step())
    }
}

/// Refuses to go on once the paste that asked for the read has stopped.
fn still_wanted(stopped: &PasteStop) -> Result<(), Refusal> {
    stopped.while_wanted(|| ())
}

/// Reads the Wayland clipboard through the data-control protocol.
pub fn read_wayland(timeout: Duration, stopped: &PasteStop) -> Result<Secret, Refusal> {
    use wl_clipboard_rs::paste::{get_contents, ClipboardType, MimeType, Seat};
    let deadline = Instant::now() + timeout;
    still_wanted(stopped)?;
    let (pipe, mime) = get_contents(
        ClipboardType::Regular,
        Seat::Unspecified,
        MimeType::TextWithPriority(TEXT_TYPES[0]),
    )
    .map_err(|e| wayland_refusal(&e))?;
    if !TEXT_TYPES.contains(&mime.as_str()) {
        return Err(Refusal::Empty);
    }
    still_wanted(stopped)?;
    let bytes = read_bounded(pipe.as_fd(), deadline, MAX_PASTE_BYTES, stopped)?;
    finish(&bytes)
}

/// Reads the pipe a Wayland selection writes to, to its end before
/// `deadline`. Once `stopped` is set, the pipe is closed unread.
pub fn read_pipe(pipe: OwnedFd, deadline: Instant, stopped: &PasteStop) -> Result<Secret, Refusal> {
    still_wanted(stopped)?;
    let bytes = read_bounded(pipe.as_fd(), deadline, MAX_PASTE_BYTES, stopped)?;
    finish(&bytes)
}

/// An empty clipboard and a clipboard without text are nothing to paste.
/// Anything else, such as a compositor without data-control, means the
/// clipboard cannot be read.
pub fn wayland_refusal(error: &wl_clipboard_rs::paste::Error) -> Refusal {
    use wl_clipboard_rs::paste::Error;
    match error {
        Error::NoSeats | Error::ClipboardEmpty | Error::NoMimeType => Refusal::Empty,
        _ => Refusal::Unavailable,
    }
}

fn unavailable<E>(_: E) -> Refusal {
    Refusal::Unavailable
}

struct Atoms {
    clipboard: u32,
    utf8: u32,
    incr: u32,
    property: u32,
}

impl Atoms {
    fn intern(conn: &RustConnection) -> Result<Atoms, Refusal> {
        let cookies = [
            b"CLIPBOARD".as_slice(),
            b"UTF8_STRING",
            b"INCR",
            b"PICKFORGE_PASTE",
        ]
        .map(|name| conn.intern_atom(false, name));
        let mut atoms = [0u32; 4];
        for (atom, cookie) in atoms.iter_mut().zip(cookies) {
            *atom = cookie
                .map_err(unavailable)?
                .reply()
                .map_err(unavailable)?
                .atom;
        }
        let [clipboard, utf8, incr, property] = atoms;
        Ok(Atoms {
            clipboard,
            utf8,
            incr,
            property,
        })
    }
}

/// Converts CLIPBOARD to UTF8_STRING on an unmapped window of `conn` and
/// reads the result once. INCR transfers are refused and never started.
/// The window is destroyed afterwards, so no conversion is left behind.
pub fn read_x11(
    conn: &RustConnection,
    screen: usize,
    timeout: Duration,
    stopped: &PasteStop,
) -> Result<Secret, Refusal> {
    let deadline = Instant::now() + timeout;
    let atoms = Atoms::intern(conn)?;
    let root = conn
        .setup()
        .roots
        .get(screen)
        .ok_or(Refusal::Unavailable)?
        .root;
    let window = conn.generate_id().map_err(unavailable)?;
    conn.create_window(
        0,
        window,
        root,
        -1,
        -1,
        1,
        1,
        0,
        WindowClass::INPUT_ONLY,
        0,
        &CreateWindowAux::new(),
    )
    .map_err(unavailable)?;
    let result = convert(conn, window, &atoms, deadline, stopped);
    let _ = conn.destroy_window(window);
    let _ = conn.flush();
    result
}

fn convert(
    conn: &RustConnection,
    window: u32,
    atoms: &Atoms,
    deadline: Instant,
    stopped: &PasteStop,
) -> Result<Secret, Refusal> {
    still_wanted(stopped)?;
    conn.convert_selection(
        window,
        atoms.clipboard,
        atoms.utf8,
        atoms.property,
        CURRENT_TIME,
    )
    .map_err(unavailable)?;
    conn.flush().map_err(unavailable)?;
    wait_notify(conn, window, deadline)?;
    let long_length = (MAX_PASTE_BYTES / 4 + 1) as u32;
    // Read without deleting: deleting an INCR property would start the
    // transfer. The reply carries the text, so the request and its reply
    // are one step. A stop waits for that round trip to the X server the
    // window itself runs on.
    let reply = stopped
        .while_wanted(|| {
            conn.get_property(false, window, atoms.property, AtomEnum::ANY, 0, long_length)?
                .reply()
        })?
        .map_err(unavailable)?;
    let value = Zeroizing::new(reply.value);
    if reply.type_ == NONE {
        return Err(Refusal::Empty);
    }
    if reply.type_ == atoms.incr {
        return Err(Refusal::TooLong);
    }
    conn.delete_property(window, atoms.property)
        .map_err(unavailable)?;
    if reply.bytes_after > 0 {
        return Err(Refusal::TooLong);
    }
    if reply.type_ != atoms.utf8 || reply.format != 8 {
        return Err(Refusal::Empty);
    }
    finish(&value)
}

/// Waits for the owner's answer. A refused conversion is nothing to paste.
fn wait_notify(conn: &RustConnection, window: u32, deadline: Instant) -> Result<(), Refusal> {
    loop {
        while let Some(event) = conn.poll_for_event().map_err(unavailable)? {
            match event {
                Event::SelectionNotify(e) if e.requestor == window && e.property == NONE => {
                    return Err(Refusal::Empty)
                }
                Event::SelectionNotify(e) if e.requestor == window => return Ok(()),
                _ => {}
            }
        }
        wait_readable(conn.stream().as_fd(), deadline)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::net::UnixStream;

    fn text(raw: &str) -> Result<String, Refusal> {
        prepare(raw).map(|s| s.as_str().to_owned())
    }

    #[test]
    fn prepare_drops_one_trailing_line_break_and_keeps_inner_ones() {
        assert_eq!(text("hunter2\n").unwrap(), "hunter2");
        assert_eq!(text("hunter2\r\n").unwrap(), "hunter2");
        assert_eq!(text("123456\r").unwrap(), "123456");
        assert_eq!(text("a\r\r").unwrap(), "a\r");
        assert_eq!(text("a\n\n").unwrap(), "a\n");
        assert_eq!(text("a\r\nb\tc\n").unwrap(), "a\nb\tc");
        assert_eq!(text("Olá ß €").unwrap(), "Olá ß €");
        assert_eq!(text("\n"), Err(Refusal::Empty));
        assert_eq!(text(""), Err(Refusal::Empty));
        assert_eq!(text("a\u{1b}b"), Err(Refusal::Empty));
        assert_eq!(text("a\0"), Err(Refusal::Empty));
        let full = "é".repeat(MAX_TEXT_CHARS);
        assert!(text(&format!("{full}\n")).is_ok());
        assert_eq!(text(&format!("{full}x")), Err(Refusal::TooLong));
    }

    #[test]
    fn finish_refuses_invalid_utf8_and_oversized_bytes() {
        assert!(matches!(finish(b"\xff\xfe"), Err(Refusal::Empty)));
        let max = "😀".repeat(MAX_TEXT_CHARS) + "\r\n";
        assert_eq!(max.len(), MAX_PASTE_BYTES);
        assert!(finish(max.as_bytes()).is_ok());
        let over = vec![b'a'; MAX_PASTE_BYTES + 1];
        assert!(matches!(finish(&over), Err(Refusal::TooLong)));
    }

    #[test]
    fn secrets_and_refusals_print_no_content() {
        let secret = prepare("marker-7c1f").unwrap();
        assert_eq!(format!("{secret:?}"), "Secret(..)");
        for refusal in [Refusal::Empty, Refusal::TooLong, Refusal::Unavailable] {
            assert!(!refusal.to_string().is_empty());
        }
    }

    #[test]
    fn read_bounded_reads_to_the_end() {
        let (mut writer, reader) = UnixStream::pair().unwrap();
        writer.write_all(b"one-time 123456").unwrap();
        drop(writer);
        let deadline = Instant::now() + Duration::from_secs(1);
        let bytes = read_bounded(reader.as_fd(), deadline, 64, &PasteStop::default()).unwrap();
        assert_eq!(&bytes[..], b"one-time 123456");
    }

    #[test]
    fn read_bounded_stops_after_the_bound() {
        let (mut writer, reader) = UnixStream::pair().unwrap();
        let feeder = std::thread::spawn(move || {
            // The reader stops early, so later writes may fail.
            let _ = writer.write_all(&vec![b'a'; 4 * 64 + 10]);
        });
        let deadline = Instant::now() + Duration::from_secs(1);
        let result = read_bounded(reader.as_fd(), deadline, 64, &PasteStop::default());
        assert!(matches!(result, Err(Refusal::TooLong)));
        drop(reader);
        feeder.join().unwrap();
    }

    #[test]
    fn read_pipe_reads_only_while_the_paste_is_wanted() {
        let fill = |bytes: &[u8]| {
            let (mut writer, reader) = UnixStream::pair().unwrap();
            writer.write_all(bytes).unwrap();
            OwnedFd::from(reader)
        };
        let deadline = Instant::now() + Duration::from_secs(1);
        let running = PasteStop::default();
        let text = read_pipe(fill(b"hunter2\n"), deadline, &running).unwrap();
        assert_eq!(text.as_str(), "hunter2");
        let stopped = PasteStop::stopped();
        let refused = read_pipe(fill(b"hunter2"), deadline, &stopped);
        assert!(matches!(refused, Err(Refusal::Unavailable)));
        let over = vec![b'a'; MAX_PASTE_BYTES + 1];
        let refused = read_pipe(fill(&over), deadline, &running);
        assert!(matches!(refused, Err(Refusal::TooLong)));
        let refused = read_pipe(fill(b"\x89PNG"), deadline, &running);
        assert!(matches!(refused, Err(Refusal::Empty)));
    }

    #[test]
    fn a_read_waiting_when_the_paste_stops_reads_no_byte() {
        let (mut writer, reader) = UnixStream::pair().unwrap();
        let peek = reader.try_clone().unwrap();
        let stopped = PasteStop::default();
        let deadline = Instant::now() + Duration::from_secs(5);
        let result = std::thread::scope(|scope| {
            let read = scope.spawn(|| read_pipe(OwnedFd::from(reader), deadline, &stopped));
            std::thread::sleep(Duration::from_millis(100));
            assert!(!read.is_finished(), "the read is not waiting");
            stopped.stop();
            writer.write_all(b"hunter2").unwrap();
            drop(writer);
            read.join().unwrap()
        });
        assert!(matches!(result, Err(Refusal::Unavailable)));
        let mut unread = Vec::new();
        (&peek).read_to_end(&mut unread).unwrap();
        assert_eq!(unread, b"hunter2", "the stopped read took bytes");
    }

    #[test]
    fn a_stop_waits_for_the_step_under_way_and_refuses_the_next() {
        let stop = PasteStop::default();
        std::thread::scope(|scope| {
            let stopper = stop
                .while_wanted(|| {
                    let stopper = scope.spawn(|| stop.stop());
                    while !stop.is_stopped() {
                        std::thread::yield_now();
                    }
                    std::thread::sleep(Duration::from_millis(50));
                    assert!(!stopper.is_finished(), "the stop did not wait for the step");
                    stopper
                })
                .unwrap();
            // Whether or not the stop has taken the lock yet, no step runs.
            assert!(matches!(
                stop.while_wanted(|| ()),
                Err(Refusal::Unavailable)
            ));
            stopper.join().unwrap();
        });
        assert!(matches!(
            stop.while_wanted(|| ()),
            Err(Refusal::Unavailable)
        ));
    }

    #[test]
    fn read_bounded_gives_up_at_the_deadline() {
        let (mut writer, reader) = UnixStream::pair().unwrap();
        writer.write_all(b"partial").unwrap();
        let start = Instant::now();
        let result = read_bounded(
            reader.as_fd(),
            start + Duration::from_millis(200),
            64,
            &PasteStop::default(),
        );
        assert!(matches!(result, Err(Refusal::Unavailable)));
        let took = start.elapsed();
        assert!(took >= Duration::from_millis(200) && took < Duration::from_secs(1));
        drop(writer);
    }
}
