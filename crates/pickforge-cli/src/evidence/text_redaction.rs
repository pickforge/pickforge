//! Redaction for stored UI trees, logs and reports. A JSON string or an XML value is decoded,
//! redacted on its own and encoded again, so the document's quotes can never be mistaken for
//! a credential's quotes. JSON is rewritten token by token, so numbers, spacing and key order
//! stay as written. Text that redaction does not change is stored byte for byte.

use std::sync::OnceLock;

use regex::Regex;

use super::{is_flag, redact_secrets, ArtifactOrigin};

const REDACTED: &str = "[REDACTED]";
/// Noncharacters never appear in real documents. The first two wrap the index of a JSON value
/// masked in plain text, where a literal `VALUE_START` is written as `VALUE_START` and `x`.
/// The third marks an XML reference that decoding keeps as written.
const VALUE_START: char = '\u{FDD0}';
const VALUE_END: char = '\u{FDD1}';
const KEPT: char = '\u{FDD2}';
const XML_REFERENCE: &str = r"#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z_:][\w.:-]*";

pub(super) fn redact_text_artifact(text: &str, origin: ArtifactOrigin) -> String {
    let lighthouse = origin == ArtifactOrigin::Lighthouse;
    let start = text.len()
        - text
            .trim_start_matches(['\u{feff}', ' ', '\t', '\r', '\n'])
            .len();
    let body = &text[start..];
    if matches!(body.as_bytes().first(), Some(b'{' | b'['))
        && json_value_end(body.as_bytes())
            .is_some_and(|end| body[end..].trim_matches([' ', '\t', '\r', '\n']).is_empty())
    {
        return format!(
            "{}{}",
            &text[..start],
            redact_json_text(body, false, lighthouse)
        );
    }
    // Lighthouse HTML is stored as text: its script bodies are not markup.
    if body.starts_with('<') && !lighthouse {
        return redact_markup(text);
    }
    text.split_inclusive('\n')
        .map(|line| redact_fragment(line, lighthouse))
        .collect()
}

/// Redact one line or one decoded value. Each JSON object or array in it, as in
/// `D/app: {"password":1} took 3ms`, is redacted as JSON. The plain-text rules see each JSON
/// value as one opaque value, so a rule such as `Cookie:` that covers the rest of the line
/// covers the JSON in it too.
fn redact_fragment(text: &str, lighthouse: bool) -> String {
    let (masked, values) = mask_json_values(text, lighthouse);
    static MARKER: OnceLock<Regex> = OnceLock::new();
    let marker = MARKER.get_or_init(|| Regex::new(r"\x{FDD0}(?:([0-9]+)\x{FDD1}|x)").unwrap());
    marker
        .replace_all(
            &redact_secrets(&masked),
            |captures: &regex::Captures<'_>| match captures.get(1) {
                Some(index) => index
                    .as_str()
                    .parse::<usize>()
                    .ok()
                    .and_then(|index| values.get(index))
                    .map_or_else(|| captures[0].to_owned(), Clone::clone),
                None => VALUE_START.to_string(),
            },
        )
        .into_owned()
}

/// Replace each JSON object or array with a marker and return the redacted values in order.
/// A value after a secret name, as in `password=[1,2]`, is secret as a whole. The search goes
/// on after each value, so each byte is read at most twice.
fn mask_json_values(text: &str, lighthouse: bool) -> (String, Vec<String>) {
    let mut masked = String::with_capacity(text.len());
    let mut values = Vec::new();
    let end = text.trim_end_matches(['\r', '\n']).len();
    let mut last = 0;
    while let Some(offset) = text[last..end].find(['{', '[']) {
        let start = last + offset;
        let prefix = &text[last..start];
        push_plain(&mut masked, prefix);
        let secret = assigns_secret(prefix);
        last = match json_value_end(&text.as_bytes()[start..]) {
            Some(length) => {
                let json = &text[start..start + length];
                values.push(redact_json_text(json, secret, lighthouse));
                masked.push_str(&format!("{VALUE_START}{}{VALUE_END}", values.len() - 1));
                start + length
            }
            None => push_broken_json(&text[start..end], (secret, lighthouse), &mut masked) + start,
        };
    }
    push_plain(&mut masked, &text[last..]);
    (masked, values)
}

/// Push JSON that breaks off, rewritten leniently up to where its outer container closes. It
/// stays plain text, so the plain-text rules still see it. After a closer that does not match
/// inside a secret value, the rest is redacted. Returns the length it used.
fn push_broken_json(text: &str, (secret, lighthouse): (bool, bool), masked: &mut String) -> usize {
    let rewrite = rewrite_json(text, secret, (lighthouse, true));
    push_plain(masked, &rewrite.stored);
    if rewrite.uncertain {
        masked.push_str(REDACTED);
        return text.len();
    }
    rewrite.used
}

fn push_plain(masked: &mut String, text: &str) {
    if text.contains(VALUE_START) {
        masked.push_str(&text.replace(VALUE_START, "\u{FDD0}x"));
    } else {
        masked.push_str(text);
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Expect {
    Value,
    /// Right after `[`.
    ValueOrClose,
    Key,
    /// Right after `{`.
    KeyOrClose,
    Colon,
    CommaOrClose,
}

/// Where the valid JSON object or array at the start of `bytes` ends. Numbers are checked as
/// text, nesting has no limit, and each byte is read once.
fn json_value_end(bytes: &[u8]) -> Option<usize> {
    let mut closers = Vec::new();
    let (mut expect, mut index) = (Expect::Value, 0);
    loop {
        index += bytes[index..]
            .iter()
            .take_while(|byte| matches!(byte, b' ' | b'\t' | b'\r' | b'\n'))
            .count();
        (expect, index) = json_token(bytes, index, expect, &mut closers)?;
        if closers.is_empty() {
            return Some(index);
        }
    }
}

/// Read one token. Returns what may follow it and the index after it.
fn json_token(
    bytes: &[u8],
    index: usize,
    expect: Expect,
    closers: &mut Vec<u8>,
) -> Option<(Expect, usize)> {
    let byte = *bytes.get(index)?;
    let value = matches!(expect, Expect::Value | Expect::ValueOrClose);
    let closes = matches!(
        expect,
        Expect::CommaOrClose | Expect::ValueOrClose | Expect::KeyOrClose
    ) && closers.last() == Some(&byte);
    Some(match byte {
        b'{' if value => {
            closers.push(b'}');
            (Expect::KeyOrClose, index + 1)
        }
        b'[' if value => {
            closers.push(b']');
            (Expect::ValueOrClose, index + 1)
        }
        b'}' | b']' if closes => {
            closers.pop();
            (Expect::CommaOrClose, index + 1)
        }
        b',' if expect == Expect::CommaOrClose && closers.last() == Some(&b'}') => {
            (Expect::Key, index + 1)
        }
        b',' if expect == Expect::CommaOrClose => (Expect::Value, index + 1),
        b':' if expect == Expect::Colon => (Expect::Value, index + 1),
        b'"' if matches!(expect, Expect::Key | Expect::KeyOrClose) => {
            (Expect::Colon, json_string_end(bytes, index)?)
        }
        _ if value => (Expect::CommaOrClose, json_scalar_end(bytes, index)?),
        _ => return None,
    })
}

fn json_scalar_end(bytes: &[u8], start: usize) -> Option<usize> {
    let word = |word: &[u8]| {
        bytes[start..]
            .starts_with(word)
            .then_some(start + word.len())
    };
    match bytes[start] {
        b'"' => json_string_end(bytes, start),
        b'-' | b'0'..=b'9' => json_number_end(bytes, start),
        b't' => word(b"true"),
        b'f' => word(b"false"),
        b'n' => word(b"null"),
        _ => None,
    }
}

fn json_string_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut index = start + 1;
    loop {
        match *bytes.get(index)? {
            b'"' => return Some(index + 1),
            b'\\' => index += 1 + json_escape_len(&bytes[index + 1..])?,
            0..=0x1f => return None,
            _ => index += 1,
        }
    }
}

fn json_escape_len(rest: &[u8]) -> Option<usize> {
    match *rest.first()? {
        b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => Some(1),
        b'u' if rest.get(1..5)?.iter().all(u8::is_ascii_hexdigit) => Some(5),
        _ => None,
    }
}

fn json_number_end(bytes: &[u8], start: usize) -> Option<usize> {
    let digits = |from: usize| {
        let end = from
            + bytes[from..]
                .iter()
                .take_while(|byte| byte.is_ascii_digit())
                .count();
        (end > from).then_some(end)
    };
    let integer = start + usize::from(bytes[start] == b'-');
    let mut index = match bytes.get(integer)? {
        b'0' => integer + 1,
        _ => digits(integer)?,
    };
    if bytes.get(index) == Some(&b'.') {
        index = digits(index + 1)?;
    }
    if matches!(bytes.get(index), Some(b'e' | b'E')) {
        let sign = usize::from(matches!(bytes.get(index + 1), Some(b'+' | b'-')));
        index = digits(index + 1 + sign)?;
    }
    Some(index)
}

/// True when the text ends with a secret name and a separator, as in `password=` or
/// `"password": `. The name follows the rules for JSON keys.
fn assigns_secret(prefix: &str) -> bool {
    static ASSIGNMENT: OnceLock<Regex> = OnceLock::new();
    ASSIGNMENT
        .get_or_init(|| Regex::new(r#"([\w.-]+)"?[ \t]*[=:][ \t]*$"#).unwrap())
        .captures(prefix)
        .is_some_and(|captures| secret_key(&captures[1]))
}

#[derive(Clone, Copy, PartialEq)]
enum Key {
    /// The next string is a key.
    Expected,
    Plain,
    Secret,
    /// The top-level `audits` key of a Lighthouse report.
    Audits,
}

#[derive(Clone, Copy)]
enum Frame {
    Object {
        secret: bool,
        audit_map: bool,
        key: Key,
    },
    /// Only JSON that broke off gives an array a key, as in `["a" "token": "x"]`.
    Array { secret: bool, key: Key },
}

impl Frame {
    fn closer(&self) -> u8 {
        match self {
            Frame::Object { .. } => b'}',
            Frame::Array { .. } => b']',
        }
    }
}

/// Rewrite one JSON value. Under a secret key every string and number is replaced, in nested
/// values too; booleans and "true" or "false" strings stay, because they are flags. Keys and
/// other strings are redacted as text. Whitespace after the value is kept.
fn redact_json_text(json: &str, secret: bool, lighthouse: bool) -> String {
    let rewrite = rewrite_json(json, secret, (lighthouse, false));
    rewrite.stored + &json[rewrite.used..]
}

struct Rewrite {
    stored: String,
    used: usize,
    /// A closer did not match its container inside a secret value.
    uncertain: bool,
}

/// Rewrite JSON token by token until its outer container closes. JSON that is `broken` is read
/// leniently: other text is copied, or replaced under a secret key, and a closer that does not
/// match closes back to the container it matches. A string or word before a colon names a key,
/// even when the comma before it is missing. Its structure is a guess, so inside a secret
/// container its keys are replaced too.
fn rewrite_json(json: &str, secret: bool, (lighthouse, broken): (bool, bool)) -> Rewrite {
    let bytes = json.as_bytes();
    let mut frames: Vec<Frame> = Vec::new();
    let mut objects = 0;
    let mut stored = String::with_capacity(json.len());
    let mut index = 0;
    while index < bytes.len() {
        let inherited = inherited_secret(&frames, secret);
        let byte = bytes[index];
        let next = match byte {
            b'"' => push_string(
                json,
                index,
                (inherited, lighthouse, broken),
                &mut frames,
                &mut stored,
            ),
            b'-' | b'0'..=b'9' => Some(push_number(json, index, inherited, &mut stored)),
            b'{' | b'[' | b'}' | b']' | b':' | b',' | b' ' | b'\t' | b'\r' | b'\n' => {
                // Secrecy only grows inward, so `inherited` covers every open container.
                let mismatched =
                    matches!(byte, b'}' | b']') && frames.last().map(Frame::closer) != Some(byte);
                (!mismatched || !inherited).then(|| {
                    track_structure(byte, inherited, &mut frames, &mut objects);
                    stored.push(char::from(byte));
                    index + 1
                })
            }
            _ => push_word(
                json,
                index,
                (inherited, lighthouse),
                &mut frames,
                &mut stored,
            ),
        };
        let Some(next) = next else {
            return Rewrite {
                stored,
                used: index,
                uncertain: true,
            };
        };
        index = next;
        if frames.is_empty() {
            break;
        }
    }
    Rewrite {
        stored,
        used: index,
        uncertain: false,
    }
}

fn inherited_secret(frames: &[Frame], root: bool) -> bool {
    match frames.last() {
        Some(Frame::Object { secret, key, .. } | Frame::Array { secret, key }) => {
            *secret || *key == Key::Secret
        }
        None => root,
    }
}

/// Copy one string token, redacted, and return the index after it, or None when the structure
/// became uncertain inside a secret value.
fn push_string(
    json: &str,
    start: usize,
    (inherited, lighthouse, broken): (bool, bool, bool),
    frames: &mut [Frame],
    stored: &mut String,
) -> Option<usize> {
    let end = string_end(json.as_bytes(), start);
    let token = &json[start..end];
    let root = frames.len() == 1;
    match key_slot(frames, colon_follows(json.as_bytes(), end), inherited)? {
        Some((key, audit_map)) => {
            // A key that does not decode may hide a secret name.
            *key = serde_json::from_str::<String>(token).map_or(Key::Secret, |name| {
                key_kind(&name, audit_map, lighthouse && root)
            });
            stored.push_str(&redact_json_string(token, broken && inherited));
        }
        None => stored.push_str(&redact_json_string(token, inherited)),
    }
    Some(end)
}

/// The key a string or word names, with whether it is in a Lighthouse audit map, or None for a
/// value. A token before a colon names a key even without the comma before it; inside a secret
/// value that leaves the structure uncertain, which is the outer None.
fn key_slot(
    frames: &mut [Frame],
    colon: bool,
    inherited: bool,
) -> Option<Option<(&mut Key, bool)>> {
    let (key, audit_map) = match frames.last_mut() {
        Some(Frame::Object { key, audit_map, .. }) => (key, *audit_map),
        Some(Frame::Array { key, .. }) => (key, false),
        None => return Some(None),
    };
    let current = *key;
    match current {
        Key::Expected => Some(Some((key, audit_map))),
        _ if !colon => Some(None),
        _ if inherited => None,
        _ => Some(Some((key, audit_map))),
    }
}

fn colon_follows(bytes: &[u8], end: usize) -> bool {
    bytes[end..]
        .iter()
        .find(|byte| !matches!(byte, b' ' | b'\t' | b'\r' | b'\n'))
        == Some(&b':')
}

/// An audit id in a Lighthouse report, such as `third-party-cookies`, is not a secret key.
fn key_kind(name: &str, audit_map: bool, lighthouse_root: bool) -> Key {
    if audit_map {
        Key::Plain
    } else if lighthouse_root && name == "audits" {
        Key::Audits
    } else if secret_key(name) {
        Key::Secret
    } else {
        Key::Plain
    }
}

/// Copy a run of other text from JSON that broke off, such as `INFO` in `[INFO]`. In a key
/// position it names the key; under a secret key it is replaced unless it is a flag.
fn push_word(
    json: &str,
    start: usize,
    (inherited, lighthouse): (bool, bool),
    frames: &mut [Frame],
    stored: &mut String,
) -> Option<usize> {
    let length = json.as_bytes()[start..]
        .iter()
        .take_while(|byte| {
            !matches!(
                byte,
                b'"' | b'{' | b'[' | b'}' | b']' | b':' | b',' | b' ' | b'\t' | b'\r' | b'\n'
            )
        })
        .count();
    let end = start + length;
    let word = &json[start..end];
    let root = frames.len() == 1;
    match key_slot(frames, colon_follows(json.as_bytes(), end), inherited)? {
        Some((key, audit_map)) => {
            *key = key_kind(word, audit_map, lighthouse && root);
            stored.push_str(if inherited { REDACTED } else { word });
        }
        None if inherited && !is_flag(word) && word != "null" => stored.push_str(REDACTED),
        None => stored.push_str(word),
    }
    Some(end)
}

/// Copy one number token as written, or replace it under a secret key.
fn push_number(json: &str, start: usize, inherited: bool, stored: &mut String) -> usize {
    let length = json.as_bytes()[start..]
        .iter()
        .take_while(|byte| matches!(byte, b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E'))
        .count();
    let end = start + length;
    stored.push_str(if inherited {
        "\"[REDACTED]\""
    } else {
        &json[start..end]
    });
    end
}

/// `objects` counts the open objects, so a closer that matches no container costs O(1).
fn track_structure(byte: u8, inherited: bool, frames: &mut Vec<Frame>, objects: &mut usize) {
    match byte {
        b'{' => {
            *objects += 1;
            let audit_map = matches!(
                frames.last(),
                Some(Frame::Object {
                    key: Key::Audits,
                    ..
                })
            );
            frames.push(Frame::Object {
                secret: inherited,
                audit_map,
                key: Key::Expected,
            });
        }
        b'[' => frames.push(Frame::Array {
            secret: inherited,
            key: Key::Plain,
        }),
        b'}' | b']' => close_container(byte, frames, objects),
        b',' => match frames.last_mut() {
            Some(Frame::Object { key, .. }) => *key = Key::Expected,
            Some(Frame::Array { key, .. }) => *key = Key::Plain,
            None => {}
        },
        _ => {}
    }
}

/// Close back to the container this closer matches. A closer that matches none is text.
fn close_container(closer: u8, frames: &mut Vec<Frame>, objects: &mut usize) {
    let open = if closer == b'}' {
        *objects
    } else {
        frames.len() - *objects
    };
    if open == 0 {
        return;
    }
    while let Some(frame) = frames.pop() {
        *objects -= usize::from(matches!(frame, Frame::Object { .. }));
        if frame.closer() == closer {
            break;
        }
    }
}

fn string_end(bytes: &[u8], start: usize) -> usize {
    let mut index = start + 1;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 2,
            b'"' => return index + 1,
            _ => index += 1,
        }
    }
    bytes.len()
}

/// A string that does not decode, such as one that ends in half of an emoji or lacks its closing
/// quote, is replaced whole. Raw control characters, as in JSON that broke off, are allowed.
fn redact_json_string(token: &str, secret: bool) -> String {
    let decoded = serde_json::from_str::<String>(token).or_else(|error| {
        let escaped: String = token
            .chars()
            .map(|c| match c {
                '\u{0}'..='\u{1f}' => format!("\\u{:04x}", u32::from(c)),
                c => c.to_string(),
            })
            .collect();
        if escaped.len() == token.len() {
            Err(error)
        } else {
            serde_json::from_str::<String>(&escaped)
        }
    });
    let Ok(value) = decoded else {
        return format!("\"{REDACTED}\"");
    };
    if secret && !is_flag(&value) {
        return format!("\"{REDACTED}\"");
    }
    let redacted = redact_fragment(&value, false);
    if redacted == value {
        token.to_owned()
    } else {
        serde_json::to_string(&redacted).unwrap_or_else(|_| format!("\"{REDACTED}\""))
    }
}

fn secret_key(key: &str) -> bool {
    static KEY: OnceLock<Regex> = OnceLock::new();
    KEY.get_or_init(|| {
        // After token, a separator, capital, digit or the end must follow, so max_tokens and
        // tokenizer stay readable, as on the text path.
        Regex::new(
            r"(?i)api[_-]?key|secret|password|passwd|authorization|cookie|token(?:[_.-]|(?-i:[A-Z])|[0-9]|$)",
        )
        .unwrap()
    })
    .is_match(key)
}

/// Redact XML text, attribute values, comments and CDATA. A tag match honours quotes, so a
/// `>` inside an attribute value does not end the tag.
fn redact_markup(text: &str) -> String {
    static TOKEN: OnceLock<Regex> = OnceLock::new();
    let token = TOKEN.get_or_init(|| {
        Regex::new(r#"(?s)<!--(.*?)-->|<!\[CDATA\[(.*?)\]\]>|<(?:[^>"']|"[^"]*"|'[^']*')*>"#)
            .unwrap()
    });
    let mut stored = String::with_capacity(text.len());
    let mut last = 0;
    for found in token.captures_iter(text) {
        let whole = found.get(0).map_or(0..0, |m| m.range());
        stored.push_str(&redact_markup_text(&text[last..whole.start]));
        if let Some(comment) = found.get(1) {
            stored.push_str(&format!(
                "<!--{}-->",
                redact_fragment(comment.as_str(), false)
            ));
        } else if let Some(cdata) = found.get(2) {
            stored.push_str(&format!(
                "<![CDATA[{}]]>",
                redact_fragment(cdata.as_str(), false)
            ));
        } else {
            stored.push_str(&redact_tag(&text[whole.clone()]));
        }
        last = whole.end;
    }
    stored.push_str(&redact_markup_text(&text[last..]));
    stored
}

/// Redact one tag. Quoted attribute values are decoded first; the rest of the tag, such as a
/// DOCTYPE string or an unquoted value, is redacted as plain text.
fn redact_tag(tag: &str) -> String {
    static ATTRIBUTE: OnceLock<Regex> = OnceLock::new();
    let attribute = ATTRIBUTE
        .get_or_init(|| Regex::new(r#"([\w:.-]+)(\s*=\s*)(?:"([^"]*)"|'([^']*)')"#).unwrap());
    let mut stored = String::with_capacity(tag.len());
    let mut last = 0;
    for captures in attribute.captures_iter(tag) {
        let whole = captures.get(0).map_or(0..0, |found| found.range());
        stored.push_str(&redact_secrets(&tag[last..whole.start]));
        stored.push_str(&redact_attribute(&captures));
        last = whole.end;
    }
    stored.push_str(&redact_secrets(&tag[last..]));
    stored
}

fn redact_attribute(captures: &regex::Captures<'_>) -> String {
    let (quote, raw) = match captures.get(3) {
        Some(value) => ('"', value.as_str()),
        None => ('\'', captures.get(4).map_or("", |value| value.as_str())),
    };
    let value = decode_xml(raw);
    let redacted = if secret_key(&captures[1]) && !is_flag(&value) {
        REDACTED.to_owned()
    } else {
        redact_fragment(&value, false)
    };
    if redacted == value {
        return captures[0].to_owned();
    }
    let encoded = encode_xml(&redacted, true);
    format!("{}{}{quote}{encoded}{quote}", &captures[1], &captures[2])
}

fn redact_markup_text(text: &str) -> String {
    let value = decode_xml(text);
    let redacted = redact_fragment(&value, false);
    if redacted == value {
        text.to_owned()
    } else {
        encode_xml(&redacted, false)
    }
}

/// Decode entity and character references. Any other reference, or a raw `KEPT`, stays behind
/// `KEPT` as written, so a decoded `&amp;x;` differs from a kept `&x;`.
fn decode_xml(text: &str) -> String {
    static REFERENCE: OnceLock<Regex> = OnceLock::new();
    let reference =
        REFERENCE.get_or_init(|| Regex::new(&format!(r"&({XML_REFERENCE});|\x{{FDD2}}")).unwrap());
    reference
        .replace_all(text, |captures: &regex::Captures<'_>| {
            let Some(name) = captures.get(1).map(|name| name.as_str()) else {
                return format!("{KEPT}#xFDD2;");
            };
            decode_reference(name).map_or_else(|| format!("{KEPT}{name};"), String::from)
        })
        .into_owned()
}

/// Decode one reference. Unknown entities, control characters and noncharacters stay as
/// written.
fn decode_reference(name: &str) -> Option<char> {
    let decoded = match name.strip_prefix('#') {
        Some(number) => match number.strip_prefix(['x', 'X']) {
            Some(hex) => u32::from_str_radix(hex, 16).ok(),
            None => number.parse().ok(),
        }
        .and_then(char::from_u32),
        None => named_entity(name),
    }?;
    let control = decoded.is_control() && !matches!(decoded, '\t' | '\n' | '\r');
    let noncharacter =
        ('\u{FDD0}'..='\u{FDEF}').contains(&decoded) || u32::from(decoded) & 0xFFFE == 0xFFFE;
    (!control && !noncharacter).then_some(decoded)
}

fn named_entity(name: &str) -> Option<char> {
    match name {
        "lt" => Some('<'),
        "gt" => Some('>'),
        "amp" => Some('&'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        _ => None,
    }
}

/// Encode markup characters and restore kept references. An attribute keeps its line breaks
/// and tabs as character references.
fn encode_xml(text: &str, attribute: bool) -> String {
    static SPECIAL: OnceLock<Regex> = OnceLock::new();
    let special = SPECIAL.get_or_init(|| {
        Regex::new(&format!(
            r#"\x{{FDD2}}((?:{XML_REFERENCE});)|[&<>"'\n\r\t\x{{FDD2}}]"#
        ))
        .unwrap()
    });
    special
        .replace_all(text, |captures: &regex::Captures<'_>| {
            if let Some(reference) = captures.get(1) {
                return format!("&{}", reference.as_str());
            }
            match &captures[0] {
                "<" => "&lt;",
                ">" => "&gt;",
                "\"" => "&quot;",
                "'" => "&apos;",
                "\n" if attribute => "&#10;",
                "\r" if attribute => "&#13;",
                "\t" if attribute => "&#9;",
                "&" | "\u{FDD2}" => "&amp;",
                other => other,
            }
            .to_owned()
        })
        .into_owned()
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    fn parse_json(text: &str) -> Value {
        serde_json::from_str(text).unwrap_or_else(|error| panic!("{error}: {text}"))
    }

    #[test]
    fn structured_text_stays_parseable_and_unchanged_text_stays_byte_for_byte() {
        let json = "{\"log\":\"token=\",\"n\":1}";
        assert_eq!(
            redact_text_artifact(json, ArtifactOrigin::DevtoolsConsole),
            json
        );
        let tree = r#"<hierarchy><node text="Password:" password="true" bounds="[0,0][9,9]"/><node text="token=" bounds="[0,9][9,18]"/></hierarchy>"#;
        assert_eq!(
            redact_text_artifact(tree, ArtifactOrigin::AndroidUiTree),
            tree
        );
        let pretty = "{\n  \"a\": 1\n}\n";
        assert_eq!(
            redact_text_artifact(pretty, ArtifactOrigin::Lighthouse),
            pretty
        );
    }

    #[test]
    fn decoded_values_lose_secrets_behind_escaped_or_encoded_quotes() {
        let tree = r#"<node text="password=&quot;first secondsecret&quot;" desc='a &gt; b'>token=abc &amp; more</node>"#;
        let stored = redact_text_artifact(tree, ArtifactOrigin::AndroidUiTree);
        assert!(
            !stored.contains("secondsecret") && !stored.contains("abc"),
            "{stored}"
        );
        assert!(
            stored.contains(r#"text="password=&quot;[REDACTED]&quot;""#),
            "{stored}"
        );
        assert!(stored.contains("desc='a &gt; b'"), "{stored}");

        let log = r#"{"log":"password=\"a\\\"tailsecret\" ok","n":1}"#;
        let stored = redact_text_artifact(log, ArtifactOrigin::DevtoolsConsole);
        assert!(!stored.contains("tailsecret"), "{stored}");
        assert_eq!(parse_json(&stored)["n"], 1);
    }

    #[test]
    fn secret_keys_lose_values_of_any_type_but_keep_flags() {
        let json = r#"{"password":123456,"auth":{"token":["t1"]},"cookies":{"sid":"c1"},"passwordField":false,"n":1}"#;
        let stored = parse_json(&redact_text_artifact(json, ArtifactOrigin::DevtoolsConsole));
        assert_eq!(stored["password"], REDACTED);
        assert_eq!(stored["auth"]["token"][0], REDACTED);
        assert_eq!(stored["cookies"]["sid"], REDACTED);
        assert_eq!(stored["passwordField"], false);
        let flag = r#"{"password":"false","n":1}"#;
        assert_eq!(
            redact_text_artifact(flag, ArtifactOrigin::DevtoolsAccessibility),
            flag
        );
        assert_eq!(stored["n"], 1);
    }

    #[test]
    fn json_keeps_numbers_spacing_and_order_and_redacts_keys() {
        let json = "{ \"password\": \"foo\",\n  \"n\": 9007199254740993.0, \"ghp_123456789\": {\"n\": 1e400} }";
        let stored = redact_text_artifact(json, ArtifactOrigin::DevtoolsAccessibility);
        assert_eq!(
            stored,
            "{ \"password\": \"[REDACTED]\",\n  \"n\": 9007199254740993.0, \"[REDACTED]\": {\"n\": 1e400} }"
        );
    }

    #[test]
    fn json_after_a_log_prefix_or_inside_a_string_is_redacted_as_json() {
        let log = "D/app: {\"password\":{\"value\":123456}}\nI/app: password=[1,2]\n{\"text\":\"{\\\"token\\\":{\\\"v\\\":7}}\"}\n";
        let stored = redact_text_artifact(log, ArtifactOrigin::AndroidLogcat);
        let lines: Vec<&str> = stored.lines().collect();
        assert_eq!(lines[0], "D/app: {\"password\":{\"value\":\"[REDACTED]\"}}");
        assert_eq!(lines[1], "I/app: password=[REDACTED]");
        let nested = parse_json(lines[2]);
        let inner = parse_json(nested["text"].as_str().unwrap());
        assert_eq!(inner["token"]["v"], REDACTED);
    }

    #[test]
    fn xml_comments_and_cdata_are_redacted_and_keep_their_delimiters() {
        let tree = "<hierarchy><!-- password=commentsecret --><![CDATA[a > password=cdatasecret]]><node text=\"x\"/></hierarchy>";
        let stored = redact_text_artifact(tree, ArtifactOrigin::AtspiTree);
        assert_eq!(
            stored,
            "<hierarchy><!-- password=[REDACTED] --><![CDATA[a > password=[REDACTED]]]><node text=\"x\"/></hierarchy>"
        );
    }

    #[test]
    fn lighthouse_audit_ids_and_token_counts_keep_their_values() {
        let report = r#"{"audits":{"third-party-cookies":{"id":"third-party-cookies","score":1,"cookie":"sid=c1"}},"usage":{"max_tokens":9,"tokenizer":{"m":"x"}}}"#;
        let stored = parse_json(&redact_text_artifact(report, ArtifactOrigin::Lighthouse));
        let audit = &stored["audits"]["third-party-cookies"];
        assert_eq!(audit["id"], "third-party-cookies");
        assert_eq!(audit["score"], 1);
        assert_eq!(audit["cookie"], REDACTED);
        assert_eq!(stored["usage"]["max_tokens"], 9);
        assert_eq!(stored["usage"]["tokenizer"]["m"], "x");
        let console = r#"{"cookies":{"sid":"c1"},"accessToken":"t1"}"#;
        let stored = parse_json(&redact_text_artifact(
            console,
            ArtifactOrigin::DevtoolsConsole,
        ));
        assert_eq!(stored["cookies"]["sid"], REDACTED);
        assert_eq!(stored["accessToken"], REDACTED);
    }

    #[test]
    fn markup_redacts_doctype_and_unquoted_text_and_keeps_line_breaks_encoded() {
        let tree = "<!DOCTYPE h [ <!ENTITY s \"api_key=dtsecret1\"> ]><h><input value=x token=abc/><node text=\"line1&#10;token=t2\" desc=\"a&nbsp;b\"/></h>";
        let stored = redact_text_artifact(tree, ArtifactOrigin::AtspiTree);
        for secret in ["dtsecret1", "abc", "t2"] {
            assert!(!stored.contains(secret), "{secret} in {stored}");
        }
        assert!(
            stored.contains(r#"text="line1&#10;token=[REDACTED]""#),
            "{stored}"
        );
        assert!(stored.contains(r#"desc="a&nbsp;b""#), "{stored}");
    }

    #[test]
    fn log_lines_that_are_json_are_redacted_as_json() {
        let log = "I/app: start\n  {\"password\":42,\"msg\":\"token=\"}\nD/app: Authorization: Digest username=\"alice\", response=\"digestsecret123\"\n";
        let stored = redact_text_artifact(log, ArtifactOrigin::AndroidLogcat);
        let lines: Vec<&str> = stored.lines().collect();
        assert_eq!(lines[0], "I/app: start");
        assert!(lines[1].starts_with("  {"), "{stored}");
        assert_eq!(parse_json(lines[1])["password"], REDACTED);
        assert_eq!(parse_json(lines[1])["msg"], "token=");
        assert_eq!(lines[2], "D/app: Authorization: [REDACTED]");
    }

    #[test]
    fn json_inside_a_log_line_is_redacted_and_keeps_the_line_context() {
        let log = "D/app: {\"password\":{\"value\":\"hunter2\"}} elapsed=1ms\nD/net: Cookie: a=b; c=[1]; d=cookiesecret\nW/app: {\"user\":\"a\",\"password\":{\"value\":\"cut1\"}\nI/app max_tokens=[100,200] tokenizer={\"model\":\"m\"} bounds=[0,0][9,9]\n";
        let stored = redact_text_artifact(log, ArtifactOrigin::AndroidLogcat);
        let lines: Vec<&str> = stored.lines().collect();
        assert_eq!(
            lines[0],
            "D/app: {\"password\":{\"value\":\"[REDACTED]\"}} elapsed=1ms"
        );
        assert_eq!(lines[1], "D/net: Cookie: [REDACTED]");
        assert!(!lines[2].contains("cut1"), "{stored}");
        assert_eq!(
            lines[3],
            "I/app max_tokens=[100,200] tokenizer={\"model\":\"m\"} bounds=[0,0][9,9]"
        );
    }

    #[test]
    fn json_in_a_line_has_no_depth_or_number_limit_and_invalid_json_keeps_its_context() {
        let deep = format!(
            "D/app: {{\"password\":{}\"hunter1\"{}}} took 3ms",
            "{\"v\":".repeat(33),
            "}".repeat(33)
        );
        let stored = redact_text_artifact(&deep, ArtifactOrigin::AndroidLogcat);
        assert!(!stored.contains("hunter1"), "{stored}");
        let brackets = format!(
            "{} {{\"password\":{{\"value\":\"hunter2\"}}}}",
            "[".repeat(4096)
        );
        let stored = redact_text_artifact(&brackets, ArtifactOrigin::AndroidLogcat);
        assert!(!stored.contains("hunter2"), "{stored}");
        let log = "D/app: {\"password\":{\"value\":\"hunter3\",\"n\":1e400}}\nI/app: [1, \"password\": \"hunter4\"]\nI/app: {\"password\":{\"v\":\"hunter5\"}, bad\nI/app: [\"a\tb\", \"token=hunter6\"]\n";
        let stored = redact_text_artifact(log, ArtifactOrigin::AndroidLogcat);
        let lines: Vec<&str> = stored.lines().collect();
        assert_eq!(
            lines[0],
            "D/app: {\"password\":{\"value\":\"[REDACTED]\",\"n\":\"[REDACTED]\"}}"
        );
        for secret in ["hunter4", "hunter5", "hunter6"] {
            assert!(!stored.contains(secret), "{secret} in {stored}");
        }
        assert!(lines[3].starts_with("I/app: [\"a\tb\", "), "{stored}");
    }

    #[test]
    fn json_that_breaks_inside_a_secret_value_loses_the_rest_of_that_value() {
        let log = "D/app: {\"password\":{\"n\":1e+,\"value\":\"hunter7\"}} took 3ms\nD/app: {\"password\":{\"value\":\"hunter8\nI/app: token: [none] received 5 items\n";
        let stored = redact_text_artifact(log, ArtifactOrigin::AndroidLogcat);
        let lines: Vec<&str> = stored.lines().collect();
        assert_eq!(
            lines[0],
            "D/app: {\"password\":{\"[REDACTED]\":\"[REDACTED]\",\"[REDACTED]\":\"[REDACTED]\"}} took 3ms"
        );
        assert_eq!(
            lines[1],
            "D/app: {\"password\":{\"[REDACTED]\":\"[REDACTED]\""
        );
        assert_eq!(lines[2], "I/app: token: [REDACTED] received 5 items");
        assert!(stored.ends_with('\n'), "{stored}");
        let broken = "{\"password\":[1e+},\"hunter10\"]}\n{\"password\":{\"n\":1e+},\"api\\u005fkey\":\"hunter11\"}\n{\"a\":1e+,\"pass\\u0077ord\":{\"v\":\"hunter12\"}} [INFO] ok\n{\"password\":{1e+,\"hunter14\"}}\n";
        let stored = redact_text_artifact(broken, ArtifactOrigin::AndroidLogcat);
        for secret in ["hunter10", "hunter11", "hunter12", "hunter14"] {
            assert!(!stored.contains(secret), "{secret} in {stored}");
        }
        assert!(
            stored.lines().nth(2).unwrap().ends_with(" [INFO] ok"),
            "{stored}"
        );
        let stray = r#"{"a":1] , "pass\u0077ord": "hunter13"} [INFO]"#;
        let stored = redact_text_artifact(stray, ArtifactOrigin::AndroidLogcat);
        assert_eq!(stored, r#"{"a":1] , "pass\u0077ord": "[REDACTED]"} [INFO]"#);
        let json = r#"{"password\ud800":"hunter9","n":1}"#;
        assert_eq!(
            redact_text_artifact(json, ArtifactOrigin::DevtoolsConsole),
            r#"{"[REDACTED]":"[REDACTED]","n":1}"#
        );
    }

    #[test]
    fn json_with_a_missing_comma_still_finds_later_secret_keys() {
        let log = r#"{"a":1 "password":{"value":"hunter20"}} [INFO] ok
{"a":1 "pass\u0077ord":"hunter15"} took 3ms
["x" "pass\u0077ord":"hunter16"] ok
{"a":"b" password:hunter17, "n":2} ok
{"password":"hunter18" "a":"hunter19"} ok
{"password":"hunter21" : "hunter22"} ok
"#;
        let stored = redact_text_artifact(log, ArtifactOrigin::AndroidLogcat);
        let lines: Vec<&str> = stored.lines().collect();
        assert_eq!(
            lines[0],
            r#"{"a":1 "password":{"[REDACTED]":"[REDACTED]"}} [INFO] ok"#
        );
        assert_eq!(lines[1], r#"{"a":1 "pass\u0077ord":"[REDACTED]"} took 3ms"#);
        assert_eq!(lines[2], r#"["x" "pass\u0077ord":"[REDACTED]"] ok"#);
        for secret in ["hunter17", "hunter18", "hunter19", "hunter21", "hunter22"] {
            assert!(!stored.contains(secret), "{secret} in {stored}");
        }
        assert!(lines[3].ends_with(r#", "n":2} ok"#), "{stored}");
    }

    #[test]
    fn json_in_a_line_accepts_lone_surrogates_and_deep_lighthouse_reports() {
        let line = r#"D/app: {"credentials":{"token":{"value":"t1","label":"\ud83d"}}}"#;
        assert_eq!(
            redact_text_artifact(line, ArtifactOrigin::DevtoolsConsole),
            r#"D/app: {"credentials":{"token":{"value":"[REDACTED]","label":"[REDACTED]"}}}"#
        );
        let html = format!(
            "<script>window.__LIGHTHOUSE_JSON__ = {{\"audits\":{{\"third-party-cookies\":{{\"id\":\"third-party-cookies\",\"score\":1}},\"script-treemap-data\":{{\"details\":{{\"nodes\":{}1{}}}}}}}}};</script>",
            "[".repeat(40),
            "]".repeat(40)
        );
        let stored = redact_text_artifact(&html, ArtifactOrigin::Lighthouse);
        assert_eq!(stored, html);
    }

    #[test]
    fn literal_markers_in_the_input_stay_as_written() {
        let line = "D/app: \u{FDD0}0\u{FDD1} [] \u{FDD0}x token=abc\n";
        assert_eq!(
            redact_text_artifact(line, ArtifactOrigin::AndroidLogcat),
            "D/app: \u{FDD0}0\u{FDD1} [] \u{FDD0}x token=[REDACTED]\n"
        );
        let json = "{\"s\":\"\u{FDD0}0\u{FDD1} []\"}";
        assert_eq!(
            redact_text_artifact(json, ArtifactOrigin::DevtoolsConsole),
            json
        );
    }

    #[test]
    fn lighthouse_keeps_audit_ids_only_and_nested_secrets_stay_covered() {
        let report = r#"{"cookies":{"sid":"session123"},"audits":{"third-party-cookies":{"id":"third-party-cookies","details":{"password":{"value":"p1"}}}}}"#;
        let stored = parse_json(&redact_text_artifact(report, ArtifactOrigin::Lighthouse));
        assert_eq!(stored["cookies"]["sid"], REDACTED);
        let audit = &stored["audits"]["third-party-cookies"];
        assert_eq!(audit["id"], "third-party-cookies");
        assert_eq!(audit["details"]["password"]["value"], REDACTED);
        let line = "password={\"v\":1}\n";
        assert_eq!(
            redact_text_artifact(line, ArtifactOrigin::Lighthouse),
            "password=[REDACTED]\n"
        );
    }

    #[test]
    fn json_strings_that_do_not_decode_are_replaced_whole() {
        let json = r#"{"msg":"token=abc \ud83d","password\ud800":"pw1","n":1}"#;
        assert_eq!(
            redact_text_artifact(json, ArtifactOrigin::DevtoolsConsole),
            r#"{"msg":"[REDACTED]","[REDACTED]":"[REDACTED]","n":1}"#
        );
    }

    #[test]
    fn rewritten_xml_keeps_literal_ampersands_and_kept_references_apart() {
        let doubled = "<h><node text=\"Tom &amp;amp; Jerry &amp;nbsp; token=abc\"/><n>x &amp;lt; y password=zz</n></h>";
        assert_eq!(
            redact_text_artifact(doubled, ArtifactOrigin::AndroidUiTree),
            "<h><node text=\"Tom &amp;amp; Jerry &amp;nbsp; token=[REDACTED]\"/><n>x &amp;lt; y password=[REDACTED]</n></h>"
        );
        let tree = "<h><node text=\"&amp;bogus; password=abc\" desc=\"&amp;lt; token=t1\" hint=\"a&nbsp;b token=t2\" note=\"&#1;\u{FDD2} token=t3\"/></h>";
        let stored = redact_text_artifact(tree, ArtifactOrigin::AtspiTree);
        assert_eq!(
            stored,
            "<h><node text=\"&amp;bogus; password=[REDACTED]\" desc=\"&amp;lt; token=[REDACTED]\" hint=\"a&nbsp;b token=[REDACTED]\" note=\"&#1;&#xFDD2; token=[REDACTED]\"/></h>"
        );
    }
}
