//! Windowed smoke tests through the real binary, on two Xvfb servers.

#![cfg(target_os = "linux")]

mod common;
#[path = "common/viewer.rs"]
mod viewer;

use common::{near, wait_until, xvfb_ready, Painter, Xvfb};
use pickforge_viewer::capture::Frame;
use pickforge_viewer::fallback::Fallback;
use std::thread;
use std::time::{Duration, Instant};
use viewer::*;

#[test]
fn watches_a_session_then_shows_session_end() {
    if !xvfb_ready("watches_a_session") {
        return;
    }
    let mut session = Xvfb::start("640x480x24");
    let host = Xvfb::start("1280x1024x24");
    let painter = paint_session(&session);
    let class = "pickforge-viewer-smoke";
    let mut viewer = Viewer::spawn(&session, host.display, class, "self", "1");

    let ready = viewer.expect("ready");
    assert_eq!(ready["backend"], "x11");
    assert_eq!(ready["pid"], viewer.child.id());
    assert_eq!(ready["scale"], 1.0);
    assert_eq!(ready["version"], env!("CARGO_PKG_VERSION"));

    let mut screen = Screen::new(host.display);
    let thumb = screen.wait_size(class, 384, 288);
    let shot = screen.shot();
    assert_near(&shot, thumb, 300, 60, BLUE, "top half");
    assert_near(&shot, thumb, 300, 230, YELLOW, "bottom half");
    assert_near(&shot, thumb, 48, 48, WHITE, "white square");
    save(&shot, thumb, "thumbnail.png");

    // Drawing in the session reaches the window.
    painter.fill(400, 300, 100, 100, RED);
    assert!(
        wait_until(WAIT, || near(at(&screen.shot(), thumb, 270, 210), RED, 12)),
        "live update"
    );

    // A click expands the window to the session size plus the bar.
    screen.click(thumb.x + 300, thumb.y + 100);
    assert_eq!(viewer.expect("mode")["mode"], "expanded");
    let expanded = screen.wait_size(class, 640, 512);
    let shot = screen.wait_color(expanded, 4, 4, BAR);
    assert_near(&shot, expanded, 320, 32 + 100, BLUE, "image below the bar");
    assert_near(&shot, expanded, 450, 32 + 350, RED, "live content");

    // Hovering a button changes its look.
    let close = (expanded.w - 4 - 12, 16);
    let plain = at(&shot, expanded, close.0 - 9, close.1);
    screen.move_to(expanded.x + close.0 as i32, expanded.y + close.1 as i32);
    assert!(
        wait_until(WAIT, || at(&screen.shot(), expanded, close.0 - 9, close.1)
            != plain),
        "hover state"
    );
    save(&screen.shot(), expanded, "expanded.png");
    screen.move_to(expanded.x + 300, expanded.y + 200);

    // The session ends: the last frame stays and the status shows it.
    let pill = (24, 512 - 20);
    assert_near(
        &screen.shot(),
        expanded,
        pill.0,
        pill.1,
        YELLOW,
        "before the status",
    );
    session.stop();
    assert_eq!(viewer.expect("sessionEnded")["reason"], "x11-eof");
    assert!(
        wait_until(WAIT, || !near(
            at(&screen.shot(), expanded, pill.0, pill.1),
            YELLOW,
            40
        )),
        "status pill"
    );
    let shot = screen.shot();
    assert_near(&shot, expanded, 320, 32 + 100, BLUE, "last frame kept");
    save(&shot, expanded, "session-ended.png");

    // End of file on stdin exits within one second.
    let start = Instant::now();
    drop(viewer.stdin.take());
    assert_eq!(viewer.wait_exit(Duration::from_secs(3)), Some(0));
    let took = start.elapsed();
    assert!(took < Duration::from_secs(1), "exit took {took:?}");
}

#[test]
fn host_placement_asks_before_resizing() {
    if !xvfb_ready("host_placement") {
        return;
    }
    let session = Xvfb::start("640x480x24");
    let host = Xvfb::start("1280x1024x24");
    let _painter = paint_session(&session);
    let class = "pickforge-viewer-host";
    let mut viewer = Viewer::spawn(&session, host.display, class, "host", "1");
    viewer.expect("ready");
    let screen = Screen::new(host.display);
    let thumb = screen.wait_size(class, 384, 288);

    screen.click(thumb.x + 200, thumb.y + 100);
    viewer.expect("expandRequested");
    viewer.expect_quiet(Duration::from_millis(300));
    assert_eq!(screen.find(class).map(|p| (p.w, p.h)), Some((384, 288)));

    viewer.send(r#"{"cmd":"setMode","mode":"expanded","width":500,"height":407,"note":"extra"}"#);
    assert_eq!(viewer.expect("mode")["mode"], "expanded");
    let expanded = screen.wait_size(class, 500, 407);

    // Unknown and malformed lines are ignored.
    viewer.send(r#"{"cmd":"later","message":"later"}"#);
    viewer.send("not json");
    viewer.send(r#"{"cmd":"status","code":"stopping"}"#);

    // Esc collapses in watch mode.
    screen.focus(expanded);
    thread::sleep(Duration::from_millis(100));
    screen.press_escape();
    viewer.expect("collapseRequested");

    viewer.send(r#"{"cmd":"setMode","mode":"thumbnail"}"#);
    assert_eq!(viewer.expect("mode")["mode"], "thumbnail");
    screen.wait_size(class, 384, 288);

    viewer.send(r#"{"cmd":"shutdown"}"#);
    assert_eq!(viewer.wait_exit(Duration::from_secs(3)), Some(0));
}

#[test]
fn close_button_reports_closed_and_exits() {
    if !xvfb_ready("close_button") {
        return;
    }
    let session = Xvfb::start("640x480x24");
    let host = Xvfb::start("1280x1024x24");
    let _painter = paint_session(&session);
    let class = "pickforge-viewer-close";
    let mut viewer = Viewer::spawn(&session, host.display, class, "self", "1");
    viewer.expect("ready");
    let screen = Screen::new(host.display);
    let thumb = screen.wait_size(class, 384, 288);
    screen.click(thumb.x + 200, thumb.y + 100);
    viewer.expect("mode");
    let expanded = screen.wait_size(class, 640, 512);
    screen.click(expanded.x + 640 - 4 - 12, expanded.y + 16);
    viewer.expect("closed");
    assert_eq!(viewer.wait_exit(Duration::from_secs(3)), Some(0));
}

#[test]
fn scales_with_the_host_scale_factor() {
    if !xvfb_ready("hidpi") {
        return;
    }
    let session = Xvfb::start("640x480x24");
    let host = Xvfb::start("2560x1600x24");
    let _painter = paint_session(&session);
    let class = "pickforge-viewer-hidpi";
    let viewer = Viewer::spawn(&session, host.display, class, "self", "2");
    assert_eq!(viewer.expect("ready")["scale"], 2.0);
    let mut screen = Screen::new(host.display);
    let thumb = screen.wait_size(class, 768, 576);
    save(&screen.shot(), thumb, "thumbnail-2x.png");
    screen.click(thumb.x + 600, thumb.y + 200);
    viewer.expect("mode");
    let expanded = screen.wait_size(class, 1280, 1024);
    let shot = screen.wait_color(expanded, 8, 8, BAR);
    assert_eq!(at(&shot, expanded, 8, 60), BAR, "bar is 64 px");
    assert_near(&shot, expanded, 8, 66, BLUE, "image starts below the bar");
    assert_near(&shot, expanded, 640, 64 + 200, BLUE, "upscaled image");
    save(&shot, expanded, "expanded-2x.png");
}

/// Bright text pixels in a `w` by `h` area at `(x, y)` of the window.
fn ink(frame: &Frame, window: Placed, x: u32, y: u32, w: u32, h: u32) -> usize {
    ink_over(frame, window, (x, y, w, h), 160)
}

/// Pixels in an area whose every channel is over `floor`.
fn ink_over(frame: &Frame, window: Placed, area: (u32, u32, u32, u32), floor: u32) -> usize {
    let (x, y, w, h) = area;
    let mut count = 0;
    for py in y..y + h {
        for px in x..x + w {
            let p = at(frame, window, px, py);
            let low = [p >> 16, p >> 8, p].map(|c| c & 0xff).into_iter().min();
            if low.unwrap_or(0) > floor {
                count += 1;
            }
        }
    }
    count
}

/// The muted session id is grey, between the dark strip and bright text.
const MUTED_FLOOR: u32 = 64;

#[test]
fn shows_the_title_and_reports_hover() {
    if !xvfb_ready("title_and_hover") {
        return;
    }
    let session = Xvfb::start("640x480x24");
    let host = Xvfb::start("1280x1024x24");
    // A plain session, so only text is bright.
    let _painter = Painter::new(session.display, 0, 0, 640, 480, BLUE);
    let class = "pickforge-viewer-title";
    let label = "desk-1a2b3c \u{b7} my-app";
    let mut viewer = Viewer::spawn_with(
        &session,
        host.display,
        class,
        "self",
        "1",
        &["--label", label, "--title", "Checkout flow"],
    );
    viewer.expect("ready");
    let mut screen = Screen::new(host.display);
    let thumb = screen.wait_size(class, 384, 288);
    assert_eq!(
        screen.title(thumb),
        "Checkout flow \u{b7} desk-1a2b3c \u{b7} my-app \u{b7} Pickforge viewer"
    );

    // The strip: dark over the image, the title left, the muted id right.
    let mut shot = screen.shot();
    let drawn = wait_until(WAIT, || {
        shot = screen.shot();
        ink(&shot, thumb, 8, 0, 120, 32) > INK
    });
    assert!(drawn, "title ink");
    let dark = at(&shot, thumb, 200, 4);
    assert!(
        [dark >> 16, dark >> 8, dark]
            .iter()
            .all(|c| c & 0xff < 0x30),
        "strip {dark:06x}"
    );
    assert_near(&shot, thumb, 200, 40, BLUE, "image below the strip");
    let id = ink_over(&shot, thumb, (280, 0, 100, 32), MUTED_FLOOR);
    assert!(id > INK, "id ink {id}");
    assert_eq!(ink(&shot, thumb, 280, 0, 100, 32), 0, "the id is muted");
    save(&shot, thumb, "title-strip.png");

    // setTitle changes the window title and the strip.
    viewer.send(r#"{"cmd":"setTitle","title":"YouTube channel analytics, a much longer title"}"#);
    let mut title = String::new();
    assert!(
        wait_until(WAIT, || {
            title = screen.title(thumb);
            title.starts_with("YouTube channel analytics")
        }),
        "window title {title:?}"
    );
    let wide = wait_until(WAIT, || ink(&screen.shot(), thumb, 160, 0, 80, 32) > INK);
    assert!(wide, "longer title ink");
    save(&screen.shot(), thumb, "title-strip-long.png");
    viewer.send(r#"{"cmd":"setTitle","title":""}"#);
    assert!(
        wait_until(WAIT, || screen.title(thumb)
            == "desk-1a2b3c \u{b7} my-app \u{b7} Pickforge viewer"),
        "label alone"
    );
    let gone = wait_until(WAIT, || {
        ink_over(&screen.shot(), thumb, (280, 0, 100, 32), MUTED_FLOOR) == 0
    });
    assert!(gone, "no id at the right without a title");
    save(&screen.shot(), thumb, "title-strip-label.png");
    viewer.send(r#"{"cmd":"setTitle","title":"Checkout flow"}"#);

    // Hover: motion inside reports once, leaving reports once.
    screen.move_to(thumb.x + 200, thumb.y + 150);
    assert_eq!(viewer.expect("hover")["inside"], true);
    screen.move_to(thumb.x + 210, thumb.y + 160);
    screen.move_to(thumb.x + 600, thumb.y + 600);
    assert_eq!(viewer.expect("hover")["inside"], false, "no repeat");
    screen.move_to(thumb.x + 200, thumb.y + 150);
    assert_eq!(viewer.expect("hover")["inside"], true);

    // Expanding ends the hover; the bar shows the caption.
    screen.click(thumb.x + 200, thumb.y + 150);
    assert_eq!(viewer.expect("hover")["inside"], false);
    assert_eq!(viewer.expect("mode")["mode"], "expanded");
    let expanded = screen.wait_size(class, 640, 512);
    let mut shot = screen.wait_color(expanded, 4, 4, BAR);
    let caption = wait_until(WAIT, || {
        shot = screen.shot();
        ink(&shot, expanded, 100, 4, 280, 24) > INK
    });
    assert!(caption, "bar caption");
    save(&shot, expanded, "bar-caption.png");
    screen.move_to(expanded.x + 300, expanded.y + 300);
    screen.move_to(expanded.x + 900, expanded.y + 900);
    viewer.expect_silent(Duration::from_millis(300));

    viewer.send(r#"{"cmd":"shutdown"}"#);
    assert_eq!(viewer.wait_exit(Duration::from_secs(3)), Some(0));
}

/// Bright pixels that drawn text leaves. The embedded font alone leaves
/// at most a few dozen: an ellipsis in the label and thin missing-glyph
/// boxes in the banner.
const INK: usize = 60;

#[test]
fn draws_label_and_banner_text_with_host_fonts() {
    if !xvfb_ready("host_fonts") {
        return;
    }
    let samples = [
        (
            "cjk",
            "\u{65e5}\u{672c}\u{8a9e}\u{306e}\u{30c6}\u{30b9}\u{30c8}",
        ),
        (
            "arabic",
            "\u{645}\u{631}\u{62d}\u{628}\u{627} \u{628}\u{627}\u{644}\u{639}\u{627}\u{644}\u{645}",
        ),
    ];
    let mut fonts = Fallback::default();
    for (name, sample) in samples {
        let missing = sample
            .chars()
            .find(|&c| c != ' ' && fonts.find(c).is_none());
        if let Some(c) = missing {
            eprintln!("skipped {name}: no host font draws {c:?}");
            continue;
        }
        let session = Xvfb::start("640x480x24");
        let host = Xvfb::start("1280x1024x24");
        // A plain session, so only text is bright.
        let _painter = Painter::new(session.display, 0, 0, 640, 480, BLUE);
        let class = format!("pickforge-viewer-fonts-{name}");
        let label = format!("desk-1 \u{b7} {sample}");
        let mut viewer = Viewer::spawn_with(
            &session,
            host.display,
            &class,
            "self",
            "1",
            &["--label", &label],
        );
        viewer.expect("ready");
        let mut screen = Screen::new(host.display);
        let thumb = screen.wait_size(&class, 384, 288);

        // The title strip shows the label: the session id and then the
        // sample, where an ellipsis stood before.
        let mut label_ink = 0;
        let drawn = wait_until(WAIT, || {
            label_ink = ink(&screen.shot(), thumb, 70, 0, 306, 32);
            label_ink > INK
        });
        assert!(drawn, "{name}: label ink {label_ink}");
        let prefix = ink(&screen.shot(), thumb, 8, 0, 62, 32);
        assert!(prefix > INK, "{name}: session id ink {prefix}");

        let message = format!(r#"{{"cmd":"attention","message":"{sample}"}}"#);
        viewer.send(&message);
        let mut banner_ink = 0;
        let drawn = wait_until(WAIT, || {
            banner_ink = ink(&screen.shot(), thumb, 8, 40, 368, 60);
            banner_ink > INK
        });
        assert!(drawn, "{name}: banner ink {banner_ink}");
        save(&screen.shot(), thumb, &format!("fonts-{name}.png"));
    }
}
