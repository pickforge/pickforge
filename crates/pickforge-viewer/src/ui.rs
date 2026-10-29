//! Software drawing for the bar, the status pill and the cursor. Colors come
//! from the Pickforge design tokens. Text uses the embedded Geist Medium
//! (SIL Open Font License 1.1, see `assets/OFL.txt`), and host fonts for
//! characters it lacks.

use crate::fallback::Fallback;
use crate::geometry::Rect;
use std::collections::HashMap;
use std::ops::Range;
use swash::scale::{Render, ScaleContext, Source};
use swash::shape::{Direction, ShapeContext};
use swash::text::{Category, Codepoint as _, Script};
use swash::zeno::Format;
use swash::{FontRef, GlyphId};
use unicode_bidi::ParagraphBidiInfo;

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
    /// `--color-ember`, the one highlight: Take control in the banner and
    /// the control state.
    pub const EMBER: u32 = 0x00ff_7a1a;
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

    /// An antialiased circle outline of `width` pixels inside `radius`.
    pub fn ring(&mut self, center: (f32, f32), radius: f32, width: f32, color: u32, alpha: u8) {
        let reach = radius + 1.0;
        let x0 = (center.0 - reach).floor() as i32;
        let y0 = (center.1 - reach).floor() as i32;
        let x1 = (center.0 + reach).ceil() as i32;
        let y1 = (center.1 + reach).ceil() as i32;
        let area = Rect::new(x0, y0, (x1 - x0) as u32, (y1 - y0) as u32);
        self.shade(area, color, alpha, |px, py| {
            let d = (px - center.0).hypot(py - center.1) - radius;
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
    left: i32,
    top: i32,
    width: u32,
    height: u32,
    coverage: Vec<u8>,
}

/// A shaped glyph: its font and where it sits from the pen start.
#[derive(Debug, Clone, Copy)]
struct Placed {
    font: usize,
    id: GlyphId,
    x: f32,
    y: f32,
}

/// Text that one font shapes in one script and one direction.
#[derive(Debug, Clone, PartialEq)]
struct Run {
    range: Range<usize>,
    font: usize,
    script: Script,
}

/// Lays out and draws one line of text with a glyph cache. Font 0 is the
/// embedded font; characters it lacks come from host fonts.
pub struct Text {
    font: FontRef<'static>,
    fallback: Fallback,
    scale: ScaleContext,
    shape: ShapeContext,
    cache: HashMap<(usize, GlyphId, u32), Glyph>,
}

fn load_font() -> Result<FontRef<'static>, String> {
    FontRef::from_index(FONT, 0).ok_or_else(|| "embedded font: invalid font data".to_string())
}

fn rasterize(scale: &mut ScaleContext, font: FontRef<'_>, id: GlyphId, px: f32) -> Glyph {
    let mut scaler = scale.builder(font).size(px).build();
    let image = Render::new(&[Source::Outline])
        .format(Format::Alpha)
        .render(&mut scaler, id);
    match image {
        Some(image) => Glyph {
            left: image.placement.left,
            top: image.placement.top,
            width: image.placement.width,
            height: image.placement.height,
            coverage: image.data,
        },
        None => Glyph {
            left: 0,
            top: 0,
            width: 0,
            height: 0,
            coverage: Vec::new(),
        },
    }
}

/// Marks and format characters belong to the character before them.
fn attaches(c: char) -> bool {
    matches!(
        c.category(),
        Category::Mark
            | Category::SpacingMark
            | Category::EnclosingMark
            | Category::NonspacingMark
            | Category::Format
    ) || ignorable(c)
}

/// Unicode default ignorable code points, such as variation selectors and
/// soft hyphens. Shaping drops them, so no font needs to draw them.
fn ignorable(c: char) -> bool {
    matches!(
        c,
        '\u{00ad}'
            | '\u{034f}'
            | '\u{061c}'
            | '\u{115f}'..='\u{1160}'
            | '\u{17b4}'..='\u{17b5}'
            | '\u{180b}'..='\u{180f}'
            | '\u{200b}'..='\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2060}'..='\u{206f}'
            | '\u{3164}'
            | '\u{fe00}'..='\u{fe0f}'
            | '\u{feff}'
            | '\u{ffa0}'
            | '\u{fff0}'..='\u{fff8}'
            | '\u{1bca0}'..='\u{1bca3}'
            | '\u{1d173}'..='\u{1d17a}'
            | '\u{e0000}'..='\u{e0fff}'
    )
}

/// Splits `text` into runs by font and script. `font_of` picks the font of
/// each cluster, a character and the marks and format characters after
/// it, without ignorable code points. Characters common to scripts, such
/// as spaces and digits, take the script of their run or the run before
/// it.
fn split_runs(text: &str, mut font_of: impl FnMut(&[char]) -> usize) -> Vec<Run> {
    let mut runs: Vec<(Range<usize>, usize, Option<Script>)> = Vec::new();
    let mut chars = text.char_indices().peekable();
    while let Some((start, base)) = chars.next() {
        let mut cluster = vec![base];
        let mut end = start + base.len_utf8();
        while let Some((i, c)) = chars.next_if(|&(_, c)| attaches(c)) {
            cluster.push(c);
            end = i + c.len_utf8();
        }
        let script = match base.script() {
            _ if attaches(base) => None,
            Script::Common | Script::Inherited | Script::Unknown => None,
            script => Some(script),
        };
        cluster.retain(|&c| !ignorable(c));
        // A cluster of ignorable code points only draws nothing.
        let font = (!cluster.is_empty()).then(|| font_of(&cluster));
        if let Some((range, run_font, run_script)) = runs.last_mut() {
            let font_ok = font.is_none_or(|font| font == *run_font);
            let script_ok = script.is_none() || run_script.is_none() || *run_script == script;
            if font_ok && script_ok {
                range.end = end;
                *run_script = run_script.or(script);
                continue;
            }
        }
        runs.push((start..end, font.unwrap_or(0), script));
    }
    // Runs with no script of their own take the one before them, or the
    // first one when they lead.
    let first = runs.iter().find_map(|(_, _, script)| *script);
    let mut last = first.unwrap_or(Script::Latin);
    runs.into_iter()
        .map(|(range, font, script)| {
            last = script.unwrap_or(last);
            Run {
                range,
                font,
                script: last,
            }
        })
        .collect()
}

impl Text {
    pub fn new() -> Self {
        Self {
            font: load_font().expect("the embedded font is valid"),
            fallback: Fallback::default(),
            scale: ScaleContext::new(),
            shape: ShapeContext::new(),
            cache: HashMap::new(),
        }
    }

    fn font(&self, index: usize) -> FontRef<'static> {
        match index {
            0 => self.font,
            i => self.fallback.font(i - 1),
        }
    }

    /// The font that draws all of `cluster`: the embedded font, else the
    /// first loaded host font that has it all, else the font that draws its
    /// first character. Only loaded fonts are tried for a whole cluster, so
    /// a message of many clusters never costs one host scan per cluster.
    fn font_of(&mut self, cluster: &[char]) -> Option<usize> {
        let charmap = self.font.charmap();
        let others: Vec<char> = cluster
            .iter()
            .copied()
            .filter(|&c| charmap.map(c) == 0)
            .collect();
        if others.is_empty() {
            return Some(0);
        }
        self.fallback.find_all(&others);
        if let Some(i) = self.fallback.find_cluster(cluster) {
            return Some(i + 1);
        }
        match *cluster.first()? {
            base if charmap.map(base) != 0 => Some(0),
            base => self.fallback.find(base).map(|i| i + 1),
        }
    }

    fn glyph(&mut self, font: usize, id: GlyphId, px: f32) -> &Glyph {
        let face = self.font(font);
        let scale = &mut self.scale;
        self.cache
            .entry((font, id, px.to_bits()))
            .or_insert_with(|| rasterize(scale, face, id, px))
    }

    /// Shaped glyphs of `text` in visual order, and the pen position after
    /// the last one. Only the embedded font gets [`TRACKING`], which would
    /// break the joins of connected scripts.
    fn layout(&mut self, text: &str, px: f32) -> (Vec<Placed>, f32) {
        let mut glyphs = Vec::new();
        let mut pen = 0.0;
        // Text before the Hebrew block that the embedded font covers is one
        // left-to-right run.
        let simple = text
            .chars()
            .all(|c| (c as u32) < 0x0590 && (ignorable(c) || self.font.charmap().map(c) != 0));
        if simple {
            let run = Run {
                range: 0..text.len(),
                font: 0,
                script: Script::Latin,
            };
            self.shape_run(text, &run, false, px, &mut pen, &mut glyphs);
            return (glyphs, pen);
        }
        self.load_fallbacks(text);
        let bidi = ParagraphBidiInfo::new(text, None);
        let (levels, visual) = bidi.visual_runs(0..text.len());
        for range in visual {
            let rtl = levels[range.start].is_rtl();
            // Right-to-left text draws paired punctuation mirrored.
            let part: String = if rtl {
                text[range]
                    .chars()
                    .map(|c| c.mirror().unwrap_or(c))
                    .collect()
            } else {
                text[range].to_owned()
            };
            let mut runs = split_runs(&part, |cluster| self.font_of(cluster).unwrap_or(0));
            if rtl {
                runs.reverse();
            }
            for run in runs {
                self.shape_run(&part, &run, rtl, px, &mut pen, &mut glyphs);
            }
        }
        (glyphs, pen)
    }

    fn shape_run(
        &mut self,
        text: &str,
        run: &Run,
        rtl: bool,
        px: f32,
        pen: &mut f32,
        out: &mut Vec<Placed>,
    ) {
        let direction = if rtl {
            Direction::RightToLeft
        } else {
            Direction::LeftToRight
        };
        let font = self.font(run.font);
        let mut shaper = self
            .shape
            .builder(font)
            .script(run.script)
            .direction(direction)
            .size(px)
            .build();
        shaper.add_str(&text[run.range.clone()]);
        let mut clusters = Vec::new();
        shaper.shape_with(|cluster| {
            let glyphs: Vec<_> = cluster
                .glyphs
                .iter()
                .map(|g| (g.id, g.x, g.y, g.advance))
                .collect();
            clusters.push(glyphs);
        });
        // The shaper keeps logical order; right-to-left text reverses whole
        // clusters, so marks keep their place.
        if rtl {
            clusters.reverse();
        }
        let tracking = if run.font == 0 { TRACKING * px } else { 0.0 };
        for (id, x, y, advance) in clusters.into_iter().flatten() {
            out.push(Placed {
                font: run.font,
                id,
                x: *pen + x,
                y,
            });
            *pen += advance + tracking;
        }
    }

    /// Looks up, with at most one scan of the host fonts, every character
    /// of `text` that the embedded font lacks, and its mirror, which a
    /// right-to-left run draws instead.
    fn load_fallbacks(&mut self, text: &str) {
        let charmap = self.font.charmap();
        let others: Vec<char> = text
            .chars()
            .flat_map(|c| [Some(c), c.mirror()])
            .flatten()
            .filter(|&c| charmap.map(c) == 0 && !ignorable(c))
            .collect();
        self.fallback.find_all(&others);
    }

    /// `text` with each run of characters that no font on the host can
    /// draw replaced by one ellipsis. A mark that the font of its cluster
    /// lacks counts as such a character, so it never draws as an empty box.
    /// The rest of its cluster goes into the ellipsis too, since a mark
    /// after it would attach to the ellipsis in a font that may lack it.
    pub fn displayable(&mut self, text: &str) -> String {
        self.load_fallbacks(text);
        let mut out = String::with_capacity(text.len());
        let mut missing = false;
        let mut chars = text.chars().peekable();
        while let Some(base) = chars.next() {
            let mut cluster = vec![base];
            while let Some(c) = chars.next_if(|&c| attaches(c)) {
                cluster.push(c);
            }
            let drawn: Vec<char> = cluster.iter().copied().filter(|&c| !ignorable(c)).collect();
            let font = (!drawn.is_empty())
                .then(|| self.font_of(&drawn))
                .flatten()
                .map(|i| self.font(i));
            let silent = |c: char| c.category() == Category::Format || ignorable(c);
            let draws = |c: char| silent(c) || font.is_some_and(|font| font.charmap().map(c) != 0);
            let kept = cluster.iter().take_while(|&&c| draws(c)).count();
            if kept > 0 {
                out.extend(&cluster[..kept]);
                missing = false;
            }
            if kept < cluster.len() && !missing {
                out.push_str(ELLIPSIS);
                missing = true;
            }
            // Characters after a lost mark that draw nothing stay, so a bidi
            // override or isolate still closes.
            out.extend(cluster[kept..].iter().filter(|&&c| silent(c)));
        }
        out
    }

    /// Advance width of `text` in pixels, with [`TRACKING`].
    pub fn width(&mut self, text: &str, px: f32) -> f32 {
        let (glyphs, pen) = self.layout(text, px);
        let trailing = match glyphs.last() {
            Some(last) if last.font == 0 => TRACKING * px,
            _ => 0.0,
        };
        (pen - trailing).max(0.0)
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
        let cap_id = self.font.charmap().map('H');
        let cap_top = self.glyph(0, cap_id, px).top;
        let baseline = (center_y + cap_top as f32 / 2.0).round() as i32;
        for placed in self.layout(text, px).0 {
            let glyph = self.glyph(placed.font, placed.id, px);
            canvas.mask(
                (x + placed.x).round() as i32 + glyph.left,
                baseline - glyph.top - placed.y.round() as i32,
                glyph.width,
                glyph.height,
                &glyph.coverage,
                color,
            );
        }
    }

    /// Whether the host font directories were scanned, for tests.
    #[cfg(test)]
    fn scanned(&self) -> bool {
        self.fallback.scanned()
    }
}

/// Checks that the embedded font loads and renders, for `--self-test`.
pub fn font_check() -> Result<(), String> {
    let font = load_font()?;
    let mut scale = ScaleContext::new();
    for c in ['C', 'S', 'F', '\u{d7}', '\u{2026}', '\u{e7}'] {
        let glyph = rasterize(&mut scale, font, font.charmap().map(c), 24.0);
        if glyph.width == 0 || glyph.coverage.iter().all(|&v| v == 0) {
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
    TakeControl,
    ReturnControl,
    /// Types the host clipboard text into the session.
    Paste,
    /// Take control in the attention banner.
    BannerTake,
}

/// Which buttons the bar shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BarKind {
    /// Fullscreen, Collapse and Close, with Take control when offered.
    Watch { take: bool },
    /// Return control, Paste and Fullscreen only.
    Control,
}

/// Where the bar and its buttons sit, in physical pixels.
#[derive(Debug, Clone, PartialEq)]
pub struct Bar {
    pub rect: Rect,
    pub buttons: Vec<(Button, Rect)>,
    pub fullscreen: bool,
    pub kind: BarKind,
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

fn label(button: Button, fullscreen: bool) -> &'static str {
    match button {
        Button::Fullscreen if fullscreen => "Exit fullscreen",
        Button::Fullscreen => "Fullscreen",
        Button::Collapse => "Collapse",
        Button::Close => "",
        Button::TakeControl | Button::BannerTake => "Take control",
        Button::ReturnControl => "Return control",
        Button::Paste => "Paste",
    }
}

fn label_width(text: &mut Text, metrics: Metrics, button: Button, fullscreen: bool) -> u32 {
    let pad = metrics.px(12.0);
    (text.width(label(button, fullscreen), metrics.font_px()) + 2.0 * pad).ceil() as u32
}

impl Bar {
    pub fn layout(
        width: u32,
        metrics: Metrics,
        fullscreen: bool,
        kind: BarKind,
        text: &mut Text,
    ) -> Bar {
        let rect = Rect::new(0, 0, width, metrics.bar_height());
        let button_h = metrics.round(24.0);
        let gap = metrics.round(4.0) as i32;
        let top = ((rect.h - button_h) / 2) as i32;
        let (left, right): (&[Button], &[Button]) = match kind {
            BarKind::Watch { take: true } => (
                &[Button::TakeControl],
                &[Button::Close, Button::Collapse, Button::Fullscreen],
            ),
            BarKind::Watch { take: false } => {
                (&[], &[Button::Close, Button::Collapse, Button::Fullscreen])
            }
            BarKind::Control => (
                &[Button::ReturnControl, Button::Paste],
                &[Button::Fullscreen],
            ),
        };
        let width_of = |button: Button, text: &mut Text| match button {
            Button::Close => button_h,
            _ => label_width(text, metrics, button, fullscreen),
        };
        let mut x = gap;
        let mut lefts = Vec::new();
        for &button in left {
            let w = width_of(button, text);
            lefts.push((button, Rect::new(x, top, w, button_h)));
            x += w as i32 + gap;
        }
        let mut x = width as i32 - gap;
        let mut rights = Vec::new();
        for &button in right {
            let w = width_of(button, text);
            x -= w as i32;
            rights.push((button, Rect::new(x, top, w, button_h)));
            x -= gap;
        }
        rights.reverse();
        // A narrow bar keeps Return control and Close. In the control bar
        // Fullscreen gives way first, then Paste; in the watch bar Take
        // control gives way.
        let fits = |lefts: &[(Button, Rect)], rights: &[(Button, Rect)]| {
            let limit = rights
                .first()
                .map_or(width as i32 - gap, |(_, first)| first.x - gap);
            lefts.last().is_none_or(|(_, last)| last.right() <= limit)
        };
        if kind == BarKind::Control {
            if !fits(&lefts, &rights) {
                rights.clear();
            }
            if !fits(&lefts, &rights) {
                lefts.truncate(1);
            }
        } else if !fits(&lefts, &rights) {
            lefts.clear();
        }
        let mut buttons = lefts;
        buttons.extend(rights);
        Bar {
            rect,
            buttons,
            fullscreen,
            kind,
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
        let bottom = Rect::new(0, self.rect.bottom() - line as i32, self.rect.w, line);
        if self.kind == BarKind::Control {
            canvas.fill(bottom, palette::EMBER);
        } else {
            canvas.blend_fill(bottom, palette::WHITE, palette::HAIRLINE);
        }
        let font = metrics.font_px();
        for &(button, r) in &self.buttons {
            let color = if button == Button::ReturnControl {
                draw_ember_outline(canvas, metrics, button, r, hover, pressed)
            } else {
                draw_button_background(canvas, metrics, button, r, hover, pressed)
            };
            let cx = r.x as f32 + r.w as f32 / 2.0;
            let cy = r.y as f32 + r.h as f32 / 2.0;
            if button == Button::Close {
                let arm = metrics.px(4.5);
                let stroke = metrics.px(1.5);
                canvas.line((cx - arm, cy - arm), (cx + arm, cy + arm), stroke, color);
                canvas.line((cx - arm, cy + arm), (cx + arm, cy - arm), stroke, color);
            } else {
                let label = label(button, self.fullscreen);
                let w = text.width(label, font);
                text.draw(canvas, label, (cx - w / 2.0).round(), cy, font, color);
            }
        }
    }
}

fn draw_button_background(
    canvas: &mut Canvas,
    metrics: Metrics,
    button: Button,
    r: Rect,
    hover: Option<Button>,
    pressed: Option<Button>,
) -> u32 {
    let radius = metrics.px(6.0);
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
    if hover == Some(button) || is_pressed {
        palette::TEXT
    } else {
        blend(palette::TEXT, palette::SURFACE_1, 40)
    }
}

/// Return control: an ember outline and ember text, brighter on hover.
fn draw_ember_outline(
    canvas: &mut Canvas,
    metrics: Metrics,
    button: Button,
    r: Rect,
    hover: Option<Button>,
    pressed: Option<Button>,
) -> u32 {
    let radius = metrics.px(6.0);
    let active = hover == Some(button) || pressed == Some(button);
    if active {
        canvas.rounded(r, radius, palette::EMBER, 40);
    }
    canvas.rounded_outline(r, radius, metrics.px(1.0), palette::EMBER, 200);
    palette::EMBER
}

/// The most message lines the banner shows. The last one ends with an
/// ellipsis when the message is longer.
pub const BANNER_LINES: usize = 3;
const ELLIPSIS: &str = "\u{2026}";

/// Wraps `message` into at most `max_lines` lines no wider than `max_w`
/// by `measure`. Words wider than a line break between clusters.
pub fn wrap(
    message: &str,
    max_w: f32,
    max_lines: usize,
    mut measure: impl FnMut(&str) -> f32,
) -> Vec<String> {
    let mut wrapper = Wrapper {
        lines: Vec::new(),
        line: String::new(),
        max_w,
        max_lines,
    };
    let truncated = message
        .split_whitespace()
        .any(|word| !wrapper.add_word(word, &mut measure));
    let mut lines = wrapper.finish();
    if truncated {
        ellipsize(&mut lines, max_w, &mut measure);
    }
    lines
}

struct Wrapper {
    lines: Vec<String>,
    line: String,
    max_w: f32,
    max_lines: usize,
}

impl Wrapper {
    /// Adds `word`. Returns false when no line is left for the rest.
    fn add_word(&mut self, word: &str, measure: &mut impl FnMut(&str) -> f32) -> bool {
        let mut rest = word;
        while !rest.is_empty() {
            let joined = if self.line.is_empty() {
                rest.to_owned()
            } else {
                format!("{} {rest}", self.line)
            };
            if measure(&joined) <= self.max_w {
                self.line = joined;
                return true;
            }
            if self.line.is_empty() {
                // One word wider than the line: take what fits, at least
                // one character.
                let end = fitting_prefix(rest, self.max_w, measure);
                self.line = rest[..end].to_owned();
                rest = &rest[end..];
                if rest.is_empty() {
                    return true;
                }
            }
            if !self.break_line() {
                return false;
            }
        }
        true
    }

    /// Starts a new line. Returns false when the current line is the last.
    fn break_line(&mut self) -> bool {
        if self.lines.len() + 1 == self.max_lines {
            return false;
        }
        self.lines.push(std::mem::take(&mut self.line));
        true
    }

    fn finish(mut self) -> Vec<String> {
        if !self.line.is_empty() {
            self.lines.push(self.line);
        }
        self.lines
    }
}

/// The byte length of the longest prefix of `word` within `max_w`, at
/// least one cluster. It never ends between a character and its marks.
fn fitting_prefix(word: &str, max_w: f32, measure: &mut impl FnMut(&str) -> f32) -> usize {
    let mut ends = word
        .char_indices()
        .skip(1)
        .filter(|&(_, c)| !attaches(c))
        .map(|(i, _)| i)
        .chain([word.len()]);
    let mut end = ends.next().unwrap_or(0);
    for next in ends {
        if measure(&word[..next]) > max_w {
            break;
        }
        end = next;
    }
    end
}

/// Ends the last line with an ellipsis, trimmed to fit `max_w`.
fn ellipsize(lines: &mut [String], max_w: f32, measure: &mut impl FnMut(&str) -> f32) {
    let Some(last) = lines.last_mut() else {
        return;
    };
    while !last.is_empty() && measure(&format!("{last}{ELLIPSIS}")) > max_w {
        // Drop the last cluster whole, so no character loses its marks.
        while last.pop().is_some_and(attaches) {}
    }
    let trimmed = last.trim_end().len();
    last.truncate(trimmed);
    last.push_str(ELLIPSIS);
}

/// The attention banner: the host's message and, when control can be
/// taken, a highlighted Take control button.
#[derive(Debug, Clone, PartialEq)]
pub struct Banner {
    pub rect: Rect,
    pub lines: Vec<String>,
    /// Where each line's cap height is centered.
    pub line_y: Vec<f32>,
    pub text_x: f32,
    pub button: Option<Rect>,
}

impl Banner {
    /// Lays the banner out at the top of `area`, inside it.
    pub fn layout(
        area: Rect,
        message: &str,
        metrics: Metrics,
        with_button: bool,
        text: &mut Text,
    ) -> Option<Banner> {
        let margin = metrics.round(8.0) as i32;
        let pad = metrics.round(10.0) as i32;
        let gap = metrics.round(10.0) as i32;
        let line_h = metrics.round(18.0) as i32;
        let font = metrics.font_px();
        let outer = Rect::new(
            area.x + margin,
            area.y + margin,
            area.w.saturating_sub(2 * margin as u32),
            area.h.saturating_sub(2 * margin as u32),
        );
        let inner_w = outer.w as i32 - 2 * pad;
        if inner_w <= 0 || outer.h as i32 <= 2 * pad + line_h {
            return None;
        }
        let button_w = label_width(text, metrics, Button::BannerTake, false) as i32;
        let button_h = metrics.round(24.0) as i32;
        let beside = with_button && inner_w - button_w - gap >= metrics.round(140.0) as i32;
        let text_w = if beside {
            inner_w - button_w - gap
        } else {
            inner_w
        };
        let below = if with_button && !beside {
            gap + button_h
        } else {
            0
        };
        // Fewer lines when the area is short, so the banner stays inside.
        let room = (outer.h as i32 - 2 * pad - below) / line_h;
        let max_lines = room.clamp(1, BANNER_LINES as i32) as usize;
        let message = text.displayable(message);
        let lines = wrap(&message, text_w as f32, max_lines, |s| text.width(s, font));
        let text_h = lines.len().max(1) as i32 * line_h;
        let body = if beside { text_h.max(button_h) } else { text_h };
        let h = (2 * pad + body + below).min(outer.h as i32);
        let rect = Rect::new(outer.x, outer.y, outer.w, h as u32);
        let text_top = rect.y + pad + (body - text_h) / 2;
        let line_y = (0..lines.len())
            .map(|i| text_top as f32 + (i as i32 * line_h) as f32 + line_h as f32 / 2.0)
            .collect();
        let button = with_button.then(|| {
            let (x, y) = if beside {
                (
                    rect.right() - pad - button_w,
                    rect.y + pad + (body - button_h) / 2,
                )
            } else {
                (rect.right() - pad - button_w, rect.y + pad + text_h + gap)
            };
            Rect::new(x.max(rect.x + pad), y, button_w as u32, button_h as u32)
        });
        Some(Banner {
            rect,
            lines,
            line_y,
            text_x: (rect.x + pad) as f32,
            button,
        })
    }

    pub fn hit(&self, px: f64, py: f64) -> Option<Button> {
        self.button
            .filter(|r| r.contains(px, py))
            .map(|_| Button::BannerTake)
    }

    pub fn draw(
        &self,
        canvas: &mut Canvas,
        metrics: Metrics,
        text: &mut Text,
        hover: Option<Button>,
        pressed: Option<Button>,
    ) {
        let radius = metrics.px(8.0);
        let clip = canvas.clip;
        canvas.clip = clip.intersect(&self.rect);
        canvas.rounded(self.rect, radius, palette::SURFACE_1, 244);
        canvas.rounded_outline(self.rect, radius, metrics.px(1.0), palette::EMBER, 160);
        let font = metrics.font_px();
        for (line, &y) in self.lines.iter().zip(&self.line_y) {
            text.draw(canvas, line, self.text_x, y, font, palette::TEXT);
        }
        if let Some(r) = self.button {
            let button = Button::BannerTake;
            let r_radius = metrics.px(6.0);
            canvas.rounded(r, r_radius, palette::EMBER, 255);
            if pressed == Some(button) && hover == Some(button) {
                canvas.rounded(r, r_radius, palette::SURFACE, 48);
            } else if hover == Some(button) {
                canvas.rounded(r, r_radius, palette::WHITE, 40);
            }
            let label = label(button, false);
            let w = text.width(label, font);
            let cx = r.x as f32 + r.w as f32 / 2.0;
            let cy = r.y as f32 + r.h as f32 / 2.0;
            text.draw(
                canvas,
                label,
                (cx - w / 2.0).round(),
                cy,
                font,
                palette::SURFACE,
            );
        }
        canvas.clip = clip;
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

/// The session label pill in the top-left corner of `area`, with the text
/// cut to fit and ending in an ellipsis. `None` when the area is too small
/// for it beside the status pill.
pub fn session_label(
    area: Rect,
    label: &str,
    metrics: Metrics,
    text: &mut Text,
) -> Option<(Rect, String)> {
    let font = metrics.font_px();
    let pad = metrics.px(10.0);
    let h = metrics.round(24.0);
    let margin = metrics.round(8.0) as i32;
    if (area.h as i32) < 2 * (h as i32 + margin) + margin {
        return None;
    }
    let max_w = area.w as f32 - 2.0 * margin as f32 - 2.0 * pad;
    if max_w < text.width(&format!("M{ELLIPSIS}"), font) {
        return None;
    }
    let fitted = fit_line(label, max_w, |s| text.width(s, font));
    let w = (text.width(&fitted, font) + 2.0 * pad).ceil() as u32;
    Some((Rect::new(area.x + margin, area.y + margin, w, h), fitted))
}

/// `line` as is when it fits `max_w`, otherwise cut to end in an ellipsis.
pub fn fit_line(line: &str, max_w: f32, mut measure: impl FnMut(&str) -> f32) -> String {
    if measure(line) <= max_w {
        return line.to_owned();
    }
    let mut lines = [line.to_owned()];
    ellipsize(&mut lines, max_w, &mut measure);
    let [fitted] = lines;
    fitted
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
            let bar = Bar::layout(
                width,
                metrics,
                false,
                BarKind::Watch { take: false },
                &mut text,
            );
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

    fn assert_in_order(buttons: &[(Button, Rect)], width: u32) {
        let mut last = 0;
        for (_, r) in buttons {
            assert!(r.x >= last && r.right() <= width as i32, "{buttons:?}");
            last = r.right();
        }
    }

    #[test]
    fn control_bars_show_the_right_buttons() {
        let mut text = Text::new();
        let names = |bar: &Bar| bar.buttons.iter().map(|(b, _)| *b).collect::<Vec<_>>();
        for scale in [1.0, 2.0] {
            let metrics = Metrics { scale };
            let width = (640.0 * scale) as u32;
            let watch = Bar::layout(
                width,
                metrics,
                false,
                BarKind::Watch { take: true },
                &mut text,
            );
            assert_eq!(
                names(&watch),
                vec![
                    Button::TakeControl,
                    Button::Fullscreen,
                    Button::Collapse,
                    Button::Close
                ]
            );
            assert_in_order(&watch.buttons, width);
            let control = Bar::layout(width, metrics, true, BarKind::Control, &mut text);
            assert_eq!(
                names(&control),
                vec![Button::ReturnControl, Button::Paste, Button::Fullscreen]
            );
            assert_in_order(&control.buttons, width);
            // Paste sits directly right of Return control.
            let gap = metrics.round(4.0) as i32;
            assert_eq!(control.buttons[1].1.x, control.buttons[0].1.right() + gap);
            // A narrow bar drops Fullscreen first, then Paste, and always
            // keeps Return control.
            let mut seen = Vec::new();
            for logical in (60..=640).step_by(4) {
                let narrow = (logical as f64 * scale) as u32;
                let control = Bar::layout(narrow, metrics, true, BarKind::Control, &mut text);
                let shown = names(&control);
                assert_eq!(shown[0], Button::ReturnControl, "{logical}");
                if shown.contains(&Button::Fullscreen) {
                    assert!(shown.contains(&Button::Paste), "{logical}: {shown:?}");
                }
                if shown.len() > 1 {
                    assert_in_order(&control.buttons, narrow);
                }
                if !seen.contains(&shown) {
                    seen.push(shown);
                }
            }
            assert_eq!(
                seen,
                vec![
                    vec![Button::ReturnControl],
                    vec![Button::ReturnControl, Button::Paste],
                    vec![Button::ReturnControl, Button::Paste, Button::Fullscreen],
                ]
            );
            let narrow = (200.0 * scale) as u32;
            let watch = Bar::layout(
                narrow,
                metrics,
                false,
                BarKind::Watch { take: true },
                &mut text,
            );
            assert!(!names(&watch).contains(&Button::TakeControl));
            assert!(names(&watch).contains(&Button::Close));
            for take in [true, false] {
                let watch = Bar::layout(width, metrics, false, BarKind::Watch { take }, &mut text);
                assert!(!names(&watch).contains(&Button::Paste), "no Paste in watch");
            }
        }
    }

    #[test]
    fn wrap_breaks_words_and_truncates() {
        let measure = |s: &str| s.chars().count() as f32;
        assert_eq!(
            wrap("one two three", 7.0, 3, measure),
            vec!["one two", "three"]
        );
        assert_eq!(wrap("  ", 7.0, 3, measure), Vec::<String>::new());
        assert_eq!(
            wrap("abcdefghij", 4.0, 3, measure),
            vec!["abcd", "efgh", "ij"]
        );
        assert_eq!(
            wrap("abcdefghijklmnop", 4.0, 3, measure),
            vec!["abcd", "efgh", "ijk\u{2026}"]
        );
        let lines = wrap("aa bb cc dd ee ff", 5.0, 2, measure);
        assert_eq!(lines, vec!["aa bb", "cc d\u{2026}"]);
        let long = "palavra ".repeat(200);
        for width in [1.0, 3.0, 20.0] {
            let lines = wrap(&long, width, 3, measure);
            assert!(lines.len() <= 3);
            assert!(lines.last().unwrap().ends_with('\u{2026}'));
        }
    }

    #[test]
    fn wrap_keeps_marks_with_their_character() {
        let measure = |s: &str| s.chars().count() as f32;
        // Words wider than the line, each character followed by a mark.
        for word in ["\u{65e5}\u{1ab0}".repeat(12), "e\u{301}".repeat(12)] {
            let lines = wrap(&word, 3.0, 20, measure);
            assert_eq!(lines.concat(), word);
            for line in &lines {
                assert!(!line.starts_with(attaches), "{line:?} starts with a mark");
            }
        }
        // Truncation drops whole clusters too.
        assert_eq!(
            wrap(&"e\u{301}".repeat(6), 4.0, 2, measure),
            vec!["e\u{301}e\u{301}", "e\u{301}\u{2026}"]
        );
    }

    /// Whether a host font draws `c`; tests that need one skip without it.
    fn host_has(c: char) -> bool {
        let found = Fallback::default().find(c).is_some();
        if !found {
            eprintln!("skipped: no host font draws {c:?}");
        }
        found
    }

    #[test]
    fn uncovered_clusters_scan_host_fonts_once() {
        let dir = std::env::temp_dir().join(format!("pickforge-clusters-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("copy.ttf"), FONT).unwrap();
        let mut text = Text {
            fallback: Fallback::from_dir(&dir),
            ..Text::new()
        };
        // Distinct clusters with a mark that no font draws, on Latin bases
        // and on distinct bases that no font draws either.
        let message: String = ('a'..='z')
            .chain('A'..='Z')
            .chain('\u{e000}'..='\u{e033}')
            .flat_map(|c| [c, '\u{1ab0}'])
            .collect();
        assert!(text.width(&message, 12.0) > 0.0);
        assert!(
            text.fallback.scans() <= 1,
            "{} scans",
            text.fallback.scans()
        );
        // A right-to-left run draws mirrored characters the text lacks.
        let before = text.fallback.scans();
        assert!(text.width("\u{202e}\u{2208}\u{2209}\u{220a}\u{202c}", 12.0) > 0.0);
        assert!(
            text.fallback.scans() - before <= 1,
            "{} scans for one right-to-left text",
            text.fallback.scans() - before
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn displayable_marks_text_no_font_can_draw() {
        let mut text = Text::new();
        let latin = "desk-1 \u{b7} A\u{e7}\u{e3}o \u{41f}\u{440}\u{438}\u{432}\u{435}\u{442}";
        assert_eq!(text.displayable(latin), latin);
        assert!(!text.scanned(), "Latin text scans no host fonts");
        // Unassigned code points, which no font maps.
        assert_eq!(
            text.displayable("desk-1 \u{b7} \u{378}\u{379}"),
            "desk-1 \u{b7} \u{2026}"
        );
        assert_eq!(text.displayable("app-\u{378}\u{379}-x"), "app-\u{2026}-x");
        assert!(text.scanned());
        for sample in [
            "app-\u{65e5}\u{672c}-x",
            "\u{645}\u{631}\u{62d}\u{628}\u{627}",
        ] {
            if sample.chars().all(|c| c.is_ascii() || host_has(c)) {
                assert_eq!(text.displayable(sample), sample);
            }
        }
    }

    #[test]
    fn displayable_never_leaves_a_mark_its_font_lacks() {
        let dir = std::env::temp_dir().join(format!("pickforge-marks-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut text = Text {
            fallback: Fallback::from_dir(&dir),
            ..Text::new()
        };
        // A character no font draws takes its marks into the ellipsis.
        assert_eq!(text.displayable("a\u{378}\u{301}b"), "a\u{2026}b");
        assert_eq!(text.displayable("a\u{1ab0}b"), "a\u{2026}b");
        // A mark after the lost one goes too, or it would mark the ellipsis.
        assert_eq!(text.displayable("e\u{1ab0}\u{301}x"), "e\u{2026}x");
        assert_eq!(text.displayable("e\u{301}"), "e\u{301}");
        // A bidi control after the lost mark stays, so the isolate closes.
        assert_eq!(
            text.displayable("\u{2067}e\u{1ab0}\u{2069} rest"),
            "\u{2067}e\u{2026}\u{2069} rest"
        );
        std::fs::remove_dir_all(&dir).unwrap();
        // Host fonts may draw the mark only apart from its ideograph.
        let mut text = Text::new();
        for sample in [
            "\u{65e5}\u{1ab0}\u{672c}\u{1ab0}",
            "\u{e01}\u{1ab0}\u{e31}",
            "\u{628}\u{1ab0}\u{64e}",
        ] {
            if sample.chars().all(host_has) {
                let shown = text.displayable(sample);
                let ids = glyph_ids(&mut text, &shown);
                assert!(ids.iter().all(|&(_, id)| id != 0), "{shown:?} draws a box");
                assert!(shown.starts_with(sample.chars().next().unwrap()));
            }
        }
    }

    #[test]
    fn latin_text_never_scans_host_fonts() {
        let mut text = Text::new();
        let mut buf = vec![0u32; 200 * 40];
        let mut canvas = Canvas::new(&mut buf, 200, 40, Rect::new(0, 0, 200, 40));
        let latin = "Entre com a sua senha, \u{e9} r\u{e1}pido \u{2026} \u{d7}";
        assert!(text.width(latin, 12.0) > 0.0);
        text.draw(&mut canvas, latin, 0.0, 20.0, 12.0, palette::TEXT);
        assert!(!text.scanned());
    }

    #[test]
    fn coverage_needs_outlines_and_the_character() {
        let geist = load_font().unwrap();
        assert!(crate::fallback::covers(geist, 'A'));
        assert!(!crate::fallback::covers(geist, '\u{65e5}'));
        assert!(!crate::fallback::covers(geist, '\u{378}'));
    }

    #[test]
    fn runs_split_by_font_and_script() {
        // Font 0 for Latin and common characters, 1 for Arabic, 2 for Han.
        let font_of = |c: char| match c as u32 {
            0x600..=0x6ff => 1,
            0x4e00..=0x9fff => 2,
            _ => 0,
        };
        fn runs(text: &str, font_of: impl Fn(char) -> usize) -> Vec<(&str, usize, Script)> {
            split_runs(text, |cluster| font_of(cluster[0]))
                .into_iter()
                .map(|r| (&text[r.range], r.font, r.script))
                .collect()
        }
        assert_eq!(runs("", font_of), vec![]);
        assert_eq!(
            runs("desk-1 \u{b7} app", font_of),
            vec![("desk-1 \u{b7} app", 0, Script::Latin)]
        );
        let salam = "\u{633}\u{644}\u{627}\u{645}";
        assert_eq!(
            runs(&format!("Hi {salam}!"), font_of),
            vec![
                ("Hi ", 0, Script::Latin),
                (salam, 1, Script::Arabic),
                ("!", 0, Script::Arabic),
            ]
        );
        // A space between Arabic words keeps the Arabic script, and a
        // vowel mark stays on its letter.
        let ba = "\u{628}\u{64e}";
        assert_eq!(
            runs(&format!("{ba} {salam}"), font_of),
            vec![
                (ba, 1, Script::Arabic),
                (" ", 0, Script::Arabic),
                (salam, 1, Script::Arabic),
            ]
        );
        // Leading digits take the first script found.
        assert_eq!(
            runs("12 \u{65e5}\u{672c}", font_of),
            vec![
                ("12 ", 0, Script::Han),
                ("\u{65e5}\u{672c}", 2, Script::Han)
            ]
        );
        assert_eq!(
            runs("e\u{301}x", font_of),
            vec![("e\u{301}x", 0, Script::Latin)]
        );
    }

    /// Glyph ids of `text` in visual order, with their fonts.
    fn glyph_ids(text: &mut Text, s: &str) -> Vec<(usize, GlyphId)> {
        text.layout(s, 12.0)
            .0
            .iter()
            .map(|p| (p.font, p.id))
            .collect()
    }

    #[test]
    fn right_to_left_text_reads_right_to_left() {
        let mut text = Text::new();
        let (alef, bet) = ('\u{5d0}', '\u{5d1}');
        if host_has(alef) {
            let index = text.font_of(&[alef]).unwrap();
            let font = text.font(index);
            let ids = glyph_ids(&mut text, &format!("{alef}{bet}"));
            let nominal: Vec<_> = [bet, alef].map(|c| font.charmap().map(c)).into();
            assert_eq!(ids.iter().map(|&(_, id)| id).collect::<Vec<_>>(), nominal);
            assert!(ids.iter().all(|&(font, _)| font > 0));
        }
        let (ba, ta) = ("\u{628}", "\u{62a}");
        if host_has('\u{628}') {
            let alone = |text: &mut Text, s: &str| glyph_ids(text, s);
            let space = glyph_ids(&mut text, " ");
            // Apart, each letter keeps its isolated form, last letter first.
            let want = [alone(&mut text, ta), space, alone(&mut text, ba)].concat();
            assert_eq!(glyph_ids(&mut text, &format!("{ba} {ta}")), want);
            // Joined, the letters take other forms.
            let joined = glyph_ids(&mut text, &format!("{ba}{ta}"));
            let apart = [alone(&mut text, ta), alone(&mut text, ba)].concat();
            assert_ne!(joined, apart, "joined forms");
            // Latin before Arabic stays on the left.
            let want = [glyph_ids(&mut text, "ab "), want].concat();
            assert_eq!(glyph_ids(&mut text, &format!("ab {ba} {ta}")), want);
        }
    }

    #[test]
    fn fallback_text_draws_ink() {
        let mut text = Text::new();
        for sample in [
            "\u{65e5}\u{672c}\u{8a9e}",
            "\u{645}\u{631}\u{62d}\u{628}\u{627}",
        ] {
            if !sample.chars().all(host_has) {
                continue;
            }
            let mut buf = vec![0u32; 120 * 40];
            let mut canvas = Canvas::new(&mut buf, 120, 40, Rect::new(0, 0, 120, 40));
            let w = text.width(sample, 12.0);
            assert!(w > 12.0, "{sample}: {w}");
            text.draw(&mut canvas, sample, 4.0, 20.0, 12.0, palette::WHITE);
            let ink = buf.iter().filter(|&&p| p & 0xff > 128).count();
            assert!(ink > 30, "{sample}: {ink} ink pixels");
        }
    }

    #[test]
    fn right_to_left_text_mirrors_brackets() {
        let mut text = Text::new();
        let geist = load_font().unwrap().charmap();
        for (open, word, close) in [
            ('(', "\u{645}\u{631}\u{62d}\u{628}\u{627}", ')'),
            ('[', "\u{5d0}\u{5d1}\u{5d2}", ']'),
        ] {
            if !word.chars().all(host_has) {
                continue;
            }
            let ids = glyph_ids(&mut text, &format!("{open}{word}{close}"));
            assert_eq!(ids.first(), Some(&(0, geist.map(open))), "{word}");
            assert_eq!(ids.last(), Some(&(0, geist.map(close))), "{word}");
        }
    }

    #[test]
    fn marks_take_a_font_that_draws_them() {
        let mut text = Text::new();
        let geist = load_font().unwrap();
        // A combining arrow above, which the embedded font lacks.
        assert!(!crate::fallback::covers(geist, '\u{20d7}'));
        if host_has('\u{20d7}') {
            let ids = glyph_ids(&mut text, "a\u{20d7}");
            assert!(ids.iter().all(|&(font, id)| font > 0 && id != 0), "{ids:?}");
        }
        // Marks the embedded font has stay with it.
        assert!(glyph_ids(&mut text, "e\u{301}x")
            .iter()
            .all(|&(font, id)| font == 0 && id != 0));
    }

    #[test]
    fn ignorable_code_points_are_not_missing_text() {
        let mut text = Text::new();
        let geist = load_font().unwrap().charmap();
        let quiet = "Pay\u{ad}ment\u{200b} now\u{fe0f}\u{2060}";
        assert!(geist.map('\u{fe0f}') == 0);
        assert_eq!(text.displayable(quiet), quiet);
        assert!(text.width(quiet, 12.0) > 0.0);
        assert!(!text.scanned(), "ignorable code points scan no host fonts");
        let warning = text.displayable("\u{26a0}\u{fe0f} Approve payment");
        assert!(warning.ends_with("\u{fe0f} Approve payment"), "{warning}");
    }

    #[test]
    fn attention_bidi_controls_keep_logical_order() {
        use crate::protocol::{parse_command, Command};
        let line = r#"{"cmd":"attention","message":"Pay \u202eto: Alice"}"#;
        let Ok(Command::Attention { message }) = parse_command(line.as_bytes()) else {
            panic!("attention parses");
        };
        let mut text = Text::new();
        assert_eq!(
            glyph_ids(&mut text, &message),
            glyph_ids(&mut text, "Pay to: Alice")
        );
    }

    #[test]
    fn fit_line_keeps_short_text_and_cuts_long_text() {
        let measure = |s: &str| s.chars().count() as f32;
        assert_eq!(
            fit_line("desk-1 \u{b7} app", 20.0, measure),
            "desk-1 \u{b7} app"
        );
        assert_eq!(
            fit_line("desk-1 \u{b7} app", 14.0, measure),
            "desk-1 \u{b7} app"
        );
        assert_eq!(
            fit_line("desk-1 \u{b7} application", 12.0, measure),
            "desk-1 \u{b7} ap\u{2026}"
        );
        assert_eq!(
            fit_line("desk-1 \u{b7} ação", 11.0, measure),
            "desk-1 \u{b7} a\u{2026}"
        );
    }

    #[test]
    fn session_label_fits_the_thumbnail() {
        let mut text = Text::new();
        let long = format!(
            "desk-1a2b3c \u{b7} {}",
            "very-long-project-folder-name-".repeat(10)
        );
        for scale in [1.0, 1.25, 2.0] {
            let metrics = Metrics { scale };
            let font = metrics.font_px();
            let area = Rect::new(0, 0, (384.0 * scale) as u32, (240.0 * scale) as u32);
            let (rect, fitted) = session_label(area, &long, metrics, &mut text).unwrap();
            assert_eq!(rect.intersect(&area), rect, "{scale}");
            assert!(fitted.starts_with("desk-1a2b3c \u{b7} very"), "{fitted}");
            assert!(fitted.ends_with('\u{2026}'), "{fitted}");
            assert!(text.width(&fitted, font) <= rect.w as f32);
            let status = status_rect(area, "Live", metrics, &mut text);
            assert!(rect.bottom() < status.y, "{scale}");
            let (_, short) = session_label(area, "desk-1 \u{b7} app", metrics, &mut text).unwrap();
            assert_eq!(short, "desk-1 \u{b7} app");
        }
        let metrics = Metrics { scale: 1.0 };
        assert!(session_label(Rect::new(0, 0, 384, 60), &long, metrics, &mut text).is_none());
        assert!(session_label(Rect::new(0, 0, 30, 240), &long, metrics, &mut text).is_none());
    }

    #[test]
    fn banner_stays_inside_its_area() {
        let mut text = Text::new();
        let long = "Por favor entre com a sua senha do banco e confirme o código ".repeat(8);
        let message: String = long.chars().take(500).collect();
        for scale in [1.0, 1.25, 2.0] {
            let metrics = Metrics { scale };
            let font = metrics.font_px();
            for (w, h, button) in [
                (640, 480, true),
                (384, 288, false),
                (220, 160, true),
                (640, 60, true),
            ] {
                let area = Rect::new(
                    0,
                    metrics.bar_height() as i32,
                    (w as f64 * scale) as u32,
                    (h as f64 * scale) as u32,
                );
                let Some(banner) = Banner::layout(area, &message, metrics, button, &mut text)
                else {
                    assert!(h < 100, "{w}x{h}");
                    continue;
                };
                assert_eq!(banner.rect.intersect(&area), banner.rect, "{w}x{h}@{scale}");
                assert!(!banner.lines.is_empty() && banner.lines.len() <= BANNER_LINES);
                assert!(banner.lines.last().unwrap().ends_with('\u{2026}'));
                let last_line = *banner.line_y.last().unwrap();
                let right = match banner.button {
                    Some(b) if b.y as f32 <= last_line => b.x,
                    _ => banner.rect.right(),
                };
                for line in &banner.lines {
                    let end = banner.text_x + text.width(line, font);
                    assert!(
                        end <= right as f32 + 0.5 || !button,
                        "{line:?} at {w}x{h}@{scale}"
                    );
                    assert!(end <= banner.rect.right() as f32);
                }
                if let Some(b) = banner.button {
                    assert_eq!(b.intersect(&banner.rect), b, "{w}x{h}@{scale}");
                    assert_eq!(
                        banner.hit(b.x as f64 + 1.0, b.y as f64 + 1.0),
                        Some(Button::BannerTake)
                    );
                }
                assert_eq!(banner.button.is_some(), button);
            }
        }
        let area = Rect::new(0, 32, 640, 448);
        let short = Banner::layout(
            area,
            "Sign in, please",
            Metrics { scale: 1.0 },
            true,
            &mut text,
        )
        .unwrap();
        assert_eq!(short.lines, vec!["Sign in, please"]);
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
