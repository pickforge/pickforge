//! Redaction for stored UI trees, logs and reports. A JSON string or an XML value is decoded,
//! redacted on its own and encoded again, so the document's quotes can never be mistaken for
//! a credential's quotes. JSON is rewritten token by token, so numbers, spacing and key order
//! stay as written. Text that redaction does not change is stored byte for byte.

use std::fmt;
use std::sync::OnceLock;

use regex::Regex;
use serde::de::{self, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};

use super::{is_flag, redact_secrets, ArtifactOrigin};

const REDACTED: &str = "[REDACTED]";
/// Noncharacters never appear in real documents. The first two wrap the index of a JSON value
/// masked in plain text; the third marks an XML reference that decoding keeps as written.
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
        && serde_json::from_str::<IgnoredAny>(body).is_ok()
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
    if values.is_empty() {
        return redact_secrets(text);
    }
    static MARKER: OnceLock<Regex> = OnceLock::new();
    let marker = MARKER.get_or_init(|| Regex::new(r"\x{FDD0}([0-9]+)\x{FDD1}").unwrap());
    marker
        .replace_all(
            &redact_secrets(&masked),
            |captures: &regex::Captures<'_>| {
                captures[1]
                    .parse::<usize>()
                    .ok()
                    .and_then(|index| values.get(index))
                    .map_or_else(|| captures[0].to_owned(), Clone::clone)
            },
        )
        .into_owned()
}

/// Replace each JSON object or array with a marker and return the redacted values in order.
/// A value after a secret name, as in `password=[1,2]`, is secret as a whole. After 4096
/// brackets that start no JSON, the rest is plain text, so a line of brackets stays fast.
fn mask_json_values(text: &str, lighthouse: bool) -> (String, Vec<String>) {
    let mut masked = String::with_capacity(text.len());
    let mut values = Vec::new();
    let (mut last, mut from, mut misses) = (0, 0, 0);
    while let Some(offset) = text[from..].find(['{', '[']).filter(|_| misses < 4096) {
        let start = from + offset;
        let Some(length) = json_value_len(&text[start..]) else {
            misses += 1;
            from = start + 1;
            continue;
        };
        let prefix = &text[last..start];
        masked.push_str(prefix);
        let json = &text[start..start + length];
        values.push(redact_json_text(json, assigns_secret(prefix), lighthouse));
        masked.push_str(&format!("{VALUE_START}{}{VALUE_END}", values.len() - 1));
        last = start + length;
        from = last;
    }
    masked.push_str(&text[last..]);
    (masked, values)
}

/// The length of the JSON value at the start of the text, if one parses there.
fn json_value_len(text: &str) -> Option<usize> {
    let mut values = serde_json::Deserializer::from_str(text).into_iter::<Skipped>();
    matches!(values.next(), Some(Ok(_))).then(|| values.byte_offset())
}

/// A JSON value that is checked and dropped. `IgnoredAny` has no nesting limit, so each bracket
/// in a line of unclosed brackets would scan to the end; this stops 32 levels down, which keeps
/// the scan linear. Deeper JSON in a line is redacted as plain text.
struct Skipped;

impl<'de> Deserialize<'de> for Skipped {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(Skip(32)).map(|()| Skipped)
    }
}

#[derive(Clone, Copy)]
struct Skip(u8);

impl Skip {
    fn inner<E: de::Error>(self) -> Result<Self, E> {
        self.0
            .checked_sub(1)
            .map(Skip)
            .ok_or_else(|| E::custom("nested too deep"))
    }
}

impl<'de> de::DeserializeSeed<'de> for Skip {
    type Value = ();

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Skip {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_bool<E>(self, _: bool) -> Result<(), E> {
        Ok(())
    }

    fn visit_i64<E>(self, _: i64) -> Result<(), E> {
        Ok(())
    }

    fn visit_u64<E>(self, _: u64) -> Result<(), E> {
        Ok(())
    }

    fn visit_f64<E>(self, _: f64) -> Result<(), E> {
        Ok(())
    }

    fn visit_str<E>(self, _: &str) -> Result<(), E> {
        Ok(())
    }

    fn visit_unit<E>(self) -> Result<(), E> {
        Ok(())
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut items: A) -> Result<(), A::Error> {
        let inner = self.inner()?;
        while items.next_element_seed(inner)?.is_some() {}
        Ok(())
    }

    fn visit_map<A: MapAccess<'de>>(self, mut entries: A) -> Result<(), A::Error> {
        let inner = self.inner()?;
        while entries.next_key_seed(inner)?.is_some() {
            entries.next_value_seed(inner)?;
        }
        Ok(())
    }
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
    Array {
        secret: bool,
    },
}

/// Rewrite one valid JSON value. Under a secret key every string and number is replaced, in
/// nested values too; booleans and "true" or "false" strings stay, because they are flags.
/// Keys and other strings are redacted as text.
fn redact_json_text(json: &str, secret: bool, lighthouse: bool) -> String {
    let bytes = json.as_bytes();
    let mut frames: Vec<Frame> = Vec::new();
    let mut stored = String::with_capacity(json.len());
    let mut index = 0;
    while index < bytes.len() {
        let inherited = inherited_secret(&frames, secret);
        index = match bytes[index] {
            b'"' => push_string(
                json,
                index,
                (inherited, lighthouse),
                &mut frames,
                &mut stored,
            ),
            b'-' | b'0'..=b'9' => push_number(json, index, inherited, &mut stored),
            byte => {
                track_structure(byte, inherited, &mut frames);
                // Outside strings, valid JSON is ASCII.
                stored.push(char::from(byte));
                index + 1
            }
        };
    }
    stored
}

fn inherited_secret(frames: &[Frame], root: bool) -> bool {
    match frames.last() {
        Some(Frame::Object { secret, key, .. }) => *secret || *key == Key::Secret,
        Some(Frame::Array { secret }) => *secret,
        None => root,
    }
}

/// Copy one string token, redacted, and return the index after it.
fn push_string(
    json: &str,
    start: usize,
    (inherited, lighthouse): (bool, bool),
    frames: &mut [Frame],
    stored: &mut String,
) -> usize {
    let end = string_end(json.as_bytes(), start);
    let token = &json[start..end];
    let root = frames.len() == 1;
    match frames.last_mut() {
        Some(Frame::Object { key, audit_map, .. }) if *key == Key::Expected => {
            let name = serde_json::from_str(token).unwrap_or_else(|_| token.to_owned());
            *key = key_kind(&name, *audit_map, lighthouse && root);
            stored.push_str(&redact_json_string(token, false));
        }
        _ => stored.push_str(&redact_json_string(token, inherited)),
    }
    end
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

fn track_structure(byte: u8, inherited: bool, frames: &mut Vec<Frame>) {
    match byte {
        b'{' => {
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
        b'[' => frames.push(Frame::Array { secret: inherited }),
        b'}' | b']' => {
            frames.pop();
        }
        b',' => {
            if let Some(Frame::Object { key, .. }) = frames.last_mut() {
                *key = Key::Expected;
            }
        }
        _ => {}
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

/// A string that does not decode, such as one that ends in half of an emoji, is replaced whole.
fn redact_json_string(token: &str, secret: bool) -> String {
    let Ok(value) = serde_json::from_str::<String>(token) else {
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
