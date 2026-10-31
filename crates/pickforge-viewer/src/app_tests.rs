use super::*;
use crate::control;
use crate::pulse;

fn app() -> App {
    app_with(None, None)
}

fn app_with(label: Option<&str>, title: Option<&str>) -> App {
    App::new(
        Config {
            display: 1,
            xvfb_pid: 1,
            xvfb_start_ticks: 1,
            width: 100,
            height: 100,
            class: "test".into(),
            thumbnail_width: 100,
            placement: Placement::SelfPlaced,
            label: label.map(Into::into),
            title: title.map(Into::into),
        },
        (100, 100),
        Arc::new(Mutex::new(Shared::new(100, 100))),
        Control::new().unwrap(),
        Arc::new(AtomicBool::new(false)),
        None,
    )
}

#[test]
fn same_geometry_cursor_updates_damage_old_and_new_rows() {
    let mut app = app();
    app.size = PhysicalSize::new(100, 100);
    app.image = Rect::new(0, 0, 100, 100);
    app.cursor_drawn = Some(Rect::new(20, 30, 10, 10));
    let cursor = Arc::new(CursorImage {
        width: 10,
        height: 10,
        xhot: 0,
        yhot: 0,
        serial: 2,
        pixels: vec![0xffffffff; 100],
    });
    app.cursor = Some(cursor.clone());
    app.cursor_pos = (20, 30);
    {
        let mut shared = app.shared.lock().unwrap();
        shared.cursor = Some(cursor);
        shared.cursor_pos = (20, 30);
        shared.cursor_changed = true;
    }
    app.on_capture();
    assert_eq!(app.damage.take(), Some((30, 40)));

    app.shared.lock().unwrap().cursor_pos = (20, 50);
    app.shared.lock().unwrap().cursor_changed = true;
    app.on_capture();
    assert_eq!(app.damage.take(), Some((30, 60)));

    app.shared.lock().unwrap().cursor = None;
    app.shared.lock().unwrap().cursor_changed = true;
    app.on_capture();
    assert_eq!(app.damage, Some((30, 40)));
}

#[test]
fn x11_pause_refresh_observes_unmap_and_iconic_state_without_resize() {
    use crate::test_common::{xvfb_ready, Painter, Xvfb};
    use x11rb::protocol::xproto::PropMode;
    use x11rb::wrapper::ConnectionExt as _;
    if !xvfb_ready("x11_pause_refresh") {
        return;
    }
    let display = Xvfb::start("640x480x24");
    let painter = Painter::new(display.display, 0, 0, 100, 100, 0);
    let conn = crate::capture::connect_display(display.display).unwrap();
    let mut app = app();
    app.size = PhysicalSize::new(100, 100);
    app.x11_visibility = X11Visibility::new(conn, painter.window);
    let mut now = Instant::now();
    app.refresh_x11_pause(now);
    assert!(!app.control.is_paused());
    painter.conn.unmap_window(painter.window).unwrap();
    painter.sync();
    now += X11_PAUSE_INTERVAL;
    app.refresh_x11_pause(now);
    assert!(app.control.is_paused());
    painter.conn.map_window(painter.window).unwrap();
    painter.sync();
    now += X11_PAUSE_INTERVAL;
    app.refresh_x11_pause(now);
    assert!(!app.control.is_paused());
    let wm_state = app.x11_visibility.as_ref().unwrap().wm_state;
    painter
        .conn
        .change_property32(
            PropMode::REPLACE,
            painter.window,
            wm_state,
            wm_state,
            &[3, 0],
        )
        .unwrap();
    painter.sync();
    now += X11_PAUSE_INTERVAL;
    app.refresh_x11_pause(now);
    assert!(app.control.is_paused());
    painter
        .conn
        .delete_property(painter.window, wm_state)
        .unwrap();
    painter.sync();
    now += X11_PAUSE_INTERVAL;
    app.refresh_x11_pause(now);
    assert!(!app.control.is_paused());
}

#[test]
fn thumbnail_keeps_the_title_strip_above_an_attention_banner() {
    let mut app = app();
    app.config.label = Some("desk-1a2b3c \u{b7} my-app".into());
    app.size = PhysicalSize::new(384, 240);
    let message = "Please sign in to continue".to_string();
    app.controller
        .on_command(&Command::Attention { message }, app.mode, Instant::now());
    app.relayout();
    let strip = app.strip.clone().expect("strip");
    let banner = app.banner.clone().expect("banner");
    assert_eq!(strip.pieces[0].text, "desk-1a2b3c \u{b7} my-app");
    assert_eq!(strip.rect, Rect::new(0, 0, 384, 32));
    assert!(banner.rect.y >= strip.rect.bottom(), "{banner:?} {strip:?}");
}

fn shown(pieces: &[ui::Piece]) -> Vec<&str> {
    pieces.iter().map(|p| p.text.as_str()).collect()
}

#[test]
fn set_title_shows_the_title_and_falls_back_to_the_label() {
    let mut app = app_with(Some("desk-1a2b3c \u{b7} my-app"), Some("Checkout flow"));
    app.size = PhysicalSize::new(384, 240);
    app.relayout();
    assert_eq!(app.title.as_deref(), Some("Checkout flow"));
    assert_eq!(
        app.window_title(),
        "Checkout flow \u{b7} desk-1a2b3c \u{b7} my-app \u{b7} Pickforge viewer"
    );
    assert_eq!(
        shown(&app.strip.as_ref().unwrap().pieces),
        ["Checkout flow", "desk-1a2b3c"]
    );

    app.damage = None;
    app.on_command(Command::SetTitle {
        title: Some("YouTube channel analytics".into()),
    });
    assert_eq!(
        shown(&app.strip.as_ref().unwrap().pieces),
        ["YouTube channel analytics", "desk-1a2b3c"]
    );
    assert_eq!(app.damage, Some((0, 240)), "redraws");

    app.on_command(Command::SetTitle { title: None });
    assert_eq!(app.title, None);
    assert_eq!(
        app.window_title(),
        "desk-1a2b3c \u{b7} my-app \u{b7} Pickforge viewer"
    );
    assert_eq!(
        shown(&app.strip.as_ref().unwrap().pieces),
        ["desk-1a2b3c \u{b7} my-app"]
    );

    // The expanded bar shows the same heading.
    app.mode = Mode::Expanded;
    app.on_command(Command::SetTitle {
        title: Some("Checkout flow".into()),
    });
    assert!(app.strip.is_none());
    assert_eq!(
        shown(&app.bar.as_ref().unwrap().caption),
        ["Checkout flow", " \u{b7} desk-1a2b3c"]
    );
}

#[test]
fn hover_starts_only_after_motion_away_from_the_entry_point() {
    let mut app = app();
    // A card that folds under a still pointer gets an entry and a motion there.
    app.entering = true;
    assert_eq!(app.pointer_motion((10.0, 10.0)), None);
    assert_eq!(app.pointer_motion((10.0, 10.0)), None, "still pointer");
    assert_eq!(
        app.pointer_motion((11.0, 10.0)),
        Some(Event::Hover { inside: true })
    );
    assert_eq!(app.pointer_motion((12.0, 10.0)), None, "no repeat");
    // Without an entry, as when the pointer was inside at launch, motion hovers.
    let mut app = self::app();
    assert_eq!(
        app.pointer_motion((5.0, 5.0)),
        Some(Event::Hover { inside: true })
    );
}

#[test]
fn hover_reports_thumbnail_changes_once() {
    let mut app = app();
    assert_eq!(app.mode, Mode::Thumbnail);
    assert_eq!(app.hover_change(false), None, "not hovering yet");
    assert_eq!(app.hover_change(true), Some(Event::Hover { inside: true }));
    assert_eq!(app.hover_change(true), None, "no repeat");
    assert_eq!(
        app.hover_change(false),
        Some(Event::Hover { inside: false })
    );
    assert_eq!(app.hover_change(false), None, "no repeat");

    // Leaving the thumbnail ends the hover.
    assert!(app.hover_change(true).is_some());
    app.mode = Mode::Expanded;
    assert_eq!(
        app.hover_change(false),
        Some(Event::Hover { inside: false })
    );
    // Outside the thumbnail nothing hovers.
    assert_eq!(app.hover_change(true), None);
    app.mode = Mode::Fullscreen;
    assert_eq!(app.hover_change(true), None);
    assert!(!app.hovering);
    // Hover never touches control or the click path.
    assert!(!app.controller.controlling());
    assert!(!app.thumb_press);
    assert_eq!(app.pressed, None);
}

#[test]
fn pulse_damages_only_its_rows_and_draws_inside_the_image() {
    let mut app = app();
    app.size = PhysicalSize::new(100, 132);
    app.relayout();
    app.image = Rect::new(0, 32, 100, 100);
    app.canvas = vec![palette::SURFACE; 100 * 132];
    app.scaled = vec![0x0010_2030; 100 * 100];
    app.damage = None;
    let start = Instant::now();
    app.start_pulse(50, 50, start);
    let (y0, y1) = app.damage.take().expect("pulse damage");
    assert!(
        (32..=62).contains(&y0) && y1 >= 103 && y1 - y0 <= 46,
        "{y0}..{y1}"
    );

    app.compose(0, 132, None);
    // The ring starts at a 4 pixel radius around the pixel center (50.5, 82.5).
    let ember = app.canvas[82 * 100 + 53];
    assert!((ember >> 16) & 0xff > 0xc0, "{ember:06x}");
    assert_eq!(app.canvas[82 * 100 + 50], 0x0010_2030);
    assert_eq!(app.canvas[40 * 100 + 10], 0x0010_2030);

    // Frames are paced, and the end clears the ring with one last damage.
    assert_eq!(app.tick_pulse(start), Some(start + pulse::FRAME));
    app.damage = None;
    assert_eq!(
        app.tick_pulse(start + pulse::FRAME / 2),
        Some(start + pulse::FRAME)
    );
    assert_eq!(app.damage, None);
    assert_eq!(app.tick_pulse(start + pulse::DURATION), None);
    assert_eq!(app.damage, Some((y0, y1)));
    assert!(app.pulse.is_none());
}

#[test]
fn pulse_moves_a_point_past_the_edge_and_ignores_ended_sessions() {
    let mut app = app();
    app.size = PhysicalSize::new(100, 100);
    app.image = Rect::new(0, 0, 100, 100);
    let now = Instant::now();
    app.start_pulse(100, 5, now);
    let ring = app
        .pulse
        .as_ref()
        .unwrap()
        .ring(app.image, app.session, 1.0, now);
    assert_eq!(ring.unwrap().center, (99.5, 5.5));
    app.pulse = None;
    app.damage = None;
    app.ended = true;
    app.start_pulse(5, 5, Instant::now());
    assert!(app.pulse.is_none() && app.damage.is_none());
}

/// A focused window on a test display that counts key presses.
struct KeyCounter {
    conn: RustConnection,
    presses: usize,
}

impl KeyCounter {
    fn new(display: u32) -> KeyCounter {
        use x11rb::connection::Connection;
        use x11rb::protocol::xproto::{CreateWindowAux, EventMask, InputFocus, WindowClass};
        let conn = crate::capture::connect_display(display).unwrap();
        let root = conn.setup().roots[0].root;
        let window = conn.generate_id().unwrap();
        conn.create_window(
            0,
            window,
            root,
            0,
            0,
            100,
            100,
            0,
            WindowClass::INPUT_OUTPUT,
            0,
            &CreateWindowAux::new()
                .override_redirect(1)
                .event_mask(EventMask::KEY_PRESS),
        )
        .unwrap();
        conn.map_window(window).unwrap();
        conn.set_input_focus(InputFocus::PARENT, window, x11rb::CURRENT_TIME)
            .unwrap();
        conn.get_input_focus().unwrap().reply().unwrap();
        KeyCounter { conn, presses: 0 }
    }

    /// Key presses so far, once the server handled the injector's input.
    fn count(&mut self, injector_sync: &mut App) -> usize {
        use x11rb::connection::Connection;
        if let Some(injector) = injector_sync.controller.sink_mut() {
            let _ = injector.is_granted();
        }
        std::thread::sleep(Duration::from_millis(100));
        self.conn.get_input_focus().unwrap().reply().unwrap();
        while let Some(event) = self.conn.poll_for_event().unwrap() {
            if let x11rb::protocol::Event::KeyPress(_) = event {
                self.presses += 1;
            }
        }
        self.presses
    }
}

fn grant(lease: &str) -> Command {
    Command::Grant {
        lease_id: lease.into(),
        grant_ms: 60_000,
    }
}

/// An expanded app that controls a test display through a real injector.
fn controlling(display: u32) -> App {
    let mut app = app();
    app.controller = Controller::new(Some(Injector::connect(display).unwrap()));
    app.mode = Mode::Expanded;
    app.status = None;
    app.on_command(grant("L1"));
    assert!(app.controller.controlling());
    app
}

fn reading(app: &mut App, id: u64, lease: &str) {
    app.paste = Some(Paste::Reading {
        id,
        lease: lease.into(),
        until: Instant::now() + PASTE_READ_LIMIT,
    });
}

fn typed_at(app: &App) -> Option<usize> {
    match &app.paste {
        Some(Paste::Typing { at, .. }) => Some(*at),
        _ => None,
    }
}

#[test]
fn paste_types_in_steps_and_stops_at_a_revoke() {
    use crate::protocol::RevokeReason;
    use crate::test_common::{xvfb_ready, Xvfb};
    if !xvfb_ready("paste_steps") {
        return;
    }
    let display = Xvfb::start("640x480x24");
    let mut keys = KeyCounter::new(display.display);
    let mut app = controlling(display.display);

    // A late answer to an older read changes nothing.
    reading(&mut app, 2, "L1");
    app.on_clipboard(1, clipboard::prepare("x"));
    assert!(matches!(app.paste, Some(Paste::Reading { id: 2, .. })));

    app.on_clipboard(2, clipboard::prepare(&"a".repeat(100)));
    assert_eq!(typed_at(&app), Some(PASTE_STEP));
    app.paste_step();
    assert_eq!(typed_at(&app), Some(2 * PASTE_STEP));
    assert_eq!(keys.count(&mut app), 2 * PASTE_STEP);

    app.on_command(Command::Revoke {
        lease_id: "L1".into(),
        reason: RevokeReason::LeaseLost,
    });
    assert!(app.paste.is_none(), "a revoke stops the paste");
    app.paste_step();
    assert_eq!(
        keys.count(&mut app),
        2 * PASTE_STEP,
        "nothing after the revoke"
    );
    let held: Vec<u8> = app.controller.sink_mut().unwrap().held_keys().collect();
    assert!(held.is_empty(), "{held:?}");
}

#[test]
fn paste_stops_on_collapse_new_lease_and_late_reads() {
    use crate::test_common::{xvfb_ready, Xvfb};
    if !xvfb_ready("paste_stops") {
        return;
    }
    let display = Xvfb::start("640x480x24");
    let mut keys = KeyCounter::new(display.display);
    let mut app = controlling(display.display);

    // A thumbnail forwards nothing, so the next step ends the paste.
    app.on_clipboard(0, clipboard::prepare("x"));
    reading(&mut app, 1, "L1");
    app.on_clipboard(1, clipboard::prepare(&"b".repeat(100)));
    app.mode = Mode::Thumbnail;
    app.paste_step();
    assert!(app.paste.is_none());
    app.mode = Mode::Expanded;

    // A grant for another lease ends a paste of the old one.
    reading(&mut app, 2, "L1");
    app.on_clipboard(2, clipboard::prepare(&"c".repeat(100)));
    app.on_command(grant("L2"));
    assert!(app.paste.is_none());

    // A read that finishes after its lease ended types nothing.
    reading(&mut app, 3, "L1");
    app.on_clipboard(3, clipboard::prepare("late"));
    assert!(app.paste.is_none());
    assert_eq!(app.controller.note(), None, "no note for a stale read");
    assert_eq!(keys.count(&mut app), 2 * PASTE_STEP);
}

#[test]
fn refused_reads_show_a_note_and_type_nothing() {
    use crate::test_common::{xvfb_ready, Xvfb};
    if !xvfb_ready("paste_refusals") {
        return;
    }
    let display = Xvfb::start("640x480x24");
    let mut keys = KeyCounter::new(display.display);
    let mut app = controlling(display.display);
    for (refusal, note) in [
        (Refusal::Empty, Note::NothingToPaste),
        (Refusal::TooLong, Note::PasteTooLong),
        (Refusal::Unavailable, Note::PasteUnavailable),
    ] {
        reading(&mut app, 1, "L1");
        app.on_clipboard(1, Err(refusal));
        assert!(app.paste.is_none());
        assert_eq!(app.status_text(), Some(note.text()));
    }

    // More new characters than the binding limit are refused before any
    // of them is typed.
    let many: String = (0..=input::MAX_BINDINGS as u32)
        .filter_map(|i| char::from_u32(0x4e00 + i))
        .collect();
    reading(&mut app, 2, "L1");
    app.on_clipboard(2, clipboard::prepare(&format!("ok{many}")));
    assert!(app.paste.is_none());
    assert_eq!(app.status_text(), Some("Paste unavailable"));
    assert_eq!(keys.count(&mut app), 0);

    // A read without an answer is given up.
    let now = Instant::now();
    app.paste = Some(Paste::Reading {
        id: 3,
        lease: "L1".into(),
        until: now,
    });
    app.controller
        .show(Note::PasteTooLong, now - control::NOTE_FOR);
    app.controller.tick(now);
    assert_eq!(app.check_paste_read(now), None);
    assert!(app.paste.is_none());
    assert_eq!(app.status_text(), Some("Paste unavailable"));
}

#[test]
fn paste_reads_only_under_a_live_grant_and_one_read_at_a_time() {
    use crate::test_common::{xvfb_ready, Xvfb};
    if !xvfb_ready("paste_live_grant") {
        return;
    }
    let display = Xvfb::start("640x480x24");
    let mut app = controlling(display.display);
    assert_eq!(app.paste_lease().as_deref(), Some("L1"));

    // A read that never answered keeps its thread, and no second read starts.
    app.paste_worker = Some(thread::spawn(|| thread::sleep(Duration::from_millis(500))));
    app.start_paste();
    assert!(app.paste.is_none());
    assert_eq!(app.status_text(), Some("Paste unavailable"));

    // A grant that expired before the loop turn is applied first.
    app.on_command(Command::Grant {
        lease_id: "L1".into(),
        grant_ms: 1,
    });
    thread::sleep(Duration::from_millis(20));
    assert!(app.controller.controlling(), "expiry not applied yet");
    assert_eq!(app.paste_lease(), None);
    assert!(!app.controller.controlling());
}

#[test]
fn stopping_a_paste_stops_its_read() {
    use crate::protocol::RevokeReason;
    use crate::test_common::{xvfb_ready, Xvfb};
    if !xvfb_ready("paste_stop_read") {
        return;
    }
    let display = Xvfb::start("640x480x24");
    let mut app = controlling(display.display);
    let stop = Arc::new(PasteStop::default());
    app.paste_stop = Arc::clone(&stop);
    reading(&mut app, 1, "L1");
    app.on_command(Command::Revoke {
        lease_id: "L1".into(),
        reason: RevokeReason::LeaseLost,
    });
    assert!(app.paste.is_none());
    assert!(stop.is_stopped(), "the read asks for no more content");
}

#[test]
fn paste_needs_control_in_an_expanded_window() {
    let mut app = app();
    app.start_paste();
    assert!(app.paste.is_none(), "no control, no read");
    app.mode = Mode::Expanded;
    app.start_paste();
    assert!(app.paste.is_none());
}
