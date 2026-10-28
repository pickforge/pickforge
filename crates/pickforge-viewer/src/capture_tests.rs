use super::*;
use crate::test_common::{xvfb_ready, Xvfb};

#[test]
fn shm_fallback_detaches_the_server_segment() {
    if !xvfb_ready("shm_fallback_detaches") {
        return;
    }
    let display = Xvfb::start("640x480x24");
    let mut capture = Capture::connect(display.display).unwrap();
    let seg = capture.shm.as_ref().unwrap().seg;
    let root = capture.root;
    capture.root = 0; // Both image requests fail, but SHM must still detach.
    assert!(matches!(capture.snapshot(), Err(CaptureError::Request(_))));
    assert!(capture.shm.is_none());
    assert!(capture.conn.shm_detach(seg).unwrap().check().is_err());
    capture.root = root;
    assert!(capture.snapshot().is_ok());

    let capture = Capture::connect(display.display).unwrap();
    let seg = capture.shm.as_ref().unwrap().seg;
    let capture = capture.without_shm();
    assert!(capture.conn.shm_detach(seg).unwrap().check().is_err());
}

#[test]
fn a_failed_fetch_retries_the_pending_area() {
    if !xvfb_ready("failed_fetch_retries") {
        return;
    }
    let display = Xvfb::start("640x480x24");
    let mut capture = Capture::connect(display.display).unwrap().without_shm();
    let root = capture.root;
    let shared = Mutex::new(Shared::new(640, 480));
    let control = Control::new().unwrap();
    let mut state = CaptureSchedule::new(640, 480, false);
    let area = Rect::new(10, 20, 30, 40);
    state.pending = Some(area);
    state.cursor_moved = false;
    let now = Instant::now();
    capture.root = 0;
    assert!(matches!(
        capture.capture_due(&shared, &control, &mut state, now, now + PROC_INTERVAL),
        Err(CaptureError::Request(_))
    ));
    assert_eq!(state.pending, Some(area));
    capture.root = root;
    assert!(matches!(
        capture.capture_due(
            &shared,
            &control,
            &mut state,
            now + FETCH_INTERVAL,
            now + PROC_INTERVAL
        ),
        Ok(CaptureStep::Fetched(true))
    ));
    assert_eq!(state.pending, None);
    assert_eq!(shared.lock().unwrap().dirty, Some(area));
}

#[test]
fn xi2_version_error_keeps_pointer_polling_available() {
    if !xvfb_ready("xi2_version_error") {
        return;
    }
    let display = Xvfb::start("640x480x24");
    let conn = connect_display(display.display).unwrap();
    let root = conn.setup().roots[0].root;
    // XIQueryVersion rejects versions below 2 with BadValue.
    let version = conn.xinput_xi_query_version(0, 0).unwrap().reply();
    assert!(matches!(version, Err(ReplyError::X11Error(_))));
    let xi2 = select_xi2_motion(&conn, root, version).unwrap();
    assert!(!xi2);
    let mut state = CaptureSchedule::new(640, 480, false);
    state.cursor_moved = false;
    let now = Instant::now();
    assert!(state.pointer_timeout(xi2, now, PROC_INTERVAL) <= POINTER_POLL);
    assert!(state.cursor_moved);
    assert!(conn.query_pointer(root).unwrap().reply().is_ok());
}
