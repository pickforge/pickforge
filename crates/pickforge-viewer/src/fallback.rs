//! Host fonts for characters the embedded font cannot draw. The font
//! directories that fontconfig names are scanned once, on the first such
//! character, so Latin text never pays for it.

use std::collections::HashMap;
use std::sync::Arc;
use swash::{tag_from_bytes, FontRef};

/// Finds and keeps host fonts by the characters they cover.
#[derive(Default)]
pub struct Fallback {
    /// Host faces in preference order, scanned on first use.
    faces: Option<Vec<fontdb::ID>>,
    db: fontdb::Database,
    /// Loaded fonts, in the order they were found.
    fonts: Vec<FontRef<'static>>,
    /// The loaded font for each character looked up, or `None` when no
    /// host font has it.
    chars: HashMap<char, Option<usize>>,
}

impl Fallback {
    /// The index into [`Self::font`] of the first host font that draws
    /// `c`.
    pub fn find(&mut self, c: char) -> Option<usize> {
        self.find_all(&[c]);
        self.chars[&c]
    }

    /// Looks up every character of `chars` with at most one scan of the
    /// host fonts.
    pub fn find_all(&mut self, chars: &[char]) {
        let mut missing = Vec::new();
        for &c in chars {
            if self.chars.contains_key(&c) || missing.contains(&c) {
                continue;
            }
            match self.fonts.iter().position(|f| covers(*f, c)) {
                Some(i) => {
                    self.chars.insert(c, Some(i));
                }
                None => missing.push(c),
            }
        }
        if !missing.is_empty() {
            self.load(&mut missing);
        }
        for c in missing {
            self.chars.insert(c, None);
        }
    }

    pub fn font(&self, index: usize) -> FontRef<'static> {
        self.fonts[index]
    }

    /// Whether the host font directories were scanned.
    #[cfg(test)]
    pub fn scanned(&self) -> bool {
        self.faces.is_some()
    }

    /// Loads the first host font for each character of `missing`, and
    /// leaves the characters no host font has.
    fn load(&mut self, missing: &mut Vec<char>) {
        if self.faces.is_none() {
            self.db.load_system_fonts();
            self.faces = Some(preference_order(&self.db));
        }
        let faces = self.faces.clone().unwrap_or_default();
        for id in faces {
            let found: Vec<char> = self
                .db
                .with_face_data(id, |data, index| {
                    FontRef::from_index(data, index as usize).map_or(Vec::new(), |font| {
                        missing
                            .iter()
                            .copied()
                            .filter(|&c| covers(font, c))
                            .collect()
                    })
                })
                .unwrap_or_default();
            if found.is_empty() {
                continue;
            }
            // SAFETY: the font file is memory-mapped. Another process that
            // rewrites it while it is mapped could change the glyph data
            // under us, which every text stack that maps fonts accepts.
            let Some((data, index)) = (unsafe { self.db.make_shared_face_data(id) }) else {
                continue;
            };
            // The few fallback fonts stay mapped for the life of the viewer.
            let data: &'static Arc<dyn AsRef<[u8]> + Send + Sync> = Box::leak(Box::new(data));
            let data: &'static [u8] = (**data).as_ref();
            let Some(font) = FontRef::from_index(data, index as usize) else {
                continue;
            };
            self.fonts.push(font);
            for c in &found {
                self.chars.insert(*c, Some(self.fonts.len() - 1));
            }
            missing.retain(|c| !found.contains(c));
            if missing.is_empty() {
                return;
            }
        }
    }
}

/// Whether `font` has an outline glyph for `c`. Color bitmap fonts, such
/// as emoji fonts, do not count: the viewer draws outlines only.
pub fn covers(font: FontRef<'_>, c: char) -> bool {
    let outlines = [b"glyf", b"CFF ", b"CFF2"]
        .iter()
        .any(|tag| font.table(tag_from_bytes(tag)).is_some());
    outlines && font.charmap().map(c) != 0
}

/// Host faces with upright sans faces close to Medium first, like the
/// embedded font, and a stable order otherwise.
fn preference_order(db: &fontdb::Database) -> Vec<fontdb::ID> {
    let mut faces: Vec<_> = db
        .faces()
        .map(|face| {
            let family = face
                .families
                .first()
                .map_or(String::new(), |(name, _)| name.clone());
            let sans = family.contains("Sans") && !family.contains("Mono");
            let key = (
                face.style != fontdb::Style::Normal,
                face.monospaced || !sans,
                face.weight.0.abs_diff(fontdb::Weight::MEDIUM.0),
                family,
                face.index,
            );
            (key, face.id)
        })
        .collect();
    faces.sort();
    faces.into_iter().map(|(_, id)| id).collect()
}
