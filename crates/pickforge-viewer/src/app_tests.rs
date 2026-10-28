use super::*;

fn app() -> App {
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
            label: None,
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
fn thumbnail_keeps_the_session_label_above_an_attention_banner() {
    let mut app = app();
    app.config.label = Some("desk-1a2b3c \u{b7} my-app".into());
    app.size = PhysicalSize::new(384, 240);
    let message = "Please sign in to continue".to_string();
    app.controller
        .on_command(&Command::Attention { message }, app.mode, Instant::now());
    app.relayout();
    let (pill, shown) = app.label_pill.clone().expect("label");
    let banner = app.banner.clone().expect("banner");
    assert_eq!(shown, "desk-1a2b3c \u{b7} my-app");
    assert!(banner.rect.y >= pill.bottom(), "{banner:?} {pill:?}");
}
