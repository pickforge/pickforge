//! A CLIPBOARD owner on a test display that answers conversions the way
//! the test asks, and counts them.

#![allow(dead_code)]

use pickforge_viewer::capture::connect_display;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    AtomEnum, ChangeWindowAttributesAux, ConnectionExt as _, CreateWindowAux, EventMask, PropMode,
    SelectionNotifyEvent, WindowClass, SELECTION_NOTIFY_EVENT,
};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;
use x11rb::{CURRENT_TIME, NONE};

/// How the owner answers a conversion.
#[derive(Debug, Clone)]
pub enum Serve {
    /// UTF8_STRING with these bytes in one property.
    Text(Vec<u8>),
    /// Only image/png; a text conversion is refused.
    ImageOnly,
    /// UTF8_STRING announced as an INCR transfer.
    Incr,
    /// No answer at all.
    Silent,
}

pub struct Owner {
    stop: Arc<AtomicBool>,
    requests: Arc<AtomicUsize>,
    thread: Option<JoinHandle<()>>,
}

fn atom(conn: &RustConnection, name: &str) -> u32 {
    conn.intern_atom(false, name.as_bytes())
        .unwrap()
        .reply()
        .unwrap()
        .atom
}

impl Owner {
    /// Takes CLIPBOARD on `display` and serves it until dropped.
    pub fn start(display: u32, serve: Serve) -> Owner {
        let conn = connect_display(display).expect("connect owner");
        let root = conn.setup().roots[0].root;
        let window = conn.generate_id().unwrap();
        conn.create_window(
            0,
            window,
            root,
            0,
            0,
            1,
            1,
            0,
            WindowClass::INPUT_OUTPUT,
            0,
            &CreateWindowAux::new(),
        )
        .unwrap();
        let clipboard = atom(&conn, "CLIPBOARD");
        conn.set_selection_owner(window, clipboard, CURRENT_TIME)
            .unwrap();
        let owner = conn
            .get_selection_owner(clipboard)
            .unwrap()
            .reply()
            .unwrap()
            .owner;
        assert_eq!(owner, window, "the test owns CLIPBOARD");
        let stop = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(AtomicUsize::new(0));
        let thread = {
            let (stop, requests) = (stop.clone(), requests.clone());
            thread::spawn(move || serve_loop(conn, serve, &stop, &requests))
        };
        Owner {
            stop,
            requests,
            thread: Some(thread),
        }
    }

    /// Conversion requests answered or ignored so far.
    pub fn requests(&self) -> usize {
        self.requests.load(Ordering::SeqCst)
    }
}

impl Drop for Owner {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct Atoms {
    utf8: u32,
    targets: u32,
    incr: u32,
    png: u32,
}

fn serve_loop(conn: RustConnection, serve: Serve, stop: &AtomicBool, requests: &AtomicUsize) {
    let atoms = Atoms {
        utf8: atom(&conn, "UTF8_STRING"),
        targets: atom(&conn, "TARGETS"),
        incr: atom(&conn, "INCR"),
        png: atom(&conn, "image/png"),
    };
    while !stop.load(Ordering::SeqCst) {
        let Ok(event) = conn.poll_for_event() else {
            return;
        };
        let Some(Event::SelectionRequest(request)) = event else {
            thread::sleep(Duration::from_millis(5));
            continue;
        };
        requests.fetch_add(1, Ordering::SeqCst);
        if matches!(serve, Serve::Silent) {
            continue;
        }
        let property = if request.property == NONE {
            request.target
        } else {
            request.property
        };
        let answered = answer(
            &conn,
            &serve,
            &atoms,
            request.requestor,
            request.target,
            property,
        );
        let event = SelectionNotifyEvent {
            response_type: SELECTION_NOTIFY_EVENT,
            sequence: 0,
            time: request.time,
            requestor: request.requestor,
            selection: request.selection,
            target: request.target,
            property: if answered { property } else { NONE },
        };
        let _ = conn.send_event(false, request.requestor, EventMask::NO_EVENT, event);
        let _ = conn.flush();
    }
}

/// Writes the answer to `target` on `to`. Returns false for a refusal.
fn answer(
    conn: &RustConnection,
    serve: &Serve,
    atoms: &Atoms,
    to: u32,
    target: u32,
    property: u32,
) -> bool {
    match (serve, target) {
        (_, t) if t == atoms.targets => {
            let offered = match serve {
                Serve::ImageOnly => vec![atoms.targets, atoms.png],
                _ => vec![atoms.targets, atoms.utf8],
            };
            conn.change_property32(PropMode::REPLACE, to, property, AtomEnum::ATOM, &offered)
                .is_ok()
        }
        (Serve::Text(bytes), t) if t == atoms.utf8 => conn
            .change_property8(PropMode::REPLACE, to, property, atoms.utf8, bytes)
            .is_ok(),
        (Serve::ImageOnly, t) if t == atoms.png => conn
            .change_property8(PropMode::REPLACE, to, property, atoms.png, b"\x89PNG")
            .is_ok(),
        (Serve::Incr, t) if t == atoms.utf8 => {
            let watch = ChangeWindowAttributesAux::new().event_mask(EventMask::PROPERTY_CHANGE);
            conn.change_window_attributes(to, &watch).is_ok()
                && conn
                    .change_property32(PropMode::REPLACE, to, property, atoms.incr, &[1 << 20])
                    .is_ok()
        }
        _ => false,
    }
}

/// The owner of `selection` on `display`, or `NONE`.
pub fn selection_owner(display: u32, selection: &str) -> u32 {
    let conn = connect_display(display).expect("connect");
    let selection = atom(&conn, selection);
    conn.get_selection_owner(selection)
        .unwrap()
        .reply()
        .unwrap()
        .owner
}
