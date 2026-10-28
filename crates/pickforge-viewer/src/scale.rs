//! Separable image scaling on `0x00RRGGBB` pixels.
//!
//! Each axis gets a tap table with integer weights. A shrinking axis uses
//! area averaging: every source pixel contributes by its exact overlap with
//! the destination pixel. A growing axis uses bilinear filtering on pixel
//! centers. An axis of equal size is the identity. Only the destination rows
//! that a dirty source band touches are recomputed.

use std::ops::Range;

/// Destination rows computed per batch. It bounds the scratch buffer.
const ROW_BATCH: u32 = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Taps {
    /// For destination pixel `i`, its taps are `starts[i]..starts[i + 1]`.
    starts: Vec<u32>,
    src: Vec<u32>,
    weight: Vec<u32>,
    /// The weights of every destination pixel add up to this.
    denom: u32,
}

impl Taps {
    fn new(src: u32, dst: u32) -> Self {
        let mut taps = Taps {
            starts: Vec::with_capacity(dst as usize + 1),
            src: Vec::new(),
            weight: Vec::new(),
            denom: 1,
        };
        taps.starts.push(0);
        if dst < src {
            taps.add_area(src, dst);
        } else if dst > src {
            taps.add_bilinear(src, dst);
        } else {
            taps.add_identity(dst);
        }
        taps
    }

    fn add_area(&mut self, src: u32, dst: u32) {
        // Destination pixel i covers [i * src, (i + 1) * src) and source
        // pixel j covers [j * dst, (j + 1) * dst), in units of 1/dst
        // source pixels.
        self.denom = src;
        let (src, dst) = (src as u64, dst as u64);
        for i in 0..dst {
            let lo = i * src;
            let hi = lo + src;
            for j in lo / dst..hi.div_ceil(dst) {
                let overlap = hi.min((j + 1) * dst) - lo.max(j * dst);
                if overlap > 0 {
                    self.src.push(j as u32);
                    self.weight.push(overlap as u32);
                }
            }
            self.starts.push(self.src.len() as u32);
        }
    }

    fn add_bilinear(&mut self, src: u32, dst: u32) {
        // Bilinear on pixel centers, in 1/256 steps.
        self.denom = 256;
        let (src, dst) = (src as i64, dst as i64);
        for i in 0..dst {
            let center = ((2 * i + 1) * src * 256 / (2 * dst) - 128).max(0);
            let j0 = (center >> 8).min(src - 1);
            let frac = if j0 == src - 1 {
                0
            } else {
                (center & 255) as u32
            };
            self.src.push(j0 as u32);
            self.weight.push(256 - frac);
            if frac > 0 {
                self.src.push(j0 as u32 + 1);
                self.weight.push(frac);
            }
            self.starts.push(self.src.len() as u32);
        }
    }

    fn add_identity(&mut self, dst: u32) {
        for i in 0..dst {
            self.src.push(i);
            self.weight.push(1);
            self.starts.push(self.src.len() as u32);
        }
    }

    fn range(&self, i: u32) -> Range<usize> {
        self.starts[i as usize] as usize..self.starts[i as usize + 1] as usize
    }

    fn first_src(&self, i: u32) -> u32 {
        self.src[self.starts[i as usize] as usize]
    }

    fn last_src(&self, i: u32) -> u32 {
        self.src[self.starts[i as usize + 1] as usize - 1]
    }
}

/// Scales a `src_w` by `src_h` image to `dst_w` by `dst_h`.
#[derive(Debug, Clone)]
pub struct Scaler {
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
    x: Taps,
    y: Taps,
    scratch: Vec<u32>,
}

impl Scaler {
    /// Every side must be at least 1.
    pub fn new(src_w: u32, src_h: u32, dst_w: u32, dst_h: u32) -> Self {
        assert!(
            src_w > 0 && src_h > 0 && dst_w > 0 && dst_h > 0,
            "empty scaler"
        );
        Self {
            src_w,
            src_h,
            dst_w,
            dst_h,
            x: Taps::new(src_w, dst_w),
            y: Taps::new(src_h, dst_h),
            scratch: Vec::new(),
        }
    }

    pub fn src_size(&self) -> (u32, u32) {
        (self.src_w, self.src_h)
    }

    pub fn dst_size(&self) -> (u32, u32) {
        (self.dst_w, self.dst_h)
    }

    /// The destination rows that read any source row in `src_rows`.
    pub fn dst_rows_for(&self, src_rows: Range<u32>) -> Range<u32> {
        if src_rows.start >= src_rows.end {
            return 0..0;
        }
        // Both tap bounds grow with the row, so binary search works.
        let start = partition_point(self.dst_h, |i| self.y.last_src(i) < src_rows.start);
        let end = partition_point(self.dst_h, |i| self.y.first_src(i) < src_rows.end);
        start..end.max(start)
    }

    /// Recomputes destination `rows` from `src` into `dst`. Strides are in
    /// pixels.
    pub fn scale_rows(
        &mut self,
        src: &[u32],
        src_stride: usize,
        dst: &mut [u32],
        dst_stride: usize,
        rows: Range<u32>,
    ) {
        let rows = rows.start.min(self.dst_h)..rows.end.min(self.dst_h);
        if rows.is_empty() {
            return;
        }
        let (sw, dw) = (self.src_w as usize, self.dst_w as usize);
        assert!(src_stride >= sw && dst_stride >= dw);
        assert!(src.len() >= (self.src_h as usize - 1) * src_stride + sw);
        assert!(dst.len() >= (rows.end as usize - 1) * dst_stride + dw);

        if self.src_w == self.dst_w && self.src_h == self.dst_h {
            for y in rows {
                let (s, d) = (y as usize * src_stride, y as usize * dst_stride);
                dst[d..d + dw].copy_from_slice(&src[s..s + sw]);
            }
            return;
        }

        let mut start = rows.start;
        while start < rows.end {
            let end = (start + ROW_BATCH).min(rows.end);
            let first = self.y.first_src(start);
            let last = self.y.last_src(end - 1);
            let band = (last - first + 1) as usize;

            self.scale_horizontal(src, src_stride, first, band);
            self.scale_vertical(dst, dst_stride, start..end, first);
            start = end;
        }
    }

    fn scale_horizontal(&mut self, src: &[u32], src_stride: usize, first: u32, band: usize) {
        let (sw, dw) = (self.src_w as usize, self.dst_w as usize);
        // Horizontal pass for every source row the batch reads.
        self.scratch.resize(band * dw * 3, 0);
        for r in 0..band {
            let line = &src[(first as usize + r) * src_stride..][..sw];
            let out = &mut self.scratch[r * dw * 3..][..dw * 3];
            for x in 0..dw {
                let (mut cr, mut cg, mut cb) = (0u32, 0u32, 0u32);
                for t in self.x.range(x as u32) {
                    let p = line[self.x.src[t] as usize];
                    let w = self.x.weight[t];
                    cr += ((p >> 16) & 0xff) * w;
                    cg += ((p >> 8) & 0xff) * w;
                    cb += (p & 0xff) * w;
                }
                out[x * 3] = cr;
                out[x * 3 + 1] = cg;
                out[x * 3 + 2] = cb;
            }
        }
    }

    fn scale_vertical(&self, dst: &mut [u32], dst_stride: usize, rows: Range<u32>, first: u32) {
        let dw = self.dst_w as usize;
        let denom = self.x.denom as u64 * self.y.denom as u64;
        let half = denom / 2;
        // Vertical pass.
        for y in rows {
            let taps = self.y.range(y);
            let out = &mut dst[y as usize * dst_stride..][..dw];
            for (x, pixel) in out.iter_mut().enumerate() {
                let (mut cr, mut cg, mut cb) = (0u64, 0u64, 0u64);
                for t in taps.clone() {
                    let row = (self.y.src[t] - first) as usize;
                    let w = self.y.weight[t] as u64;
                    let h = &self.scratch[(row * dw + x) * 3..][..3];
                    cr += h[0] as u64 * w;
                    cg += h[1] as u64 * w;
                    cb += h[2] as u64 * w;
                }
                let r = ((cr + half) / denom) as u32;
                let g = ((cg + half) / denom) as u32;
                let b = ((cb + half) / denom) as u32;
                *pixel = (r << 16) | (g << 8) | b;
            }
        }
    }

    /// Scales the whole image.
    pub fn scale_all(
        &mut self,
        src: &[u32],
        src_stride: usize,
        dst: &mut [u32],
        dst_stride: usize,
    ) {
        let h = self.dst_h;
        self.scale_rows(src, src_stride, dst, dst_stride, 0..h);
    }
}

/// The first `i` in `0..n` where `pred` turns false.
fn partition_point(n: u32, pred: impl Fn(u32) -> bool) -> u32 {
    let (mut lo, mut hi) = (0, n);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if pred(mid) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo
}

fn gray(v: u32) -> u32 {
    (v << 16) | (v << 8) | v
}

fn scaled(src: &[u32], sw: u32, sh: u32, dw: u32, dh: u32) -> Vec<u32> {
    let mut out = vec![0; (dw * dh) as usize];
    Scaler::new(sw, sh, dw, dh).scale_all(src, sw as usize, &mut out, dw as usize);
    out
}

fn expect(name: &str, got: &[u32], want: &[u32]) -> Result<(), String> {
    if got == want {
        Ok(())
    } else {
        Err(format!(
            "scaler golden {name}: got {got:06x?}, want {want:06x?}"
        ))
    }
}

/// Fixed input and output pairs. The unit tests and `--self-test` both run
/// them.
pub fn golden_checks() -> Result<(), String> {
    // 2x2 blocks average to their block color.
    let (a, b) = (0x00ff_0000, 0x0000_80ff);
    let checker = [a, a, b, b, a, a, b, b, b, b, a, a, b, b, a, a];
    expect("2x2 blocks", &scaled(&checker, 4, 4, 2, 2), &[a, b, b, a])?;

    // Halving a gray ramp averages pairs and rounds half up.
    let ramp = [gray(0), gray(255), gray(10), gray(20)];
    expect("halve", &scaled(&ramp, 4, 1, 2, 1), &[gray(128), gray(15)])?;

    // 3 to 2 weights the middle pixel by its overlap.
    let three = [gray(0), gray(90), gray(180)];
    expect(
        "3 to 2",
        &scaled(&three, 3, 1, 2, 1),
        &[gray(30), gray(150)],
    )?;

    // Bilinear upscale on pixel centers, clamped at the edges.
    let two = [gray(0), gray(200)];
    expect(
        "2 to 4",
        &scaled(&two, 2, 1, 4, 1),
        &[gray(0), gray(50), gray(150), gray(200)],
    )?;
    let column = [gray(0), gray(200)];
    expect(
        "column 2 to 4",
        &scaled(&column, 1, 2, 1, 4),
        &[gray(0), gray(50), gray(150), gray(200)],
    )?;

    // Equal sizes copy the image.
    let any = [
        0x0012_3456,
        0x00ab_cdef,
        0x0000_0001,
        0x00ff_ffff,
        0x0080_8080,
        0x0001_0203,
    ];
    expect("identity", &scaled(&any, 3, 2, 3, 2), &any)?;

    // A solid image stays exactly solid at any size.
    let solid = vec![0x00ff_7a1a; 37 * 23];
    for (dw, dh) in [(11, 7), (37, 23), (80, 50), (36, 23), (38, 22)] {
        let out = scaled(&solid, 37, 23, dw, dh);
        if out.iter().any(|&p| p != 0x00ff_7a1a) {
            return Err(format!("scaler golden solid {dw}x{dh}: color drifted"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn goldens() {
        golden_checks().unwrap();
    }

    #[test]
    fn area_weights_sum_to_denominator() {
        for (src, dst) in [(1280, 384), (7, 3), (1000, 999), (16384, 1), (3, 3), (2, 9)] {
            let taps = Taps::new(src, dst);
            for i in 0..dst {
                let sum: u32 = taps.range(i).map(|t| taps.weight[t]).sum();
                assert_eq!(sum, taps.denom, "{src}->{dst} pixel {i}");
                assert!(taps.range(i).all(|t| taps.src[t] < src));
            }
        }
    }

    fn pattern(w: u32, h: u32, seed: u32) -> Vec<u32> {
        let mut state = seed.wrapping_mul(2654435761).wrapping_add(1);
        (0..w * h)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                state & 0x00ff_ffff
            })
            .collect()
    }

    #[test]
    fn dirty_rows_match_a_full_rescale() {
        for (sw, sh, dw, dh) in [
            (640, 480, 384, 288),
            (640, 480, 1000, 750),
            (97, 61, 97, 61),
            (300, 200, 450, 120),
        ] {
            let mut src = pattern(sw, sh, 1);
            let mut scaler = Scaler::new(sw, sh, dw, dh);
            let mut partial = vec![0; (dw * dh) as usize];
            scaler.scale_all(&src, sw as usize, &mut partial, dw as usize);

            // Change a band of source rows, then rescale only what it touches.
            let band = sh / 3..sh / 3 + 7;
            let fresh = pattern(sw, band.len() as u32, 2);
            src[(band.start * sw) as usize..(band.end * sw) as usize].copy_from_slice(&fresh);
            let rows = scaler.dst_rows_for(band.clone());
            assert!(!rows.is_empty());
            scaler.scale_rows(&src, sw as usize, &mut partial, dw as usize, rows);

            let mut full = vec![0; (dw * dh) as usize];
            scaler.scale_all(&src, sw as usize, &mut full, dw as usize);
            assert_eq!(partial, full, "{sw}x{sh} -> {dw}x{dh}");
        }
    }

    #[test]
    fn dst_rows_cover_exactly_the_readers() {
        let scaler = Scaler::new(10, 10, 4, 4);
        assert_eq!(scaler.dst_rows_for(0..1), 0..1);
        assert_eq!(scaler.dst_rows_for(2..3), 0..2, "row 2 is shared");
        assert_eq!(scaler.dst_rows_for(9..10), 3..4);
        assert_eq!(scaler.dst_rows_for(0..10), 0..4);
        assert_eq!(scaler.dst_rows_for(5..5), 0..0);
        let up = Scaler::new(2, 2, 4, 4);
        assert_eq!(up.dst_rows_for(0..1), 0..3);
        assert_eq!(up.dst_rows_for(1..2), 1..4);
    }

    #[test]
    fn honors_strides() {
        let src = [gray(10), gray(30), 0xdead, gray(50), gray(70), 0xbeef];
        let mut dst = [7u32; 4];
        Scaler::new(2, 2, 1, 1).scale_rows(&src, 3, &mut dst, 2, 0..1);
        assert_eq!(dst, [gray(40), 7, 7, 7]);
    }
}
