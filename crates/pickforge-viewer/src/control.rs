//! The control state machine from `PROTOCOL.md`: grants, renewals, expiry,
//! revokes, Take control and Return control. It owns the input sink and
//! releases held input before it reports the end of control (invariant I4).
//! The sink checks the grant on every input as well (invariant I1).

use crate::protocol::{AckState, Command, Event, Mode, ReturnReason, RevokeReason};
use std::time::{Duration, Instant};

/// How long a note such as "Control ended" stays.
pub const NOTE_FOR: Duration = Duration::from_secs(4);
/// A Take control press waits this long for the host's answer before
/// another press sends a new request.
pub const TAKE_PENDING_FOR: Duration = Duration::from_secs(10);

/// Where input goes. The injector implements it; tests use a recorder.
pub trait Sink {
    /// Allows input under `lease_id` until `until`.
    fn grant(&mut self, lease_id: &str, until: Instant) -> Result<(), String>;
    /// Drops the grant and releases every held key and button.
    fn revoke(&mut self) -> Result<(), String>;
    /// Releases every held key and button and keeps the grant.
    fn release_all(&mut self) -> Result<(), String>;
}

/// A short status text about control.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Note {
    Unavailable,
    Ended,
    NothingToPaste,
    PasteTooLong,
    PasteUnavailable,
}

impl Note {
    pub fn text(self) -> &'static str {
        match self {
            Note::Unavailable => "Control unavailable",
            Note::Ended => "Control ended",
            Note::NothingToPaste => "Nothing to paste",
            Note::PasteTooLong => "Too long to paste",
            Note::PasteUnavailable => "Paste unavailable",
        }
    }
}

/// What the window does after a control change.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    Emit(Event),
    /// Expand as for a thumbnail click.
    Expand,
}

pub struct Controller<S> {
    sink: Option<S>,
    grant: Option<(String, Instant)>,
    attention: Option<String>,
    take_sent: Option<Instant>,
    note: Option<(Note, Instant)>,
    ended: bool,
}

fn release(result: Result<(), String>) {
    if let Err(e) = result {
        eprintln!("pickforge-viewer: cannot release session input: {e}");
    }
}

impl<S: Sink> Controller<S> {
    /// A controller without a sink never takes control.
    pub fn new(sink: Option<S>) -> Self {
        Self {
            sink,
            grant: None,
            attention: None,
            take_sent: None,
            note: None,
            ended: false,
        }
    }

    pub fn sink_mut(&mut self) -> Option<&mut S> {
        self.sink.as_mut()
    }

    /// True from a grant until its revoke, return or expiry.
    pub fn controlling(&self) -> bool {
        self.grant.is_some()
    }

    /// True while input may reach the session from this window mode.
    pub fn forwarding(&self, mode: Mode) -> bool {
        self.controlling() && mode != Mode::Thumbnail
    }

    /// True when the window offers Take control.
    pub fn can_take(&self) -> bool {
        self.sink.is_some() && !self.ended && self.grant.is_none()
    }

    pub fn attention(&self) -> Option<&str> {
        self.attention.as_deref()
    }

    pub fn note(&self) -> Option<Note> {
        self.note.map(|(note, _)| note)
    }

    /// Shows `note` for `NOTE_FOR`.
    pub fn show(&mut self, note: Note, now: Instant) {
        self.note = Some((note, now + NOTE_FOR));
    }

    /// The lease of the live grant.
    pub fn lease_id(&self) -> Option<&str> {
        self.grant.as_ref().map(|(id, _)| id.as_str())
    }

    /// Handles `attention`, `clearAttention` and `control`. Other commands
    /// return nothing.
    pub fn on_command(&mut self, command: &Command, mode: Mode, now: Instant) -> Vec<Effect> {
        match command {
            Command::Attention { message } => {
                self.attention = Some(message.clone());
                Vec::new()
            }
            Command::ClearAttention => {
                self.attention = None;
                Vec::new()
            }
            Command::Grant { lease_id, grant_ms } => self.grant(lease_id, *grant_ms, mode, now),
            Command::Revoke { lease_id, reason } => self.revoke(lease_id, *reason, now),
            _ => Vec::new(),
        }
    }

    fn grant(&mut self, lease_id: &str, grant_ms: u64, mode: Mode, now: Instant) -> Vec<Effect> {
        let Some(sink) = self.sink.as_mut().filter(|_| !self.ended) else {
            eprintln!("pickforge-viewer: ignored a control grant: the session ended or input is unavailable");
            return Vec::new();
        };
        let until = now + Duration::from_millis(grant_ms);
        if let Err(e) = sink.grant(lease_id, until) {
            eprintln!("pickforge-viewer: control grant: {e}");
        }
        // A renewal keeps a paste note; a new grant clears old notes.
        if self.lease_id() != Some(lease_id) {
            self.note = None;
        }
        self.grant = Some((lease_id.to_owned(), until));
        self.attention = None;
        self.take_sent = None;
        let mut effects = vec![Effect::Emit(Event::ControlAck {
            lease_id: lease_id.to_owned(),
            state: AckState::Granted,
        })];
        if mode == Mode::Thumbnail {
            effects.push(Effect::Expand);
        }
        effects
    }

    fn revoke(&mut self, lease_id: &str, reason: RevokeReason, now: Instant) -> Vec<Effect> {
        self.drop_grant();
        self.take_sent = None;
        match reason {
            RevokeReason::Unavailable => self.note = Some((Note::Unavailable, now + NOTE_FOR)),
            RevokeReason::LeaseLost => self.note = Some((Note::Ended, now + NOTE_FOR)),
            _ => {}
        }
        vec![Effect::Emit(Event::ControlAck {
            lease_id: lease_id.to_owned(),
            state: AckState::Revoked,
        })]
    }

    /// Revokes the sink, which releases held input, and forgets the grant.
    fn drop_grant(&mut self) {
        if let Some(sink) = self.sink.as_mut() {
            release(sink.revoke());
        }
        self.grant = None;
    }

    /// The user pressed Take control. Returns the request to send, or
    /// nothing while one is pending or control is not available.
    pub fn take(&mut self, now: Instant) -> Option<Event> {
        if !self.can_take() || self.take_sent.is_some_and(|at| now < at + TAKE_PENDING_FOR) {
            return None;
        }
        self.take_sent = Some(now);
        Some(Event::TakeRequested)
    }

    /// The user pressed Return control. Held input is released before the
    /// request is returned.
    pub fn give_back(&mut self) -> Option<Event> {
        if !self.controlling() {
            return None;
        }
        self.drop_grant();
        Some(Event::ReturnRequested {
            reason: ReturnReason::Button,
        })
    }

    /// The user closed the window. Returns the events to send in order.
    pub fn close(&mut self) -> Vec<Event> {
        let mut events = Vec::new();
        if self.controlling() {
            self.drop_grant();
            events.push(Event::ReturnRequested {
                reason: ReturnReason::Closed,
            });
        }
        events.push(Event::Closed);
        events
    }

    /// Ends control without asking the host: stdin end of file, shutdown
    /// and session end.
    pub fn stop(&mut self) {
        self.drop_grant();
        self.take_sent = None;
    }

    /// The session ended. Control stops and is not offered again.
    pub fn end_session(&mut self) {
        self.stop();
        self.ended = true;
    }

    /// Releases held keys and buttons and keeps control, as on focus loss.
    pub fn release_held(&mut self) {
        if let Some(sink) = self.sink.as_mut() {
            release(sink.release_all());
        }
    }

    /// Ends an expired grant and clears old notes. Returns true when
    /// something visible changed.
    pub fn tick(&mut self, now: Instant) -> bool {
        let mut changed = false;
        if self.grant.as_ref().is_some_and(|(_, until)| now >= *until) {
            self.drop_grant();
            self.note = Some((Note::Ended, now + NOTE_FOR));
            changed = true;
        }
        if self.note.is_some_and(|(_, until)| now >= until) {
            self.note = None;
            changed = true;
        }
        if self
            .take_sent
            .is_some_and(|at| now >= at + TAKE_PENDING_FOR)
        {
            self.take_sent = None;
        }
        changed
    }

    /// The next instant `tick` has work to do.
    pub fn deadline(&self) -> Option<Instant> {
        let grant = self.grant.as_ref().map(|(_, until)| *until);
        let note = self.note.map(|(_, until)| until);
        grant.into_iter().chain(note).min()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    /// Records sink calls.
    #[derive(Clone, Default)]
    struct Recorder(Rc<RefCell<Vec<String>>>);

    impl Recorder {
        fn take(&self) -> Vec<String> {
            std::mem::take(&mut self.0.borrow_mut())
        }
    }

    impl Sink for Recorder {
        fn grant(&mut self, lease_id: &str, _until: Instant) -> Result<(), String> {
            self.0.borrow_mut().push(format!("grant {lease_id}"));
            Ok(())
        }
        fn revoke(&mut self) -> Result<(), String> {
            self.0.borrow_mut().push("revoke".into());
            Ok(())
        }
        fn release_all(&mut self) -> Result<(), String> {
            self.0.borrow_mut().push("release".into());
            Ok(())
        }
    }

    fn controller() -> (Controller<Recorder>, Recorder) {
        let recorder = Recorder::default();
        (Controller::new(Some(recorder.clone())), recorder)
    }

    fn grant(id: &str, ms: u64) -> Command {
        Command::Grant {
            lease_id: id.into(),
            grant_ms: ms,
        }
    }

    fn revoke(id: &str, reason: RevokeReason) -> Command {
        Command::Revoke {
            lease_id: id.into(),
            reason,
        }
    }

    fn ack(id: &str, state: AckState) -> Effect {
        Effect::Emit(Event::ControlAck {
            lease_id: id.into(),
            state,
        })
    }

    #[test]
    fn grant_renewal_and_expiry() {
        let (mut c, sink) = controller();
        let t0 = Instant::now();
        c.on_command(
            &Command::Attention {
                message: "help".into(),
            },
            Mode::Expanded,
            t0,
        );
        assert_eq!(c.take(t0), Some(Event::TakeRequested));
        assert_eq!(c.take(t0), None, "one request at a time");

        let effects = c.on_command(&grant("L1", 10_000), Mode::Expanded, t0);
        assert_eq!(effects, vec![ack("L1", AckState::Granted)]);
        assert_eq!(sink.take(), vec!["grant L1"]);
        assert!(c.controlling() && c.forwarding(Mode::Expanded));
        assert!(c.forwarding(Mode::Fullscreen) && !c.forwarding(Mode::Thumbnail));
        assert_eq!(c.attention(), None, "a grant clears the banner");
        assert!(!c.can_take());
        assert_eq!(c.take(t0), None, "no request while a grant is live");
        assert_eq!(c.deadline(), Some(t0 + Duration::from_secs(10)));

        // A renewal extends the grant.
        let t1 = t0 + Duration::from_secs(5);
        assert!(!c.tick(t1));
        c.on_command(&grant("L1", 10_000), Mode::Expanded, t1);
        assert_eq!(sink.take(), vec!["grant L1"]);
        assert!(!c.tick(t0 + Duration::from_secs(12)));
        assert!(c.controlling());

        // Without another renewal the grant expires and input is released.
        let t2 = t1 + Duration::from_secs(10);
        assert!(c.tick(t2));
        assert!(!c.controlling());
        assert_eq!(sink.take(), vec!["revoke"]);
        assert_eq!(c.note(), Some(Note::Ended));
        assert!(c.can_take());
        assert!(c.tick(t2 + NOTE_FOR));
        assert_eq!(c.note(), None);
        assert_eq!(c.deadline(), None);
    }

    #[test]
    fn revoke_releases_before_ack() {
        let (mut c, sink) = controller();
        let now = Instant::now();
        c.on_command(&grant("L1", 10_000), Mode::Expanded, now);
        sink.take();
        for (reason, note) in [
            (RevokeReason::Returned, None),
            (RevokeReason::LeaseLost, Some(Note::Ended)),
            (RevokeReason::SessionEnded, None),
            (RevokeReason::Stopping, None),
            (RevokeReason::Other, None),
        ] {
            c.on_command(&grant("L1", 10_000), Mode::Expanded, now);
            sink.take();
            let effects = c.on_command(&revoke("L1", reason), Mode::Expanded, now);
            assert_eq!(sink.take(), vec!["revoke"], "{reason:?}");
            assert_eq!(effects, vec![ack("L1", AckState::Revoked)]);
            assert!(!c.controlling());
            assert_eq!(c.note(), note, "{reason:?}");
        }
        // A revoke without a grant still releases and acks.
        let effects = c.on_command(&revoke("L9", RevokeReason::Returned), Mode::Expanded, now);
        assert_eq!(sink.take(), vec!["revoke"]);
        assert_eq!(effects, vec![ack("L9", AckState::Revoked)]);
    }

    #[test]
    fn unavailable_answers_a_take_request() {
        let (mut c, sink) = controller();
        let now = Instant::now();
        assert_eq!(c.take(now), Some(Event::TakeRequested));
        let effects = c.on_command(&revoke("", RevokeReason::Unavailable), Mode::Expanded, now);
        assert_eq!(effects, vec![ack("", AckState::Revoked)]);
        assert_eq!(sink.take(), vec!["revoke"]);
        assert_eq!(c.note(), Some(Note::Unavailable));
        assert_eq!(Note::Unavailable.text(), "Control unavailable");
        assert_eq!(Note::Ended.text(), "Control ended");
        assert_eq!(c.take(now), Some(Event::TakeRequested), "may ask again");
    }

    #[test]
    fn paste_notes_show_for_a_while() {
        let (mut c, _sink) = controller();
        let now = Instant::now();
        assert_eq!(c.lease_id(), None);
        c.on_command(&grant("L1", 10_000), Mode::Expanded, now);
        assert_eq!(c.lease_id(), Some("L1"));
        c.show(Note::PasteTooLong, now);
        c.on_command(&grant("L1", 10_000), Mode::Expanded, now);
        assert_eq!(c.note(), Some(Note::PasteTooLong), "a renewal keeps it");
        assert_eq!(c.deadline(), Some(now + NOTE_FOR));
        assert!(c.tick(now + NOTE_FOR));
        assert_eq!(c.note(), None);
        assert!(c.controlling(), "a note leaves control alone");
        assert_eq!(Note::NothingToPaste.text(), "Nothing to paste");
        assert_eq!(Note::PasteTooLong.text(), "Too long to paste");
        assert_eq!(Note::PasteUnavailable.text(), "Paste unavailable");
    }

    #[test]
    fn return_and_close_release_before_reporting() {
        let (mut c, sink) = controller();
        let now = Instant::now();
        assert_eq!(c.give_back(), None);
        c.on_command(&grant("L1", 10_000), Mode::Expanded, now);
        sink.take();
        assert_eq!(
            c.give_back(),
            Some(Event::ReturnRequested {
                reason: ReturnReason::Button
            })
        );
        assert_eq!(sink.take(), vec!["revoke"]);
        assert!(!c.controlling());

        c.on_command(&grant("L1", 10_000), Mode::Fullscreen, now);
        sink.take();
        assert_eq!(
            c.close(),
            vec![
                Event::ReturnRequested {
                    reason: ReturnReason::Closed
                },
                Event::Closed
            ]
        );
        assert_eq!(sink.take(), vec!["revoke"]);
        assert_eq!(c.close(), vec![Event::Closed], "watch mode only closes");
    }

    #[test]
    fn thumbnail_grant_expands() {
        let (mut c, _sink) = controller();
        let effects = c.on_command(&grant("L1", 10_000), Mode::Thumbnail, Instant::now());
        assert_eq!(effects, vec![ack("L1", AckState::Granted), Effect::Expand]);
        assert!(c.controlling() && !c.forwarding(Mode::Thumbnail));
    }

    #[test]
    fn focus_loss_keeps_control_and_session_end_stops_it() {
        let (mut c, sink) = controller();
        let now = Instant::now();
        c.on_command(&grant("L1", 10_000), Mode::Expanded, now);
        sink.take();
        c.release_held();
        assert_eq!(sink.take(), vec!["release"]);
        assert!(c.controlling());

        c.end_session();
        assert_eq!(sink.take(), vec!["revoke"]);
        assert!(!c.controlling() && !c.can_take());
        assert_eq!(c.take(now), None);
        assert!(c
            .on_command(&grant("L1", 10_000), Mode::Expanded, now)
            .is_empty());
        assert!(!c.controlling(), "no grant after the session ended");
    }

    #[test]
    fn without_a_sink_control_is_never_taken() {
        let mut c: Controller<Recorder> = Controller::new(None);
        let now = Instant::now();
        assert!(!c.can_take());
        assert_eq!(c.take(now), None);
        assert!(c
            .on_command(&grant("L1", 10_000), Mode::Expanded, now)
            .is_empty());
        assert!(!c.controlling());
    }

    #[test]
    fn a_pending_take_request_expires() {
        let (mut c, _sink) = controller();
        let now = Instant::now();
        assert!(c.take(now).is_some());
        assert!(c.take(now + TAKE_PENDING_FOR / 2).is_none());
        c.tick(now + TAKE_PENDING_FOR);
        assert!(c.take(now + TAKE_PENDING_FOR).is_some());
    }
}
