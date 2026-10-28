//! The session keyboard map: parsers for the raw modifier, core and XKB map
//! replies, level lookup, modifier reconciliation and spare keycode binding.
//! Ported from `packages/desktop-linux/src/x11-keymap.ts` and
//! `x11-prebind.ts`. It has no X connection, so tests run it on fixtures.

use crate::keysyms::{is_plain_modifier, keysym_to_codepoint};
use std::collections::{HashMap, HashSet};

/// XKB `GetMap` components the parser expects: key types and key symbols.
pub const XKB_MAP_PARTS: u16 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeymapError {
    /// A reply does not have the expected shape.
    Malformed(&'static str),
    /// No empty keycode is left for a missing symbol.
    CapacityExhausted,
    /// A new binding did not produce the expected symbols.
    BindingFailed,
}

impl std::fmt::Display for KeymapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KeymapError::Malformed(what) => write!(f, "malformed keyboard map: {what}"),
            KeymapError::CapacityExhausted => write!(f, "keyboard map capacity exhausted"),
            KeymapError::BindingFailed => write!(f, "keyboard map binding failed"),
        }
    }
}

impl std::error::Error for KeymapError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TypeEntry {
    pub active: bool,
    pub mask: u8,
    pub level: u8,
}

/// An XKB key type: the modifiers it reads and the level each combination
/// selects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyType {
    pub mask: u8,
    pub levels: u8,
    pub entries: Vec<TypeEntry>,
}

/// One keycode's XKB groups, each a row of symbols by level.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XkbKey {
    pub code: u8,
    pub types: Vec<u8>,
    pub groups: Vec<Vec<u32>>,
}

/// The core modifier map.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Modifiers {
    /// Keycode to the modifier mask xdotool's first-match lookup gives it.
    /// Codes after a hole map to 0 but stay reserved.
    pub by_code: HashMap<u8, u8>,
    /// Bits that have at least one keycode.
    pub mask: u8,
    /// Keycodes of each modifier bit, holes removed.
    pub rows: [Vec<u8>; 8],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Keyboard {
    pub min: u8,
    pub max: u8,
    /// Core symbols per keycode from `min`.
    pub rows: Vec<Vec<u32>>,
    pub modifiers: Modifiers,
    pub types: Vec<KeyType>,
    /// XKB keys per keycode from `min`.
    pub keys: Vec<XkbKey>,
}

/// Where a symbol sits: the keycode, its effective group and the level.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyLevel {
    pub code: u8,
    pub group: usize,
    pub level: u8,
}

/// A spare keycode and the two levels to write to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Binding {
    pub code: u8,
    pub symbols: [u32; 2],
}

/// Modifier bits to turn on and off around one key press.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reconcile {
    pub press: u8,
    pub release: u8,
}

fn malformed(what: &'static str) -> KeymapError {
    KeymapError::Malformed(what)
}

fn u16_at(data: &[u8], offset: usize) -> u16 {
    u16::from_ne_bytes([data[offset], data[offset + 1]])
}

fn u32_at(data: &[u8], offset: usize) -> u32 {
    u32::from_ne_bytes(data[offset..offset + 4].try_into().unwrap())
}

struct Cursor<'a> {
    data: &'a [u8],
    offset: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, bytes: usize) -> Result<&'a [u8], KeymapError> {
        let end = self.offset + bytes;
        let slice = self
            .data
            .get(self.offset..end)
            .ok_or(malformed("truncated"))?;
        self.offset = end;
        Ok(slice)
    }
}

fn read_type(cursor: &mut Cursor) -> Result<KeyType, KeymapError> {
    let header = cursor.take(8)?;
    let (levels, count, preserve) = (header[4], header[5] as usize, header[6]);
    if levels == 0 || levels > 32 || preserve > 1 {
        return Err(malformed("key type"));
    }
    let mut entries = Vec::with_capacity(count);
    for _ in 0..count {
        let entry = cursor.take(8)?;
        if entry[0] > 1 || entry[2] >= levels {
            return Err(malformed("key type entry"));
        }
        entries.push(TypeEntry {
            active: entry[0] == 1,
            mask: entry[1],
            level: entry[2],
        });
    }
    if preserve == 1 {
        cursor.take(count * 4)?;
    }
    Ok(KeyType {
        mask: header[0],
        levels,
        entries,
    })
}

fn read_key(cursor: &mut Cursor, code: u8, types: &[KeyType]) -> Result<XkbKey, KeymapError> {
    let header = cursor.take(8)?;
    let groups = (header[4] & 0x0f) as usize;
    let width = header[5] as usize;
    let symbols = u16_at(header, 6) as usize;
    if groups > 4 || width > 32 {
        return Err(malformed("key dimensions"));
    }
    if symbols != groups * width || (groups > 0 && width == 0) {
        return Err(malformed("key symbols"));
    }
    let mut key = XkbKey {
        code,
        types: Vec::with_capacity(groups),
        groups: Vec::with_capacity(groups),
    };
    for &index in &header[..groups] {
        let fits = types
            .get(index as usize)
            .is_some_and(|t| t.levels as usize <= width);
        if !fits {
            return Err(malformed("key type index"));
        }
        let row = cursor.take(width * 4)?;
        key.types.push(index);
        key.groups
            .push((0..width).map(|i| u32_at(row, i * 4)).collect());
    }
    Ok(key)
}

fn check_xkb_header(data: &[u8], min: u8, max: u8) -> Result<(), KeymapError> {
    let count = max as usize - min as usize + 1;
    let header_ok =
        data.len() >= 40 && data[10] == min && data[11] == max && u16_at(data, 12) == XKB_MAP_PARTS;
    let types_ok = data.len() >= 40 && data[14] == 0 && data[15] != 0 && data[15] == data[16];
    let keys_ok = data.len() >= 40 && data[17] == min && data[20] as usize == count;
    if header_ok && types_ok && keys_ok {
        Ok(())
    } else {
        Err(malformed("xkb header"))
    }
}

/// Parses a raw XKB `GetMap` reply for key types and symbols of every
/// keycode from `min` to `max`.
pub fn parse_xkb_map(
    data: &[u8],
    min: u8,
    max: u8,
) -> Result<(Vec<KeyType>, Vec<XkbKey>), KeymapError> {
    check_xkb_header(data, min, max)?;
    let mut cursor = Cursor { data, offset: 40 };
    let types = (0..data[15])
        .map(|_| read_type(&mut cursor))
        .collect::<Result<Vec<_>, _>>()?;
    let keys = (min..=max)
        .map(|code| read_key(&mut cursor, code, &types))
        .collect::<Result<Vec<_>, _>>()?;
    let symbols: usize = keys
        .iter()
        .flat_map(|key| key.groups.iter().map(Vec::len))
        .sum();
    if cursor.offset != data.len() || symbols != u16_at(data, 18) as usize {
        return Err(malformed("xkb length"));
    }
    Ok((types, keys))
}

/// Parses a raw core `GetKeyboardMapping` reply for `count` keycodes.
pub fn parse_core_map(data: &[u8], count: usize) -> Result<Vec<Vec<u32>>, KeymapError> {
    let width = *data.get(1).ok_or(malformed("core map"))? as usize;
    if width == 0 || width > 32 || data.len() != 32 + count * width * 4 {
        return Err(malformed("core map"));
    }
    Ok((0..count)
        .map(|row| {
            (0..width)
                .map(|col| u32_at(data, 32 + (row * width + col) * 4))
                .collect()
        })
        .collect())
}

/// Parses a raw core `GetModifierMapping` reply.
pub fn parse_modifiers(data: &[u8]) -> Result<Modifiers, KeymapError> {
    let width = *data.get(1).ok_or(malformed("modifier map"))? as usize;
    if data.len() != 32 + width * 8 {
        return Err(malformed("modifier map"));
    }
    let mut result = Modifiers::default();
    let mut ended = false;
    for (i, &code) in data[32..].iter().enumerate() {
        if i % width == 0 {
            ended = false;
        }
        if code == 0 {
            ended = true;
            continue;
        }
        let bit = i / width;
        let mask = 1u8 << bit;
        result.mask |= mask;
        result.rows[bit].push(code);
        // Reserve even entries after a hole. xdotool's keycode-to-modifier
        // query stops at that hole and returns the first matching group.
        let entry = result.by_code.entry(code).or_insert(0);
        if !ended && *entry == 0 {
            *entry = mask;
        }
    }
    Ok(result)
}

/// The level that modifier state `mask` selects in `key_type`.
pub fn translated_level(key_type: &KeyType, mask: u8) -> u8 {
    key_type
        .entries
        .iter()
        .find(|entry| entry.active && entry.mask == mask & key_type.mask)
        .map_or(0, |entry| entry.level)
}

/// Modifier states inside `key_type.mask` that select `level`.
fn level_masks(key_type: &KeyType, level: u8) -> impl Iterator<Item = u8> + '_ {
    (0..=u8::MAX)
        .filter(move |m| m & !key_type.mask == 0 && translated_level(key_type, *m) == level)
}

/// The cheapest change from modifier state `current` that makes
/// `key_type` select `level`. Bits outside `pressable` cannot be turned on
/// and bits outside `releasable` cannot be turned off.
pub fn reconcile(
    key_type: &KeyType,
    level: u8,
    current: u8,
    pressable: u8,
    releasable: u8,
) -> Option<Reconcile> {
    level_masks(key_type, level)
        .map(|wanted| Reconcile {
            press: wanted & !current,
            release: current & key_type.mask & !wanted,
        })
        .filter(|r| r.press & !pressable == 0 && r.release & !releasable == 0)
        .min_by_key(|r| (r.press | r.release).count_ones())
}

impl Keyboard {
    /// Builds a keyboard from the three raw replies.
    pub fn parse(
        min: u8,
        max: u8,
        modifier_reply: &[u8],
        core_reply: &[u8],
        xkb_reply: &[u8],
    ) -> Result<Keyboard, KeymapError> {
        if min < 8 || max < min {
            return Err(malformed("keycode range"));
        }
        let modifiers = parse_modifiers(modifier_reply)?;
        if modifiers
            .by_code
            .keys()
            .any(|&code| code < min || code > max)
        {
            return Err(malformed("modifier keycode"));
        }
        let rows = parse_core_map(core_reply, max as usize - min as usize + 1)?;
        let (types, keys) = parse_xkb_map(xkb_reply, min, max)?;
        Ok(Keyboard {
            min,
            max,
            rows,
            modifiers,
            types,
            keys,
        })
    }

    pub fn key(&self, code: u8) -> Option<&XkbKey> {
        self.keys.get(code.checked_sub(self.min)? as usize)
    }

    fn key_type(&self, key: &XkbKey, group: usize) -> &KeyType {
        &self.types[key.types[group] as usize]
    }

    /// XKB wraps an out-of-range group into the key's own groups.
    fn effective_group(key: &XkbKey, group: usize) -> Option<usize> {
        (!key.groups.is_empty()).then(|| group % key.groups.len())
    }

    /// The key type `code` uses in `group`.
    pub fn type_of(&self, code: u8, group: usize) -> Option<&KeyType> {
        let key = self.key(code)?;
        Some(self.key_type(key, Self::effective_group(key, group)?))
    }

    /// The keysym that `code` produces in core state `state`, which holds
    /// the modifiers in bits 0 to 7 and the group in bits 13 and 14.
    pub fn keysym(&self, code: u8, state: u16) -> u32 {
        let Some(key) = self.key(code) else { return 0 };
        let Some(group) = Self::effective_group(key, (state >> 13) as usize & 3) else {
            return 0;
        };
        let level = translated_level(self.key_type(key, group), state as u8);
        key.groups[group].get(level as usize).copied().unwrap_or(0)
    }

    /// A keycode of modifier `bit` that only sets that modifier while held.
    pub fn press_code(&self, bit: usize) -> Option<u8> {
        self.modifiers.rows[bit].iter().copied().find(|&code| {
            self.rows[(code - self.min) as usize]
                .iter()
                .find(|&&symbol| symbol != 0)
                .is_some_and(|&symbol| is_plain_modifier(symbol))
        })
    }

    /// Modifier bits that have a plain modifier key to press.
    pub fn pressable_mask(&self) -> u8 {
        (0..8)
            .filter(|&bit| self.press_code(bit).is_some())
            .fold(0, |mask, bit| mask | 1 << bit)
    }

    pub fn is_modifier_code(&self, code: u8) -> bool {
        self.modifiers.by_code.contains_key(&code)
    }

    /// The first keycode and level in `group` whose symbol satisfies `want`
    /// and whose level some pressable modifier state selects. Modifier
    /// keycodes are skipped unless `modifiers` is true.
    pub fn find(
        &self,
        group: usize,
        modifiers: bool,
        want: impl Fn(u32) -> bool,
    ) -> Option<KeyLevel> {
        let pressable = self.pressable_mask();
        self.keys
            .iter()
            .filter(|key| modifiers || !self.is_modifier_code(key.code))
            .find_map(|key| self.find_in_key(key, group, pressable, &want))
    }

    fn find_in_key(
        &self,
        key: &XkbKey,
        group: usize,
        pressable: u8,
        want: &impl Fn(u32) -> bool,
    ) -> Option<KeyLevel> {
        let group = Self::effective_group(key, group)?;
        let key_type = self.key_type(key, group);
        (0..key_type.levels)
            .filter(|&level| want(key.groups[group][level as usize]))
            .find(|&level| level_masks(key_type, level).any(|m| m & !pressable == 0))
            .map(|level| KeyLevel {
                code: key.code,
                group,
                level,
            })
    }

    /// The first non-modifier key level in `group` that types `cp`.
    pub fn find_codepoint(&self, group: usize, cp: u32) -> Option<KeyLevel> {
        self.find(group, false, |symbol| {
            symbol != 0 && keysym_to_codepoint(symbol) == cp
        })
    }

    /// The first key level in `group` that carries exactly `symbol`.
    pub fn find_keysym(&self, group: usize, symbol: u32) -> Option<KeyLevel> {
        self.find(group, true, |s| s == symbol)
    }

    fn is_empty_code(&self, code: u8) -> bool {
        let index = (code - self.min) as usize;
        !self.is_modifier_code(code)
            && self.rows[index].iter().all(|&s| s == 0)
            && self.keys[index].groups.iter().flatten().all(|&s| s == 0)
    }

    /// Empty non-modifier keycodes, highest first. The minimum code stays
    /// reserved for the agent's `desktop_key`.
    pub fn empty_codes(&self) -> Vec<u8> {
        (self.min + 1..=self.max)
            .rev()
            .filter(|&code| self.is_empty_code(code))
            .collect()
    }
}

/// Codepoints that some key level in `group` types with pressable
/// modifiers.
pub fn usable_codepoints(keyboard: &Keyboard, group: usize) -> HashSet<u32> {
    let pressable = keyboard.pressable_mask();
    let mut usable = HashSet::new();
    for key in keyboard.keys.iter() {
        if keyboard.is_modifier_code(key.code) {
            continue;
        }
        let Some(g) = Keyboard::effective_group(key, group) else {
            continue;
        };
        let key_type = keyboard.key_type(key, g);
        for level in 0..key_type.levels {
            let reachable = level_masks(key_type, level).any(|m| m & !pressable == 0);
            let cp = keysym_to_codepoint(key.groups[g][level as usize]);
            if reachable && cp != 0 {
                usable.insert(cp);
            }
        }
    }
    usable
}

/// Assigns each desired row that types a missing codepoint of `points` to
/// an empty keycode, highest first. Fails without a partial plan when the
/// empty codes run out.
pub fn plan_bindings(
    keyboard: &Keyboard,
    desired: &[[u32; 2]],
    points: &HashSet<u32>,
    group: usize,
) -> Result<Vec<Binding>, KeymapError> {
    let available = usable_codepoints(keyboard, group);
    let missing: Vec<&[u32; 2]> = desired
        .iter()
        .filter(|symbols| {
            symbols.iter().any(|&symbol| {
                let cp = keysym_to_codepoint(symbol);
                points.contains(&cp) && !available.contains(&cp)
            })
        })
        .collect();
    let empty = keyboard.empty_codes();
    if missing.len() > empty.len() {
        return Err(KeymapError::CapacityExhausted);
    }
    Ok(missing
        .into_iter()
        .zip(empty)
        .map(|(&symbols, code)| Binding { code, symbols })
        .collect())
}

/// Checks a reread map after binding: each bound code is still a
/// non-modifier with its symbols, and every point is now usable.
pub fn verify_bindings(
    keyboard: &Keyboard,
    bindings: &[Binding],
    points: &HashSet<u32>,
    group: usize,
) -> Result<(), KeymapError> {
    for binding in bindings {
        let Some(row) = keyboard.rows.get((binding.code - keyboard.min) as usize) else {
            return Err(KeymapError::BindingFailed);
        };
        let represented: HashSet<u32> = row.iter().map(|&s| keysym_to_codepoint(s)).collect();
        let present = binding
            .symbols
            .iter()
            .all(|&s| represented.contains(&keysym_to_codepoint(s)));
        if keyboard.is_modifier_code(binding.code) || !present {
            return Err(KeymapError::BindingFailed);
        }
    }
    let available = usable_codepoints(keyboard, group);
    if points.iter().all(|cp| available.contains(cp)) {
        Ok(())
    } else {
        Err(KeymapError::BindingFailed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keysyms::{binding_symbols, named};

    // Replies captured from Xvfb 21.1.25 with xkeyboard-config 2.48, its
    // default `us` map, sequence numbers zeroed.
    const MODIFIERS: &[u8] = include_bytes!("../tests/fixtures/xvfb-keymap-modifiers.bin");
    const CORE: &[u8] = include_bytes!("../tests/fixtures/xvfb-keymap-core.bin");
    const XKB: &[u8] = include_bytes!("../tests/fixtures/xvfb-keymap-xkb.bin");

    const SHIFT: u8 = 1;
    const LOCK: u8 = 2;
    const MOD5: u8 = 0x80;

    fn fixture() -> Keyboard {
        Keyboard::parse(8, 255, MODIFIERS, CORE, XKB).unwrap()
    }

    fn entry(mask: u8, level: u8) -> TypeEntry {
        TypeEntry {
            active: true,
            mask,
            level,
        }
    }

    fn alphabetic() -> KeyType {
        KeyType {
            mask: SHIFT | LOCK,
            levels: 2,
            entries: vec![entry(SHIFT, 1), entry(LOCK, 1)],
        }
    }

    /// `us`-like map: ONE_LEVEL, TWO_LEVEL on Shift, ALPHABETIC; Shift_L on
    /// 50 and Caps_Lock on 66.
    fn synthetic(keys: &[(u8, &[u32])]) -> Keyboard {
        let one = KeyType {
            mask: 0,
            levels: 1,
            entries: vec![],
        };
        let two = KeyType {
            mask: SHIFT,
            levels: 2,
            entries: vec![entry(SHIFT, 1)],
        };
        let mut keyboard = Keyboard {
            min: 8,
            max: 255,
            rows: vec![vec![]; 248],
            modifiers: Modifiers::default(),
            types: vec![one, two, alphabetic()],
            keys: (8..=255)
                .map(|code| XkbKey {
                    code,
                    types: vec![],
                    groups: vec![],
                })
                .collect(),
        };
        add_modifier(&mut keyboard, 0, 50);
        add_modifier(&mut keyboard, 1, 66);
        set_key(&mut keyboard, 50, &[named::SHIFT_L]);
        set_key(&mut keyboard, 66, &[named::CAPS_LOCK]);
        for (code, symbols) in keys {
            set_key(&mut keyboard, *code, symbols);
        }
        keyboard
    }

    fn add_modifier(keyboard: &mut Keyboard, bit: usize, code: u8) {
        keyboard.modifiers.rows[bit].push(code);
        keyboard.modifiers.by_code.insert(code, 1 << bit);
        keyboard.modifiers.mask |= 1 << bit;
    }

    /// One group of up to two levels, as a server would derive it.
    fn set_key(keyboard: &mut Keyboard, code: u8, symbols: &[u32]) {
        let index = (code - keyboard.min) as usize;
        keyboard.rows[index] = symbols.to_vec();
        keyboard.keys[index].types = vec![(symbols.len() - 1) as u8];
        keyboard.keys[index].groups = vec![symbols.to_vec()];
    }

    fn apply(keyboard: &mut Keyboard, bindings: &[Binding]) {
        for binding in bindings {
            set_key(keyboard, binding.code, &binding.symbols);
        }
    }

    fn plan(keyboard: &Keyboard, text: &str) -> Result<Vec<Binding>, KeymapError> {
        let points: Vec<u32> = text.chars().map(|c| c as u32).collect();
        let set = points.iter().copied().collect();
        plan_bindings(keyboard, &binding_symbols(&points), &set, 0)
    }

    #[test]
    fn parses_the_captured_xvfb_map() {
        let keyboard = fixture();
        assert_eq!(keyboard.keys.len(), 248);
        assert_eq!(keyboard.rows.len(), 248);
        assert_eq!(keyboard.types.len(), 27);
        assert_eq!(keyboard.modifiers.rows[0], vec![50, 62]);
        assert_eq!(keyboard.modifiers.rows[1], vec![66]);
        assert_eq!(keyboard.modifiers.rows[2], vec![37, 105]);
        assert_eq!(keyboard.modifiers.rows[7], vec![92]);
        assert_eq!(keyboard.modifiers.mask, 0xff);
        assert_eq!(keyboard.press_code(0), Some(50));
        assert_eq!(keyboard.press_code(2), Some(37));
        assert_eq!(keyboard.press_code(1), None, "Caps_Lock is not held");
        assert_eq!(keyboard.press_code(4), None, "Num_Lock is not held");
        assert_eq!(keyboard.press_code(7), Some(92), "ISO_Level3_Shift");
    }

    #[test]
    fn looks_up_and_decodes_the_captured_map() {
        let keyboard = fixture();
        let a = keyboard.find_codepoint(0, 'a' as u32).unwrap();
        assert_eq!((a.code, a.level), (38, 0));
        let upper = keyboard.find_codepoint(0, 'A' as u32).unwrap();
        assert_eq!((upper.code, upper.level), (38, 1));
        assert_eq!(keyboard.find_keysym(0, named::RETURN).unwrap().code, 36);
        assert_eq!(keyboard.find_keysym(0, named::SHIFT_L).unwrap().code, 50);
        assert_eq!(keyboard.find_codepoint(0, ' ' as u32).unwrap().code, 65);
        assert_eq!(keyboard.keysym(38, 0), 0x61);
        assert_eq!(keyboard.keysym(38, SHIFT as u16), 0x41);
        assert_eq!(keyboard.keysym(38, LOCK as u16), 0x41);
        assert_eq!(keyboard.keysym(10, SHIFT as u16), '!' as u32);
        assert_eq!(keyboard.keysym(36, 0), named::RETURN);

        let usable = usable_codepoints(&keyboard, 0);
        for c in "aA zZ09!@~\r\t".chars() {
            assert!(usable.contains(&(c as u32)), "{c:?}");
        }
        for c in "çãÁ€ß".chars() {
            assert!(!usable.contains(&(c as u32)), "{c:?}");
        }
        let empty = keyboard.empty_codes();
        assert!(empty.len() >= 10, "{} spare codes", empty.len());
        assert!(empty.windows(2).all(|w| w[0] > w[1]));
        assert!(!empty.contains(&8));
    }

    #[test]
    fn rejects_malformed_xkb_replies() {
        assert!(parse_xkb_map(XKB, 8, 255).is_ok());
        for offset in [10, 11, 12, 14, 15, 16, 17, 18, 20, 44] {
            let mut bad = XKB.to_vec();
            bad[offset] ^= 0xff;
            assert!(parse_xkb_map(&bad, 8, 255).is_err(), "offset {offset}");
        }
        assert!(parse_xkb_map(&XKB[..47], 8, 255).is_err());
        assert!(parse_xkb_map(&XKB[..XKB.len() - 4], 8, 255).is_err());
        assert!(parse_xkb_map(&[XKB, &[0; 4]].concat(), 8, 255).is_err());
        assert!(parse_xkb_map(XKB, 9, 255).is_err());
        assert!(Keyboard::parse(8, 255, MODIFIERS, &CORE[..CORE.len() - 4], XKB).is_err());
    }

    #[test]
    fn preserves_modifier_entries_after_holes() {
        let mut reply = vec![0u8; 32 + 3 * 8];
        reply[1] = 3;
        reply[33] = 250; // Shift has a leading hole: reserved, lookup skips it.
        reply[35] = 250;
        reply[36] = 251; // Lock lookup wins over a later group.
        reply[38] = 251;
        let modifiers = parse_modifiers(&reply).unwrap();
        assert_eq!(modifiers.by_code, HashMap::from([(250, 2), (251, 2)]));
        assert_eq!(modifiers.mask, 7);
        assert_eq!(modifiers.rows[0], vec![250]);
        assert_eq!(modifiers.rows[1], vec![250, 251]);
        assert_eq!(modifiers.rows[2], vec![251]);
    }

    #[test]
    fn bounds_core_and_modifier_dimensions() {
        let empty = parse_modifiers(&[0; 32]).unwrap();
        assert!(empty.by_code.is_empty() && empty.mask == 0);
        let mut bad = vec![0u8; 32];
        bad[1] = 255;
        assert!(parse_modifiers(&bad).is_err());
        assert!(parse_modifiers(&[]).is_err());
        assert!(parse_core_map(&[0; 32], 248).is_err());
        assert!(parse_core_map(&bad, 248).is_err());
        assert!(parse_core_map(CORE, 247).is_err());
    }

    #[test]
    fn plans_highest_empty_codes_and_keeps_occupied_modifier_and_minimum() {
        let mut keyboard = synthetic(&[(254, &[0x1234])]);
        add_modifier(&mut keyboard, 3, 255);
        let bindings = plan(&keyboard, "áé").unwrap();
        assert_eq!(
            bindings,
            vec![
                Binding {
                    code: 253,
                    symbols: [0xe1, 0xc1]
                },
                Binding {
                    code: 252,
                    symbols: [0xe9, 0xc9]
                },
            ]
        );
        assert!(!keyboard.empty_codes().contains(&8));
    }

    fn full(spare: &[u8]) -> Keyboard {
        let mut keyboard = synthetic(&[]);
        for code in 9..=255u8 {
            if code != 50 && code != 66 && !spare.contains(&code) {
                set_key(&mut keyboard, code, &[named::SHIFT_L]);
            }
        }
        keyboard
    }

    #[test]
    fn checks_full_capacity_before_any_binding() {
        assert_eq!(plan(&full(&[]), "á"), Err(KeymapError::CapacityExhausted));
        assert_eq!(
            plan(&full(&[254]), "áé"),
            Err(KeymapError::CapacityExhausted)
        );
    }

    #[test]
    fn reuses_natural_case_pairs_at_one_slot_capacity() {
        let mut keyboard = full(&[254]);
        let first = plan(&keyboard, "á").unwrap();
        assert_eq!(
            first,
            vec![Binding {
                code: 254,
                symbols: [0xe1, 0xc1]
            }]
        );
        apply(&mut keyboard, &first);
        verify_bindings(&keyboard, &first, &HashSet::from([0xe1]), 0).unwrap();
        assert_eq!(plan(&keyboard, "Á"), Ok(vec![]));
        assert_eq!(plan(&keyboard, "áÁ"), Ok(vec![]));
    }

    #[test]
    fn reuses_a_legacy_symbol_without_its_case_partner() {
        let keyboard = synthetic(&[(150, &[0x7e1])]);
        assert_eq!(plan(&keyboard, "α"), Ok(vec![]));
        assert_eq!(keyboard.find_codepoint(0, 0x3b1).unwrap().code, 150);
    }

    #[test]
    fn binds_emoji_case_pairs_and_accents_once() {
        let keyboard = synthetic(&[(38, &[0x61, 0x41]), (150, &[0x7e1])]);
        let bindings = plan(&keyboard, "Aaα😀áÁé").unwrap();
        let symbols: Vec<[u32; 2]> = bindings.iter().map(|b| b.symbols).collect();
        assert_eq!(
            symbols,
            vec![[0x0101_f600, 0x0101_f600], [0xe1, 0xc1], [0xe9, 0xc9]]
        );
        assert_eq!(
            bindings.iter().map(|b| b.code).collect::<Vec<_>>(),
            vec![255, 254, 253]
        );
    }

    #[test]
    fn does_not_mistake_an_unreachable_level_for_a_character() {
        let mut keyboard = synthetic(&[(9, &[0xe1, 0xe9])]);
        keyboard.types.push(KeyType {
            mask: SHIFT,
            levels: 2,
            entries: vec![],
        });
        keyboard.keys[1].types = vec![3];
        let usable = usable_codepoints(&keyboard, 0);
        assert!(usable.contains(&0xe1) && !usable.contains(&0xe9));
        assert_eq!(plan(&keyboard, "é").unwrap().len(), 1);
    }

    #[test]
    fn needs_a_plain_modifier_key_for_a_level() {
        let mut keyboard = synthetic(&[(38, &[0x61, 0x41])]);
        assert!(usable_codepoints(&keyboard, 0).contains(&0x41));
        set_key(&mut keyboard, 50, &[named::CAPS_LOCK]);
        assert_eq!(keyboard.pressable_mask(), 0);
        let usable = usable_codepoints(&keyboard, 0);
        assert!(usable.contains(&0x61) && !usable.contains(&0x41));
    }

    #[test]
    fn looks_up_symbols_in_the_current_group_only() {
        let mut keyboard = synthetic(&[]);
        let index = 150 - 8;
        keyboard.rows[index] = vec![0x61, 0x41, 0x7e1, 0x7c1];
        keyboard.keys[index].types = vec![1, 1];
        keyboard.keys[index].groups = vec![vec![0x61, 0x41], vec![0x7e1, 0x7c1]];
        assert!(!usable_codepoints(&keyboard, 0).contains(&0x3b1));
        assert_eq!(
            plan(&keyboard, "α").unwrap(),
            vec![Binding {
                code: 255,
                symbols: [0x0100_03b1, 0x0100_0391]
            }]
        );
        assert!(usable_codepoints(&keyboard, 1).contains(&0x3b1));
        assert_eq!(keyboard.keysym(150, 1 << 13), 0x7e1);
        // A group past the key's groups wraps.
        assert_eq!(keyboard.keysym(150, 2 << 13), 0x61);
    }

    #[test]
    fn verifies_bindings_after_a_reread() {
        let mut keyboard = synthetic(&[]);
        let bindings = plan(&keyboard, "ç").unwrap();
        let points = HashSet::from([0xe7]);
        assert_eq!(
            verify_bindings(&keyboard, &bindings, &points, 0),
            Err(KeymapError::BindingFailed)
        );
        apply(&mut keyboard, &bindings);
        assert_eq!(verify_bindings(&keyboard, &bindings, &points, 0), Ok(()));
        add_modifier(&mut keyboard, 3, bindings[0].code);
        assert_eq!(
            verify_bindings(&keyboard, &bindings, &points, 0),
            Err(KeymapError::BindingFailed)
        );
    }

    #[test]
    fn reconciles_shift_and_lock_for_alphabetic_keys() {
        let t = alphabetic();
        let change = |level, current, releasable| reconcile(&t, level, current, SHIFT, releasable);
        let none = Reconcile {
            press: 0,
            release: 0,
        };
        assert_eq!(change(0, 0, 0), Some(none));
        assert_eq!(
            change(1, 0, 0),
            Some(Reconcile {
                press: SHIFT,
                release: 0
            })
        );
        // Held Shift for a lowercase letter is released for that letter.
        assert_eq!(
            change(0, SHIFT, SHIFT),
            Some(Reconcile {
                press: 0,
                release: SHIFT
            })
        );
        // Caps Lock cannot be released, so Shift+Lock selects lowercase.
        assert_eq!(
            change(0, LOCK, 0),
            Some(Reconcile {
                press: SHIFT,
                release: 0
            })
        );
        assert_eq!(change(1, LOCK, 0), Some(none));
        // Bits outside the type do not matter.
        assert_eq!(change(0, 0x04, 0), Some(none));
    }

    #[test]
    fn reconciles_level_three_and_refuses_what_it_cannot_change() {
        let t = KeyType {
            mask: SHIFT | MOD5,
            levels: 4,
            entries: vec![entry(SHIFT, 1), entry(MOD5, 2), entry(SHIFT | MOD5, 3)],
        };
        let pressable = SHIFT | MOD5;
        assert_eq!(
            reconcile(&t, 3, 0, pressable, 0),
            Some(Reconcile {
                press: SHIFT | MOD5,
                release: 0
            })
        );
        assert_eq!(
            reconcile(&t, 0, MOD5, pressable, MOD5),
            Some(Reconcile {
                press: 0,
                release: MOD5
            })
        );
        assert_eq!(reconcile(&t, 0, MOD5, pressable, 0), None);
        assert_eq!(reconcile(&t, 2, 0, SHIFT, 0), None);
        assert_eq!(translated_level(&t, SHIFT | MOD5 | LOCK), 3);
    }
}
