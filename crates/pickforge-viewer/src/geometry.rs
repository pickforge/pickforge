//! Pure layout math: rectangles, letterboxing, pointer mapping and window
//! sizes.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

impl Rect {
    pub const fn new(x: i32, y: i32, w: u32, h: u32) -> Self {
        Self { x, y, w, h }
    }

    pub fn is_empty(&self) -> bool {
        self.w == 0 || self.h == 0
    }

    pub fn right(&self) -> i32 {
        self.x + self.w as i32
    }

    pub fn bottom(&self) -> i32 {
        self.y + self.h as i32
    }

    pub fn contains(&self, px: f64, py: f64) -> bool {
        px >= self.x as f64
            && py >= self.y as f64
            && px < self.right() as f64
            && py < self.bottom() as f64
    }

    pub fn intersect(&self, other: &Rect) -> Rect {
        let x0 = self.x.max(other.x);
        let y0 = self.y.max(other.y);
        let x1 = self.right().min(other.right());
        let y1 = self.bottom().min(other.bottom());
        if x1 <= x0 || y1 <= y0 {
            return Rect::default();
        }
        Rect::new(x0, y0, (x1 - x0) as u32, (y1 - y0) as u32)
    }

    pub fn union(&self, other: &Rect) -> Rect {
        if self.is_empty() {
            return *other;
        }
        if other.is_empty() {
            return *self;
        }
        let x0 = self.x.min(other.x);
        let y0 = self.y.min(other.y);
        let x1 = self.right().max(other.right());
        let y1 = self.bottom().max(other.bottom());
        Rect::new(x0, y0, (x1 - x0) as u32, (y1 - y0) as u32)
    }
}

/// The largest rectangle with the source aspect ratio that fits in
/// `area`, centered. The rest of `area` is letterbox.
pub fn fit(src_w: u32, src_h: u32, area: Rect) -> Rect {
    if src_w == 0 || src_h == 0 || area.is_empty() {
        return Rect::new(area.x, area.y, 0, 0);
    }
    let (aw, ah) = (area.w as u64, area.h as u64);
    let (sw, sh) = (src_w as u64, src_h as u64);
    let (w, h) = if aw * sh <= ah * sw {
        (aw, ((aw * sh * 2 + sw) / (sw * 2)).clamp(1, ah))
    } else {
        (((ah * sw * 2 + sh) / (sh * 2)).clamp(1, aw), ah)
    };
    let x = area.x + ((aw - w) / 2) as i32;
    let y = area.y + ((ah - h) / 2) as i32;
    Rect::new(x, y, w as u32, h as u32)
}

/// Maps a window position in physical pixels to a session pixel. Returns
/// `None` outside the image, so letterbox and bar positions map to
/// nothing.
pub fn session_point(
    image: Rect,
    session_w: u32,
    session_h: u32,
    px: f64,
    py: f64,
) -> Option<(u32, u32)> {
    if image.is_empty() || !image.contains(px, py) {
        return None;
    }
    let sx = ((px - image.x as f64) * session_w as f64 / image.w as f64).floor() as u32;
    let sy = ((py - image.y as f64) * session_h as f64 / image.h as f64).floor() as u32;
    Some((sx.min(session_w - 1), sy.min(session_h - 1)))
}

/// Maps a session position to the window, the inverse of
/// [`session_point`] up to rounding.
pub fn view_point(image: Rect, session_w: u32, session_h: u32, sx: f64, sy: f64) -> (f64, f64) {
    (
        image.x as f64 + sx * image.w as f64 / session_w as f64,
        image.y as f64 + sy * image.h as f64 / session_h as f64,
    )
}

/// Thumbnail inner size in logical pixels: the given width and the session
/// aspect ratio.
pub fn thumbnail_size(width: u32, session_w: u32, session_h: u32) -> (u32, u32) {
    let h =
        ((width as u64 * session_h as u64 * 2 + session_w as u64) / (session_w as u64 * 2)).max(1);
    (width, h as u32)
}

/// Expanded inner size in logical pixels: the session size plus the bar,
/// capped to `limit` with the image aspect ratio kept.
pub fn expanded_size(
    session_w: u32,
    session_h: u32,
    bar: u32,
    limit: Option<(u32, u32)>,
) -> (u32, u32) {
    let Some((max_w, max_h)) = limit else {
        return (session_w, session_h + bar);
    };
    if session_w <= max_w && session_h + bar <= max_h {
        return (session_w, session_h + bar);
    }
    let area = Rect::new(0, 0, max_w.max(1), max_h.saturating_sub(bar).max(1));
    let image = fit(session_w, session_h, area);
    (image.w, image.h + bar)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_letterboxes_wide_and_tall_areas() {
        assert_eq!(
            fit(1280, 960, Rect::new(0, 0, 384, 288)),
            Rect::new(0, 0, 384, 288)
        );
        assert_eq!(
            fit(1280, 960, Rect::new(0, 32, 1000, 500)),
            Rect::new(166, 32, 667, 500)
        );
        assert_eq!(
            fit(640, 480, Rect::new(0, 0, 640, 1000)),
            Rect::new(0, 260, 640, 480)
        );
        assert_eq!(
            fit(1920, 1080, Rect::new(10, 20, 3, 1)),
            Rect::new(10, 20, 2, 1)
        );
        assert!(fit(0, 10, Rect::new(0, 0, 10, 10)).is_empty());
        assert!(fit(10, 10, Rect::new(0, 0, 0, 10)).is_empty());
    }

    #[test]
    fn fit_keeps_aspect_within_a_pixel() {
        for (sw, sh) in [(1280, 800), (1920, 1080), (640, 480), (333, 777)] {
            for (aw, ah) in [(384, 300), (2560, 1440), (101, 999), (1, 1)] {
                let r = fit(sw, sh, Rect::new(0, 0, aw, ah));
                assert!(r.w <= aw && r.h <= ah);
                assert!(r.w == aw || r.h == ah, "{sw}x{sh} in {aw}x{ah}: {r:?}");
                let ideal_h = r.w as f64 * sh as f64 / sw as f64;
                let ideal_w = r.h as f64 * sw as f64 / sh as f64;
                assert!((r.h as f64 - ideal_h).abs() <= 1.0 || (r.w as f64 - ideal_w).abs() <= 1.0);
            }
        }
    }

    #[test]
    fn pointer_maps_to_session_pixels() {
        let image = Rect::new(100, 32, 640, 400);
        assert_eq!(session_point(image, 1280, 800, 100.0, 32.0), Some((0, 0)));
        assert_eq!(
            session_point(image, 1280, 800, 420.5, 232.0),
            Some((641, 400))
        );
        assert_eq!(
            session_point(image, 1280, 800, 739.99, 431.99),
            Some((1279, 799))
        );
        assert_eq!(session_point(image, 1280, 800, 99.9, 100.0), None);
        assert_eq!(session_point(image, 1280, 800, 740.0, 100.0), None);
        assert_eq!(session_point(image, 1280, 800, 300.0, 10.0), None, "bar");
        assert_eq!(session_point(Rect::default(), 1280, 800, 0.0, 0.0), None);
    }

    #[test]
    fn pointer_mapping_round_trips() {
        let image = Rect::new(7, 40, 384, 240);
        for (sx, sy) in [(0u32, 0u32), (639, 399), (320, 200), (17, 333)] {
            let (vx, vy) = view_point(image, 640, 400, sx as f64 + 0.5, sy as f64 + 0.5);
            assert_eq!(session_point(image, 640, 400, vx, vy), Some((sx, sy)));
        }
    }

    #[test]
    fn rect_set_operations() {
        let a = Rect::new(0, 0, 10, 10);
        let b = Rect::new(5, 5, 10, 10);
        assert_eq!(a.intersect(&b), Rect::new(5, 5, 5, 5));
        assert_eq!(a.union(&b), Rect::new(0, 0, 15, 15));
        assert!(a.intersect(&Rect::new(20, 20, 1, 1)).is_empty());
        assert_eq!(Rect::default().union(&b), b);
        assert_eq!(b.union(&Rect::default()), b);
    }

    #[test]
    fn window_sizes() {
        assert_eq!(thumbnail_size(384, 1280, 960), (384, 288));
        assert_eq!(thumbnail_size(384, 1920, 1080), (384, 216));
        assert_eq!(thumbnail_size(384, 1280, 801), (384, 240));
        assert_eq!(expanded_size(1280, 800, 32, None), (1280, 832));
        assert_eq!(
            expanded_size(1280, 800, 32, Some((2000, 2000))),
            (1280, 832)
        );
        assert_eq!(
            expanded_size(1920, 1080, 32, Some((1728, 972))),
            (1671, 972)
        );
        assert_eq!(
            expanded_size(1280, 800, 32, Some((1000, 2000))),
            (1000, 657)
        );
    }
}
