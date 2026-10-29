//! Reads the Wayland clipboard through the viewer window's own
//! `wl_data_device`, for compositors without data-control, such as GNOME.
//!
//! The device lives on winit's connection, on its own event queue, so the
//! compositor sends it the selection when the viewer window gets keyboard
//! focus, as a click on Paste gives it. Selection offers are only tracked
//! until the click: their text types are noted, and no offer is received
//! before it. An offer is valid only while the window has keyboard focus,
//! so it is dropped when focus goes. A click asks the selection's owner to
//! write into a pipe, which `clipboard::read_pipe` reads with the usual
//! bounds.

use crate::clipboard::{Refusal, TEXT_TYPES};
use std::os::fd::{AsFd, OwnedFd};
use std::rc::Rc;
use std::sync::atomic::{AtomicUsize, Ordering};
use wayland_client::backend::{Backend, WaylandError};
use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::wl_data_device::{self, WlDataDevice};
use wayland_client::protocol::wl_data_device_manager::WlDataDeviceManager;
use wayland_client::protocol::wl_data_offer::{self, WlDataOffer};
use wayland_client::protocol::wl_registry::WlRegistry;
use wayland_client::protocol::wl_seat::WlSeat;
use wayland_client::{event_created_child, Connection, Dispatch, EventQueue, Proxy, QueueHandle};
use winit::raw_window_handle::{HasDisplayHandle, RawDisplayHandle};
use winit::window::Window;

/// Globals that let `clipboard::read_wayland` read without focus. Where
/// one exists, that reader stays the only one.
const DATA_CONTROL: [&str; 2] = [
    "zwlr_data_control_manager_v1",
    "ext_data_control_manager_v1",
];

/// True when a global list offers data-control.
pub fn has_data_control<'a>(mut interfaces: impl Iterator<Item = &'a str>) -> bool {
    interfaces.any(|name| DATA_CONTROL.contains(&name))
}

/// The best text type an offer announced, as an index into `TEXT_TYPES`.
/// Other types are not kept, so a long type list costs nothing.
#[derive(Debug)]
pub struct OfferTypes(AtomicUsize);

impl Default for OfferTypes {
    fn default() -> Self {
        OfferTypes(AtomicUsize::new(usize::MAX))
    }
}

impl OfferTypes {
    pub fn add(&self, mime: &str) {
        if let Some(rank) = TEXT_TYPES.iter().position(|&t| t == mime) {
            self.0.fetch_min(rank, Ordering::Relaxed);
        }
    }

    /// The type to ask for. None means the offer holds no text.
    pub fn best(&self) -> Option<&'static str> {
        TEXT_TYPES.get(self.0.load(Ordering::Relaxed)).copied()
    }
}

/// The type to ask an offer for. An offer without a text type is nothing
/// to paste.
pub fn choose(selection: Option<&OfferTypes>) -> Result<&'static str, Refusal> {
    selection.and_then(OfferTypes::best).ok_or(Refusal::Empty)
}

#[derive(Default)]
struct State {
    selection: Option<WlDataOffer>,
    /// A drag over the window. It is never accepted.
    drag: Option<WlDataOffer>,
}

/// The data device of the viewer window's seat.
pub struct DataDevice {
    queue: EventQueue<State>,
    state: State,
    device: WlDataDevice,
    conn: Connection,
    /// Keeps winit's connection open while the device uses it.
    window: Rc<Window>,
}

impl DataDevice {
    /// Creates the device on `window`'s connection. Returns None on X11,
    /// where data-control exists, or without a data device manager or seat.
    pub fn new(window: Rc<Window>) -> Option<DataDevice> {
        let RawDisplayHandle::Wayland(handle) = window.display_handle().ok()?.as_raw() else {
            return None;
        };
        // SAFETY: the pointer is winit's live `wl_display`, which outlives
        // this connection because `window` keeps it open.
        let backend = unsafe { Backend::from_foreign_display(handle.display.as_ptr().cast()) };
        let conn = Connection::from_backend(backend);
        let (globals, queue) = registry_queue_init::<State>(&conn)
            .map_err(|e| failed("list the Wayland globals", e))
            .ok()?;
        let control = globals
            .contents()
            .with_list(|list| has_data_control(list.iter().map(|g| g.interface.as_str())));
        if control {
            return None;
        }
        let qh = queue.handle();
        let manager: WlDataDeviceManager = globals
            .bind(&qh, 1..=3, ())
            .map_err(|e| failed("bind wl_data_device_manager", e))
            .ok()?;
        let seat: WlSeat = globals
            .bind(&qh, 1..=1, ())
            .map_err(|e| failed("bind wl_seat", e))
            .ok()?;
        let device = manager.get_data_device(&seat, &qh, ());
        conn.flush()
            .map_err(|e| failed("create the data device", e))
            .ok()?;
        Some(DataDevice {
            queue,
            state: State::default(),
            device,
            conn,
            window,
        })
    }

    /// Notes the offers that arrived since the last call, and drops the
    /// selection while the window has no keyboard focus. Nothing is read.
    pub fn track(&mut self) {
        let _ = self.queue.dispatch_pending(&mut self.state);
        self.drop_unfocused();
    }

    /// Drops the selection unless the window has keyboard focus, and
    /// returns whether it has.
    ///
    /// winit reads the socket for both queues before it hands out the
    /// window events of a loop turn, and this queue is dispatched only
    /// between reads. So after a dispatch, the selection and `has_focus`
    /// describe the same point of the stream. The compositor sends a
    /// selection only to the focused client or right before a keyboard
    /// enter. An offer held without focus therefore came before the loss
    /// and is dropped. An offer sent before a later enter is read with
    /// that enter and kept. A read that splits the two drops that offer,
    /// so Paste finds nothing until the next copy or focus change.
    fn drop_unfocused(&mut self) -> bool {
        if self.window.has_focus() {
            return true;
        }
        replace(&mut self.state.selection, None);
        false
    }

    /// Asks the current selection for text and returns the pipe it is
    /// written to. Call only after a click on Paste while the window has
    /// keyboard focus.
    pub fn receive(&mut self) -> Result<OwnedFd, Refusal> {
        self.queue
            .dispatch_pending(&mut self.state)
            .map_err(|_| Refusal::Unavailable)?;
        if !self.drop_unfocused() {
            return Err(Refusal::Unavailable);
        }
        let Some(offer) = &self.state.selection else {
            return Err(Refusal::Empty);
        };
        let mime = choose(offer.data::<OfferTypes>())?;
        let (read, write) = std::io::pipe().map_err(|_| Refusal::Unavailable)?;
        offer.receive(mime.to_owned(), write.as_fd());
        drop(write);
        match self.conn.flush() {
            Ok(()) => Ok(read.into()),
            // The request is queued; winit flushes before it waits.
            Err(WaylandError::Io(e)) if e.kind() == std::io::ErrorKind::WouldBlock => {
                Ok(read.into())
            }
            Err(_) => Err(Refusal::Unavailable),
        }
    }
}

impl Drop for DataDevice {
    fn drop(&mut self) {
        for offer in [self.state.selection.take(), self.state.drag.take()]
            .into_iter()
            .flatten()
        {
            offer.destroy();
        }
        if self.device.version() >= 2 {
            self.device.release();
        }
        let _ = self.conn.flush();
    }
}

/// Notes on stderr why Paste cannot read the clipboard. Setup holds no
/// clipboard content, so the line names only the step and its error.
fn failed(step: &str, error: impl std::fmt::Display) {
    eprintln!("pickforge-viewer: paste is unavailable: cannot {step}: {error}");
}

/// Destroys the offer in `slot` unless it stays, and keeps `offer`.
fn replace(slot: &mut Option<WlDataOffer>, offer: Option<WlDataOffer>) {
    if let Some(old) = slot.take() {
        if offer.as_ref() != Some(&old) {
            old.destroy();
        }
    }
    *slot = offer;
}

impl Dispatch<WlRegistry, GlobalListContents> for State {
    fn event(
        _: &mut Self,
        _: &WlRegistry,
        _: <WlRegistry as Proxy>::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<WlDataDeviceManager, ()> for State {
    fn event(
        _: &mut Self,
        _: &WlDataDeviceManager,
        _: <WlDataDeviceManager as Proxy>::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<WlSeat, ()> for State {
    fn event(
        _: &mut Self,
        _: &WlSeat,
        _: <WlSeat as Proxy>::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<WlDataDevice, ()> for State {
    fn event(
        state: &mut Self,
        _: &WlDataDevice,
        event: wl_data_device::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            wl_data_device::Event::Selection { id } => replace(&mut state.selection, id),
            wl_data_device::Event::Enter { id, .. } => replace(&mut state.drag, id),
            wl_data_device::Event::Leave | wl_data_device::Event::Drop => {
                replace(&mut state.drag, None)
            }
            _ => {}
        }
    }

    event_created_child!(State, WlDataDevice, [
        wl_data_device::EVT_DATA_OFFER_OPCODE => (WlDataOffer, OfferTypes::default()),
    ]);
}

impl Dispatch<WlDataOffer, OfferTypes> for State {
    fn event(
        _: &mut Self,
        _: &WlDataOffer,
        event: wl_data_offer::Event,
        types: &OfferTypes,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_data_offer::Event::Offer { mime_type } = event {
            types.add(&mime_type);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offered(types: &[&str]) -> OfferTypes {
        let offer = OfferTypes::default();
        for mime in types {
            offer.add(mime);
        }
        offer
    }

    #[test]
    fn text_types_follow_the_data_control_preference() {
        let all = offered(&["text/plain", "UTF8_STRING", "text/plain;charset=utf-8"]);
        assert_eq!(choose(Some(&all)), Ok("text/plain;charset=utf-8"));
        let two = offered(&["TEXT", "text/plain", "STRING", "UTF8_STRING"]);
        assert_eq!(choose(Some(&two)), Ok("UTF8_STRING"));
        let plain = offered(&["text/html", "text/plain"]);
        assert_eq!(choose(Some(&plain)), Ok("text/plain"));
    }

    #[test]
    fn an_offer_without_a_text_type_is_nothing_to_paste() {
        assert_eq!(choose(None), Err(Refusal::Empty));
        assert_eq!(choose(Some(&offered(&[]))), Err(Refusal::Empty));
        let image = offered(&["image/png", "TEXT", "STRING", "text/html", "text/uri-list"]);
        assert_eq!(choose(Some(&image)), Err(Refusal::Empty));
    }

    #[test]
    fn data_control_globals_keep_the_data_control_reader() {
        let gnome = ["wl_compositor", "wl_data_device_manager", "wl_seat"];
        assert!(!has_data_control(gnome.into_iter()));
        for control in DATA_CONTROL {
            assert!(has_data_control(gnome.into_iter().chain([control])));
        }
        assert!(!has_data_control(
            ["zwp_primary_selection_device_manager_v1"].into_iter()
        ));
    }
}
