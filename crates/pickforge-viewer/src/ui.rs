//! Software drawing for the bar, the status pill and the cursor. Colors come
//! from the Pickforge design tokens. Text uses the embedded Geist Medium
//! (SIL Open Font License 1.1, see `assets/OFL.txt`).

use crate::geometry::Rect;
use std::collections::HashMap;

const FONT: &[u8] = include_bytes!("../assets/Geist-Medium.ttf");

/// Pickforge design tokens as `0x00RRGGBB`.
pub mod palette {
    /// `--color-surface`, the letterbox.
    pub const SURFACE: u32 = 0x000a_0a0b;
    /// `--color-surface-1`, the bar.
    pub const SURFACE_1: u32 = 0x000f_0f11;
    /// `--color-text`.
    pub const TEXT: u32 = 0x00f2_f2f3;
    /// White for the hairline and hover overlays.
    pub const WHITE: u32 = 0x00ff_ffff;
    /// `--color-hairline` opacity, 0.08.
    pub const HAIRLINE: u8 = 20;
    /// `--color-hairline-strong` opacity, 0.14.
    pub const HAIRLINE_STRONG: u8 = 36;
    /// Hover fill opacity.
    pub const HOVER: u8 = 15;
    /// Pressed fill opacity.
    pub const PRESSED: u8 = 31;
}

/// Bar height in logical pixels.
pub const BAR_HEIGHT: u32 = 32;

/// Blends `src` over `dst` with `alpha` from 0 to 255.
pub fn blend(dst: u32, src: u32, alpha: u32) -> u32 {
    if alpha >= 255 {
        return src & 0x00ff_ffff;
    }
    if alpha == 0 {
        return dst;
    }
    let inv = 255 - alpha;
    let mix = |shift: u32| {
        let d = (dst >> shift) & 0xff;
        let s = (src >> shift) & 0xff;
        ((s * alpha + d * inv + 127) / 255) << shift
    };
    mix(16) | mix(8) | mix(0)
}

/// A pixel buffer with a clip rectangle. Every primitive stays inside it.
pub struct Canvas<'a> {
    pub buf: &'a mut [u32],
    pub width: u32,
    pub clip: Rect,
}

impl<'a> Canvas<'a> {
    pub fn new(buf: &'a mut [u32], width: u32, height: u32, clip: Rect) -> Self {
        let clip = clip.intersect(&Rect::new(0, 0, width, height));
        Self { buf, width, clip }
    }

    fn clipped(&self, rect: Rect) -> Rect {
        rect.intersect(&self.clip)
    }

    pub fn fill(&mut self, rect: Rect, color: u32) {
        let r = self.clipped(rect);
        for y in r.y..r.bottom() {
            let start = (y as u32 * self.width + r.x as u32) as usize;
            self.buf[start..start + r.w as usize].fill(color);
        }
    }

    pub fn blend_fill(&mut self, rect: Rect, color: u32, alpha: u8) {
        let r = self.clipped(rect);
        for y in r.y..r.bottom() {
            let start = (y as u32 * self.width + r.x as u32) as usize;
            for p in &mut self.buf[start..start + r.w as usize] {
                *p = blend(*p, color, alpha as u32);
            }
        }
    }

    /// Copies `pixels`, laid out with `stride`, into `rect`.
    pub fn blit(&mut self, rect: Rect, pixels: &[u32], stride: usize) {
        let r = self.clipped(rect);
        for y in r.y..r.bottom() {
            let src = (y - rect.y) as usize * stride + (r.x - rect.x) as usize;
            let dst = (y as u32 * self.width + r.x as u32) as usize;
            self.buf[dst..dst + r.w as usize].copy_from_slice(&pixels[src..src + r.w as usize]);
        }
    }

    /// Fills a pixel area by a coverage function from 0 to 1 at each
    /// pixel center.
    fn shade(&mut self, area: Rect, color: u32, alpha: u8, coverage: impl Fn(f32, f32) -> f32) {
        let r = self.clipped(area);
        for y in r.y..r.bottom() {
            for x in r.x..r.right() {
                let c = coverage(x as f32 + 0.5, y as f32 + 0.5).clamp(0.0, 1.0);
                if c > 0.0 {
                    let i = (y as u32 * self.width + x as u32) as usize;
                    self.buf[i] = blend(self.buf[i], color, (c * alpha as f32).round() as u32);
                }
            }
        }
    }

    /// An antialiased rounded rectangle.
    pub fn rounded(&mut self, rect: Rect, radius: f32, color: u32, alpha: u8) {
        self.shade(rect, color, alpha, |px, py| {
            0.5 - rounded_distance(rect, radius, px, py)
        });
    }

    /// An antialiased rounded outline of `width` pixels inside `rect`.
    pub fn rounded_outline(&mut self, rect: Rect, radius: f32, width: f32, color: u32, alpha: u8) {
        self.shade(rect, color, alpha, |px, py| {
            let d = rounded_distance(rect, radius, px, py);
            (0.5 - d).min(0.5 + d + width)
        });
    }

    /// An antialiased line with round caps.
    pub fn line(&mut self, from: (f32, f32), to: (f32, f32), width: f32, color: u32) {
        let pad = width.ceil() as i32 + 1;
        let x0 = from.0.min(to.0).floor() as i32 - pad;
        let y0 = from.1.min(to.1).floor() as i32 - pad;
        let x1 = from.0.max(to.0).ceil() as i32 + pad;
        let y1 = from.1.max(to.1).ceil() as i32 + pad;
        let area = Rect::new(x0, y0, (x1 - x0) as u32, (y1 - y0) as u32);
        let (dx, dy) = (to.0 - from.0, to.1 - from.1);
        let len2 = (dx * dx + dy * dy).max(1e-6);
        self.shade(area, color, 255, |px, py| {
            let t = (((px - from.0) * dx + (py - from.1) * dy) / len2).clamp(0.0, 1.0);
            let (cx, cy) = (from.0 + t * dx - px, from.1 + t * dy - py);
            width / 2.0 + 0.5 - (cx * cx + cy * cy).sqrt()
        });
    }

    /// Draws a coverage mask with its top-left corner at `(x, y)`.
    fn mask(&mut self, x: i32, y: i32, w: u32, h: u32, coverage: &[u8], color: u32) {
        let r = self.clipped(Rect::new(x, y, w, h));
        for py in r.y..r.bottom() {
            let row = ((py - y) as u32 * w) as usize;
            for px in r.x..r.right() {
                let c = coverage[row + (px - x) as usize] as u32;
                if c > 0 {
                    let i = (py as u32 * self.width + px as u32) as usize;
                    self.buf[i] = blend(self.buf[i], color, c);
                }
            }
        }
    }

    /// Draws premultiplied ARGB pixels scaled by `factor` with nearest
    /// sampling.
    pub fn premultiplied(&mut self, x: i32, y: i32, w: u32, h: u32, pixels: &[u32], factor: f64) {
        let dw = ((w as f64 * factor).round() as u32).max(1);
        let dh = ((h as f64 * factor).round() as u32).max(1);
        let r = self.clipped(Rect::new(x, y, dw, dh));
        for py in r.y..r.bottom() {
            let sy = (((py - y) as f64 / factor) as u32).min(h - 1);
            for px in r.x..r.right() {
                let sx = (((px - x) as f64 / factor) as u32).min(w - 1);
                let s = pixels[(sy * w + sx) as usize];
                let a = s >> 24;
                if a == 0 {
                    continue;
                }
                let i = (py as u32 * self.width + px as u32) as usize;
                let d = self.buf[i];
                let inv = 255 - a;
                let mix = |shift: u32| {
                    let v = ((s >> shift) & 0xff) + (((d >> shift) & 0xff) * inv + 127) / 255;
                    v.min(255) << shift
                };
                self.buf[i] = mix(16) | mix(8) | mix(0);
            }
        }
    }
}

/// Signed distance from a pixel center to a rounded rectangle; negative
/// inside.
fn rounded_distance(rect: Rect, radius: f32, px: f32, py: f32) -> f32 {
    let hw = rect.w as f32 / 2.0;
    let hh = rect.h as f32 / 2.0;
    let r = radius.min(hw).min(hh).max(0.0);
    let qx = (px - (rect.x as f32 + hw)).abs() - (hw - r);
    let qy = (py - (rect.y as f32 + hh)).abs() - (hh - r);
    let outside = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt();
    outside + qx.max(qy).min(0.0) - r
}

/// Extra space per character in em, close to the brand's wide button
/// tracking at small sizes.
const TRACKING: f32 = 0.02;

struct Glyph {
    metrics: fontdue::Metrics,
    coverage: Vec<u8>,
}

/// Lays out and draws one line of text with a glyph cache.
pub struct Text {
    font: fontdue::Font,
    cache: HashMap<(char, u32), Glyph>,
}

fn load_font() -> Result<fontdue::Font, String> {
    fontdue::Font::from_bytes(FONT, fontdue::FontSettings::default())
        .map_err(|e| format!("embedded font: {e}"))
}

impl Text {
    pub fn new() -> Self {
        Self {
            font: load_font().expect("the embedded font is valid"),
            cache: HashMap::new(),
        }
    }

    fn glyph(&mut self, c: char, px: f32) -> &Glyph {
        let font = &self.font;
        self.cache.entry((c, px.to_bits())).or_insert_with(|| {
            let (metrics, coverage) = font.rasterize(c, px);
            Glyph { metrics, coverage }
        })
    }

    /// Advance width of `text` in pixels, with [`TRACKING`].
    pub fn width(&mut self, text: &str, px: f32) -> f32 {
        let tracking = TRACKING;
        let mut pen = 0.0;
        let mut prev = None;
        for c in text.chars() {
            if let Some(p) = prev {
                pen += self.font.horizontal_kern(p, c, px).unwrap_or(0.0);
            }
            pen += self.glyph(c, px).metrics.advance_width + tracking * px;
            prev = Some(c);
        }
        (pen - tracking * px).max(0.0)
    }

    /// Draws `text` from `x` with its cap height centered on `center_y`.
    pub fn draw(
        &mut self,
        canvas: &mut Canvas,
        text: &str,
        x: f32,
        center_y: f32,
        px: f32,
        color: u32,
    ) {
        let tracking = TRACKING;
        let cap = self.glyph('H', px).metrics;
        let baseline = (center_y + (cap.height as f32 + cap.ymin as f32) / 2.0).round();
        let mut pen = x;
        let mut prev = None;
        for c in text.chars() {
            if let Some(p) = prev {
                pen += self.font.horizontal_kern(p, c, px).unwrap_or(0.0);
            }
            let glyph = self.glyph(c, px);
            let m = glyph.metrics;
            let gx = (pen + m.xmin as f32).round() as i32;
            let gy = baseline as i32 - m.height as i32 - m.ymin;
            canvas.mask(
                gx,
                gy,
                m.width as u32,
                m.height as u32,
                &glyph.coverage,
                color,
            );
            pen += m.advance_width + tracking * px;
            prev = Some(c);
        }
    }
}

/// Checks that the embedded font loads and renders, for `--self-test`.
pub fn font_check() -> Result<(), String> {
    let font = load_font()?;
    for c in ['C', 'S', 'F', '\u{d7}'] {
        let (metrics, coverage) = font.rasterize(c, 24.0);
        if metrics.width == 0 || coverage.iter().all(|&v| v == 0) {
            return Err(format!("embedded font has no glyph for {c:?}"));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Fullscreen,
    Collapse,
    Close,
}

/// Where the bar and its buttons sit, in physical pixels.
#[derive(Debug, Clone, PartialEq)]
pub struct Bar {
    pub rect: Rect,
    pub buttons: Vec<(Button, Rect)>,
    pub fullscreen: bool,
}

/// Sizes in physical pixels for one scale factor.
#[derive(Debug, Clone, Copy)]
pub struct Metrics {
    pub scale: f64,
}

impl Metrics {
    pub fn px(&self, logical: f64) -> f32 {
        (logical * self.scale) as f32
    }

    pub fn round(&self, logical: f64) -> u32 {
        (logical * self.scale).round().max(1.0) as u32
    }

    pub fn bar_height(&self) -> u32 {
        self.round(BAR_HEIGHT as f64)
    }

    fn font_px(&self) -> f32 {
        // Whole pixels keep glyph edges crisp.
        self.px(12.0).round().max(8.0)
    }
}

fn fullscreen_label(fullscreen: bool) -> &'static str {
    if fullscreen {
        "Exit fullscreen"
    } else {
        "Fullscreen"
    }
}

impl Bar {
    pub fn layout(width: u32, metrics: Metrics, fullscreen: bool, text: &mut Text) -> Bar {
        let rect = Rect::new(0, 0, width, metrics.bar_height());
        let button_h = metrics.round(24.0);
        let gap = metrics.round(4.0) as i32;
        let top = ((rect.h - button_h) / 2) as i32;
        let pad = metrics.px(12.0);
        let font = metrics.font_px();
        let mut right = width as i32 - gap;
        let mut buttons = Vec::new();
        for button in [Button::Close, Button::Collapse, Button::Fullscreen] {
            let w = match button {
                Button::Close => button_h,
                Button::Collapse => (text.width("Collapse", font) + 2.0 * pad).ceil() as u32,
                Button::Fullscreen => {
                    (text.width(fullscreen_label(fullscreen), font) + 2.0 * pad).ceil() as u32
                }
            };
            right -= w as i32;
            buttons.push((button, Rect::new(right, top, w, button_h)));
            right -= gap;
        }
        buttons.reverse();
        Bar {
            rect,
            buttons,
            fullscreen,
        }
    }

    pub fn hit(&self, px: f64, py: f64) -> Option<Button> {
        self.buttons
            .iter()
            .find(|(_, r)| r.contains(px, py))
            .map(|(b, _)| *b)
    }

    pub fn draw(
        &self,
        canvas: &mut Canvas,
        metrics: Metrics,
        text: &mut Text,
        hover: Option<Button>,
        pressed: Option<Button>,
    ) {
        canvas.fill(self.rect, palette::SURFACE_1);
        let line = metrics.round(1.0);
        canvas.blend_fill(
            Rect::new(0, self.rect.bottom() - line as i32, self.rect.w, line),
            palette::WHITE,
            palette::HAIRLINE,
        );
        let radius = metrics.px(6.0);
        let font = metrics.font_px();
        for &(button, r) in &self.buttons {
            let is_pressed = pressed == Some(button) && hover == Some(button);
            if is_pressed {
                canvas.rounded(r, radius, palette::WHITE, palette::PRESSED);
            } else if hover == Some(button) || pressed == Some(button) {
                canvas.rounded(r, radius, palette::WHITE, palette::HOVER);
            }
            if hover == Some(button) || is_pressed {
                canvas.rounded_outline(
                    r,
                    radius,
                    metrics.px(1.0),
                    palette::WHITE,
                    palette::HAIRLINE_STRONG,
                );
            }
            let color = if hover == Some(button) || is_pressed {
                palette::TEXT
            } else {
                blend(palette::TEXT, palette::SURFACE_1, 40)
            };
            let cx = r.x as f32 + r.w as f32 / 2.0;
            let cy = r.y as f32 + r.h as f32 / 2.0;
            match button {
                Button::Close => {
                    let arm = metrics.px(4.5);
                    let stroke = metrics.px(1.5);
                    canvas.line((cx - arm, cy - arm), (cx + arm, cy + arm), stroke, color);
                    canvas.line((cx - arm, cy + arm), (cx + arm, cy - arm), stroke, color);
                }
                Button::Collapse | Button::Fullscreen => {
                    let label = if button == Button::Collapse {
                        "Collapse"
                    } else {
                        fullscreen_label(self.fullscreen)
                    };
                    let w = text.width(label, font);
                    text.draw(canvas, label, (cx - w / 2.0).round(), cy, font, color);
                }
            }
        }
    }
}

/// The status pill in the bottom-left corner of `area`.
pub fn status_rect(area: Rect, label: &str, metrics: Metrics, text: &mut Text) -> Rect {
    let font = metrics.font_px();
    let pad = metrics.px(10.0);
    let h = metrics.round(24.0);
    let margin = metrics.round(8.0) as i32;
    let w = (text.width(label, font) + 2.0 * pad).ceil() as u32;
    Rect::new(area.x + margin, area.bottom() - margin - h as i32, w, h)
}

pub fn draw_status(
    canvas: &mut Canvas,
    rect: Rect,
    label: &str,
    metrics: Metrics,
    text: &mut Text,
) {
    let radius = rect.h as f32 / 2.0;
    canvas.rounded(rect, radius, palette::SURFACE, 224);
    canvas.rounded_outline(
        rect,
        radius,
        metrics.px(1.0),
        palette::WHITE,
        palette::HAIRLINE_STRONG,
    );
    let font = metrics.font_px();
    let w = text.width(label, font);
    let cx = rect.x as f32 + rect.w as f32 / 2.0;
    let cy = rect.y as f32 + rect.h as f32 / 2.0;
    text.draw(
        canvas,
        label,
        (cx - w / 2.0).round(),
        cy,
        font,
        palette::TEXT,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blend_endpoints_and_midpoint() {
        assert_eq!(blend(0x000000, 0xffffff, 0), 0x000000);
        assert_eq!(blend(0x000000, 0xffffff, 255), 0xffffff);
        assert_eq!(blend(0x000000, 0xff7a1a, 128), 0x803d0d);
    }

    #[test]
    fn font_renders() {
        font_check().unwrap();
    }

    #[test]
    fn bar_buttons_fit_and_do_not_overlap() {
        let mut text = Text::new();
        for scale in [1.0, 1.25, 2.0] {
            let metrics = Metrics { scale };
            let width = (640.0 * scale) as u32;
            let bar = Bar::layout(width, metrics, false, &mut text);
            assert_eq!(bar.buttons.len(), 3);
            let mut last = 0;
            for (_, r) in &bar.buttons {
                assert!(
                    r.x >= last && r.right() <= width as i32 && r.bottom() <= bar.rect.h as i32
                );
                last = r.right();
            }
            let (_, close) = bar.buttons[2];
            assert_eq!(
                bar.hit(close.x as f64 + 1.0, close.y as f64 + 1.0),
                Some(Button::Close)
            );
            assert_eq!(bar.hit(1.0, 1.0), None);
        }
    }

    #[test]
    fn drawing_stays_inside_the_clip() {
        let mut buf = vec![0u32; 20 * 20];
        let mut canvas = Canvas::new(&mut buf, 20, 20, Rect::new(5, 5, 10, 10));
        canvas.fill(Rect::new(0, 0, 20, 20), 0xffffff);
        canvas.line((0.0, 0.0), (19.0, 19.0), 3.0, 0x00ff00);
        canvas.rounded(Rect::new(-5, -5, 30, 30), 4.0, 0xff0000, 255);
        for y in 0..20 {
            for x in 0..20 {
                let inside = (5..15).contains(&x) && (5..15).contains(&y);
                assert_eq!(buf[y * 20 + x] != 0, inside, "{x},{y}");
            }
        }
    }

    #[test]
    fn premultiplied_cursor_blends_over_content() {
        let mut buf = vec![0x0000_00ff; 4];
        let mut canvas = Canvas::new(&mut buf, 2, 2, Rect::new(0, 0, 2, 2));
        // Opaque white, transparent, half-transparent black (premultiplied).
        canvas.premultiplied(0, 0, 2, 1, &[0xffff_ffff, 0x0000_0000], 1.0);
        canvas.premultiplied(0, 1, 1, 1, &[0x8000_0000], 1.0);
        assert_eq!(buf, [0x00ff_ffff, 0x0000_00ff, 0x0000_007f, 0x0000_00ff]);
    }
}
