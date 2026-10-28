//! The short ring that marks a completed agent click. It lives only in the
//! viewer window and never reaches the session.

use crate::geometry::{self, Rect};
use std::time::{Duration, Instant};

/// How long one pulse lasts.
pub const DURATION: Duration = Duration::from_millis(500);
/// The redraw interval while a pulse runs.
pub const FRAME: Duration = Duration::from_millis(16);
/// Ring radius at the start and the end, in logical pixels.
const START_RADIUS: f64 = 4.0;
const END_RADIUS: f64 = 20.0;
/// Ring stroke, in logical pixels.
const STROKE: f64 = 2.0;

/// One ring frame in window pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Ring {
    pub center: (f64, f64),
    pub radius: f64,
    pub width: f64,
    pub alpha: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pulse {
    x: u32,
    y: u32,
    start: Instant,
    next_frame: Instant,
}

impl Pulse {
    /// A pulse at a session pixel. `None` outside the session.
    pub fn new(x: u32, y: u32, session: (u32, u32), start: Instant) -> Option<Self> {
        (x < session.0 && y < session.1).then_some(Self {
            x,
            y,
            start,
            next_frame: start,
        })
    }

    pub fn done(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.start) >= DURATION
    }

    /// True when the next frame is due, and moves that time on.
    pub fn frame_due(&mut self, now: Instant) -> bool {
        if now < self.next_frame {
            return false;
        }
        self.next_frame = now + FRAME;
        true
    }

    pub fn next_frame(&self) -> Instant {
        self.next_frame
    }

    fn center(&self, image: Rect, session: (u32, u32)) -> (f64, f64) {
        // The middle of the session pixel.
        geometry::view_point(
            image,
            session.0,
            session.1,
            self.x as f64 + 0.5,
            self.y as f64 + 0.5,
        )
    }

    /// The ring at `now`: it grows and fades out. `None` once it ended.
    pub fn ring(&self, image: Rect, session: (u32, u32), scale: f64, now: Instant) -> Option<Ring> {
        if image.is_empty() || self.done(now) {
            return None;
        }
        let t = now.saturating_duration_since(self.start).as_secs_f64() / DURATION.as_secs_f64();
        let eased = 1.0 - (1.0 - t) * (1.0 - t);
        Some(Ring {
            center: self.center(image, session),
            radius: (START_RADIUS + (END_RADIUS - START_RADIUS) * eased) * scale,
            width: STROKE * scale,
            alpha: (255.0 * (1.0 - t)).round() as u8,
        })
    }

    /// Every window pixel the pulse can touch, clipped to the image.
    pub fn bounds(&self, image: Rect, session: (u32, u32), scale: f64) -> Rect {
        if image.is_empty() {
            return Rect::default();
        }
        let (cx, cy) = self.center(image, session);
        let reach = (END_RADIUS * scale + 1.0).ceil();
        let x0 = (cx - reach).floor() as i32;
        let y0 = (cy - reach).floor() as i32;
        let x1 = (cx + reach).ceil() as i32;
        let y1 = (cy + reach).ceil() as i32;
        Rect::new(x0, y0, (x1 - x0) as u32, (y1 - y0) as u32).intersect(&image)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: (u32, u32) = (800, 600);

    fn at(ms: u64, start: Instant) -> Instant {
        start + Duration::from_millis(ms)
    }

    #[test]
    fn refuses_points_outside_the_session() {
        let now = Instant::now();
        assert!(Pulse::new(799, 599, SESSION, now).is_some());
        assert!(Pulse::new(800, 10, SESSION, now).is_none());
        assert!(Pulse::new(10, 600, SESSION, now).is_none());
    }

    #[test]
    fn maps_through_the_image_fit() {
        let now = Instant::now();
        let pulse = Pulse::new(399, 299, SESSION, now).unwrap();
        // A 384x288 thumbnail image under a 32 pixel bar, letterboxed.
        let image = Rect::new(8, 32, 384, 288);
        let ring = pulse.ring(image, SESSION, 1.0, now).unwrap();
        let (x, y) = ring.center;
        assert!((x - (8.0 + 399.5 * 0.48)).abs() < 1e-9, "{x}");
        assert!((y - (32.0 + 299.5 * 0.48)).abs() < 1e-9, "{y}");
        let full = Rect::new(0, 0, 800, 600);
        let ring = pulse.ring(full, SESSION, 2.0, now).unwrap();
        assert_eq!(ring.center, (399.5, 299.5));
        assert_eq!((ring.radius, ring.width), (8.0, 4.0));
    }

    #[test]
    fn grows_fades_and_ends() {
        let start = Instant::now();
        let pulse = Pulse::new(100, 100, SESSION, start).unwrap();
        let image = Rect::new(0, 0, 800, 600);
        let first = pulse.ring(image, SESSION, 1.0, start).unwrap();
        assert_eq!((first.radius, first.alpha), (4.0, 255));
        let mut last = first;
        for ms in [100, 250, 400, 499] {
            let ring = pulse.ring(image, SESSION, 1.0, at(ms, start)).unwrap();
            assert!(ring.radius > last.radius && ring.alpha < last.alpha, "{ms}");
            assert!(ring.radius < END_RADIUS);
            last = ring;
        }
        assert!(!pulse.done(at(499, start)));
        assert!(pulse.done(at(500, start)));
        assert_eq!(pulse.ring(image, SESSION, 1.0, at(500, start)), None);
        assert_eq!(pulse.ring(Rect::default(), SESSION, 1.0, start), None);
    }

    #[test]
    fn frames_are_paced() {
        let start = Instant::now();
        let mut pulse = Pulse::new(1, 1, SESSION, start).unwrap();
        assert!(pulse.frame_due(start));
        assert!(!pulse.frame_due(at(15, start)));
        assert_eq!(pulse.next_frame(), at(16, start));
        assert!(pulse.frame_due(at(16, start)));
    }

    #[test]
    fn bounds_cover_the_largest_ring_inside_the_image() {
        let start = Instant::now();
        let image = Rect::new(0, 32, 800, 600);
        let pulse = Pulse::new(400, 300, SESSION, start).unwrap();
        let bounds = pulse.bounds(image, SESSION, 1.0);
        let ring = pulse.ring(image, SESSION, 1.0, at(499, start)).unwrap();
        let (cx, cy) = ring.center;
        assert!(bounds.y as f64 <= cy - ring.radius - 1.0);
        assert!(bounds.bottom() as f64 >= cy + ring.radius + 1.0);
        assert!(bounds.x as f64 <= cx - ring.radius - 1.0);
        assert!(bounds.h <= 46, "{bounds:?}");
        // A corner pulse never reaches past the image, so the bar stays.
        let corner = Pulse::new(0, 0, SESSION, start).unwrap();
        let bounds = corner.bounds(image, SESSION, 2.0);
        assert_eq!((bounds.x, bounds.y), (0, 32));
        assert!(bounds.w <= 43 && bounds.h <= 43, "{bounds:?}");
        assert!(corner.bounds(Rect::default(), SESSION, 1.0).is_empty());
    }
}
