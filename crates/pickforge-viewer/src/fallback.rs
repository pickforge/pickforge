//! Host fonts for characters the embedded font cannot draw. The font
//! directories that fontconfig names are scanned once, on the first such
//! character, so Latin text never pays for it.
//!
//! The scan maps each font file only while it reads that file. A font the
//! viewer keeps is read into memory once, when it is first chosen, so a
//! font file that changes later cannot change or crash the viewer.

use std::collections::HashMap;
use swash::{tag_from_bytes, FontRef};

/// Family name tokens of regional CJK faces.
const REGIONS: [&str; 5] = ["JP", "SC", "TC", "HK", "KR"];

/// Finds and keeps host fonts by the characters they cover.
#[derive(Default)]
pub struct Fallback {
    /// Host faces in preference order, scanned on first use.
    faces: Option<Vec<fontdb::ID>>,
    db: fontdb::Database,
    /// Loaded fonts, in the order they were found, and their faces.
    fonts: Vec<FontRef<'static>>,
    ids: Vec<fontdb::ID>,
    /// The loaded font for each character looked up, or `None` when no
    /// host font has it.
    chars: HashMap<char, Option<usize>>,
    /// The loaded font for each cluster of several characters looked up.
    clusters: HashMap<Vec<char>, Option<usize>>,
}

impl Fallback {
    /// A fallback that scans only the fonts in `dir`.
    #[cfg(test)]
    pub fn from_dir(dir: &std::path::Path) -> Self {
        let mut db = fontdb::Database::new();
        db.load_fonts_dir(dir);
        Self {
            faces: Some(preference_order(&db, None)),
            db,
            ..Self::default()
        }
    }

    /// The index into [`Self::font`] of the first host font that draws
    /// `c`.
    pub fn find(&mut self, c: char) -> Option<usize> {
        self.find_all(&[c]);
        self.chars[&c]
    }

    /// The index into [`Self::font`] of the first host font that draws
    /// every character of `cluster`.
    pub fn find_cluster(&mut self, cluster: &[char]) -> Option<usize> {
        if let [c] = cluster {
            return self.find(*c);
        }
        if let Some(&found) = self.clusters.get(cluster) {
            return found;
        }
        let all = |font: FontRef<'_>| cluster.iter().all(|&c| covers(font, c));
        let mut found = self.fonts.iter().position(|&f| all(f));
        if found.is_none() {
            for id in self.faces() {
                let covered = self
                    .db
                    .with_face_data(id, |data, index| {
                        FontRef::from_index(data, index as usize).is_some_and(all)
                    })
                    .unwrap_or(false);
                if covered {
                    found = self.retain(id).filter(|&i| all(self.fonts[i]));
                    if found.is_some() {
                        break;
                    }
                }
            }
        }
        self.clusters.insert(cluster.to_vec(), found);
        found
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

    /// Host faces in preference order, scanned on first use.
    fn faces(&mut self) -> Vec<fontdb::ID> {
        if self.faces.is_none() {
            self.db.load_system_fonts();
            let region = locale_region(|name| std::env::var(name).ok());
            self.faces = Some(preference_order(&self.db, region));
        }
        self.faces.clone().unwrap_or_default()
    }

    /// Loads the first host font for each character of `missing`, and
    /// leaves the characters no host font has.
    fn load(&mut self, missing: &mut Vec<char>) {
        for id in self.faces() {
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
            let Some(i) = self.retain(id) else {
                continue;
            };
            // The file may have changed since the scan read it.
            let found: Vec<char> = found
                .into_iter()
                .filter(|&c| covers(self.fonts[i], c))
                .collect();
            for c in &found {
                self.chars.insert(*c, Some(i));
            }
            missing.retain(|c| !found.contains(c));
            if missing.is_empty() {
                return;
            }
        }
    }

    /// Reads the font of face `id` into memory that lives as long as the
    /// viewer, and returns its index into [`Self::font`].
    fn retain(&mut self, id: fontdb::ID) -> Option<usize> {
        if let Some(i) = self.ids.iter().position(|&known| known == id) {
            return Some(i);
        }
        let face = self.db.face(id)?;
        let data = match &face.source {
            fontdb::Source::Binary(data) => (**data).as_ref().to_vec(),
            fontdb::Source::File(path) | fontdb::Source::SharedFile(path, _) => {
                std::fs::read(path).ok()?
            }
        };
        let index = face.index as usize;
        FontRef::from_index(&data, index)?;
        // The few fallback fonts stay for the life of the viewer.
        let data: &'static [u8] = Box::leak(data.into_boxed_slice());
        self.fonts.push(FontRef::from_index(data, index)?);
        self.ids.push(id);
        Some(self.fonts.len() - 1)
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

/// The region token of the locale's CJK faces, from the first of
/// `LC_ALL`, `LC_CTYPE` and `LANG` that is set.
fn locale_region(var: impl Fn(&str) -> Option<String>) -> Option<&'static str> {
    let locale = ["LC_ALL", "LC_CTYPE", "LANG"]
        .into_iter()
        .filter_map(var)
        .find(|value| !value.is_empty())?;
    let locale = locale.split(['.', '@']).next().unwrap_or_default();
    let (language, territory) = locale.split_once('_').unwrap_or((locale, ""));
    match (language, territory) {
        ("ja", _) => Some("JP"),
        ("ko", _) => Some("KR"),
        ("zh", "TW") => Some("TC"),
        ("zh", "HK" | "MO") => Some("HK"),
        ("zh", _) => Some("SC"),
        _ => None,
    }
}

/// Sort key of a host face: upright sans faces close to Medium first, like
/// the embedded font, and a stable order otherwise. With a locale `region`,
/// regional CJK faces of other regions come after the others.
fn face_key(
    family: &str,
    italic: bool,
    monospaced: bool,
    weight: u16,
    region: Option<&str>,
) -> (bool, bool, bool, u16, String) {
    let sans = family.contains("Sans") && !family.contains("Mono");
    let other_region = region.is_some_and(|region| {
        family
            .split_whitespace()
            .any(|word| REGIONS.contains(&word) && word != region)
    });
    (
        italic,
        monospaced || !sans,
        other_region,
        weight.abs_diff(fontdb::Weight::MEDIUM.0),
        family.to_owned(),
    )
}

/// Host faces in the order of [`face_key`].
fn preference_order(db: &fontdb::Database, region: Option<&str>) -> Vec<fontdb::ID> {
    let mut faces: Vec<_> = db
        .faces()
        .map(|face| {
            let family = face.families.first().map_or("", |(name, _)| name.as_str());
            let key = face_key(
                family,
                face.style != fontdb::Style::Normal,
                face.monospaced,
                face.weight.0,
                region,
            );
            ((key, face.index), face.id)
        })
        .collect();
    faces.sort();
    faces.into_iter().map(|(_, id)| id).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retained_fonts_survive_their_file_shrinking() {
        let dir = std::env::temp_dir().join(format!("pickforge-fallback-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("copy.ttf");
        std::fs::write(&path, include_bytes!("../assets/Geist-Medium.ttf")).unwrap();
        let mut fallback = Fallback::from_dir(&dir);
        let index = fallback.find('A').expect("the copy draws A");
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(0)
            .unwrap();
        // A mapped font would raise SIGBUS here.
        let font = fallback.font(index);
        assert!(covers(font, 'B'));
        assert!(covers(font, '\u{1ea0}'));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn locale_names_the_cjk_region() {
        let region = |vars: [&str; 3]| {
            locale_region(|name| {
                let i = ["LC_ALL", "LC_CTYPE", "LANG"]
                    .iter()
                    .position(|&n| n == name)?;
                Some(vars[i].to_owned()).filter(|v| !v.is_empty())
            })
        };
        assert_eq!(region(["", "", "ja_JP.UTF-8"]), Some("JP"));
        assert_eq!(region(["", "", "zh_CN.UTF-8"]), Some("SC"));
        assert_eq!(region(["", "", "zh_TW.UTF-8"]), Some("TC"));
        assert_eq!(region(["", "", "zh_HK.UTF-8"]), Some("HK"));
        assert_eq!(region(["", "", "ko_KR.UTF-8"]), Some("KR"));
        assert_eq!(region(["", "ja_JP.UTF-8", "ko_KR.UTF-8"]), Some("JP"));
        assert_eq!(region(["C.UTF-8", "ja_JP.UTF-8", ""]), None);
        assert_eq!(region(["", "", "en_US.UTF-8"]), None);
        assert_eq!(region(["", "", ""]), None);
    }

    #[test]
    fn locale_region_ranks_cjk_faces() {
        let families = [
            "Noto Sans CJK HK",
            "Noto Sans CJK JP",
            "Noto Sans CJK KR",
            "Noto Sans CJK SC",
            "Noto Sans CJK TC",
            "Noto Sans Arabic",
        ];
        let first = |region: Option<&str>, weights: [u16; 6]| {
            families
                .iter()
                .zip(weights)
                .min_by_key(|&(family, weight)| face_key(family, false, false, weight, region))
                .map(|(family, _)| *family)
                .unwrap()
        };
        let medium = [500; 6];
        assert_eq!(first(None, medium), "Noto Sans Arabic");
        let cjk = |region| {
            let mut weights = medium;
            weights[5] = 900;
            first(region, weights)
        };
        assert_eq!(cjk(None), "Noto Sans CJK HK");
        assert_eq!(cjk(Some("JP")), "Noto Sans CJK JP");
        assert_eq!(cjk(Some("SC")), "Noto Sans CJK SC");
        assert_eq!(cjk(Some("KR")), "Noto Sans CJK KR");
        // The locale's face wins over a closer weight of another region.
        let mut weights = medium;
        weights[1] = 400;
        weights[5] = 900;
        assert_eq!(first(Some("JP"), weights), "Noto Sans CJK JP");
        // Upright sans still comes first.
        assert!(
            face_key("Noto Sans CJK HK", false, false, 500, Some("JP"))
                < face_key("Noto Serif CJK JP", false, false, 500, Some("JP"))
        );
    }
}
