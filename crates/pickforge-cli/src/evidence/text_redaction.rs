//! Redaction for stored UI trees, logs and reports. A JSON string or an XML value is decoded,
//! redacted on its own and encoded again, so the document's quotes can never be mistaken for
//! a credential's quotes. JSON is rewritten token by token, so numbers, spacing and key order
//! stay as written. Text that redaction does not change is stored byte for byte.

use std::sync::OnceLock;

use regex::Regex;
use serde::de::IgnoredAny;

use super::{is_flag, redact_secrets, ArtifactOrigin};

const REDACTED: &str = "[REDACTED]";

pub(super) fn redact_text_artifact(text: &str, origin: ArtifactOrigin) -> String {
    let start = text.len()
        - text
            .trim_start_matches(['\u{feff}', ' ', '\t', '\r', '\n'])
            .len();
    let body = &text[start..];
    if matches!(body.as_bytes().first(), Some(b'{' | b'['))
        && serde_json::from_str::<IgnoredAny>(body).is_ok()
    {
        return format!("{}{}", &text[..start], redact_json_text(body, false));
    }
    // Lighthouse HTML is stored as text: its script bodies are not markup.
    if body.starts_with('<') && origin != ArtifactOrigin::Lighthouse {
        return redact_markup(text);
    }
    text.split_inclusive('\n').map(redact_fragment).collect()
}

/// Redact one line or one decoded value. A JSON value that runs to the end, as in
/// `D/app: {"password":1}`, is redacted as JSON; the text before it as plain text.
fn redact_fragment(text: &str) -> String {
    let mut from = 0;
    while let Some(offset) = text[from..].find(['{', '[']) {
        let start = from + offset;
        let json = text[start..].trim_end();
        if serde_json::from_str::<IgnoredAny>(json).is_ok() {
            let prefix = &text[..start];
            let end = start + json.len();
            return format!(
                "{}{}{}",
                redact_secrets(prefix),
                redact_json_text(json, assigns_secret(prefix)),
                &text[end..]
            );
        }
        from = start + 1;
    }
    redact_secrets(text)
}

/// True when the text ends with a secret name and a separator, as in `password=`.
fn assigns_secret(prefix: &str) -> bool {
    static ASSIGNMENT: OnceLock<Regex> = OnceLock::new();
    ASSIGNMENT
        .get_or_init(|| {
            Regex::new(
                r#"(?i)(?:api[_-]?key|token|secret|password|passwd|authorization|cookie)[\w.-]*"?[ \t]*[=:][ \t]*$"#,
            )
            .unwrap()
        })
        .is_match(prefix)
}

#[derive(Clone, Copy)]
enum Frame {
    Object {
        secret: bool,
        key: bool,
        key_secret: bool,
    },
    Array {
        secret: bool,
    },
}

/// Rewrite one valid JSON value. Under a secret key every string and number is replaced, in
/// nested values too; booleans and "true" or "false" strings stay, because they are flags.
/// Keys and other strings are redacted as text.
fn redact_json_text(json: &str, secret: bool) -> String {
    let bytes = json.as_bytes();
    let mut frames: Vec<Frame> = Vec::new();
    let mut stored = String::with_capacity(json.len());
    let mut index = 0;
    while index < bytes.len() {
        let inherited = inherited_secret(&frames, secret);
        index = match bytes[index] {
            b'"' => push_string(json, index, inherited, &mut frames, &mut stored),
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
        Some(Frame::Object {
            secret, key_secret, ..
        }) => *secret || *key_secret,
        Some(Frame::Array { secret }) => *secret,
        None => root,
    }
}

/// Copy one string token, redacted, and return the index after it.
fn push_string(
    json: &str,
    start: usize,
    inherited: bool,
    frames: &mut [Frame],
    stored: &mut String,
) -> usize {
    let end = string_end(json.as_bytes(), start);
    let token = &json[start..end];
    if let Some(Frame::Object {
        key: true,
        key_secret,
        ..
    }) = frames.last_mut()
    {
        let name: String = serde_json::from_str(token).unwrap_or_default();
        *key_secret = secret_key(&name);
        stored.push_str(&redact_json_string(token, false));
    } else {
        stored.push_str(&redact_json_string(token, inherited));
    }
    end
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
        b'{' => frames.push(Frame::Object {
            secret: inherited,
            key: true,
            key_secret: false,
        }),
        b'[' => frames.push(Frame::Array { secret: inherited }),
        b'}' | b']' => {
            frames.pop();
        }
        b':' | b',' => {
            if let Some(Frame::Object { key, .. }) = frames.last_mut() {
                *key = byte == b',';
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

fn redact_json_string(token: &str, secret: bool) -> String {
    let value: String = serde_json::from_str(token).unwrap_or_default();
    if secret && !is_flag(&value) {
        return format!("\"{REDACTED}\"");
    }
    let redacted = redact_fragment(&value);
    if redacted == value {
        token.to_owned()
    } else {
        serde_json::to_string(&redacted).unwrap_or_else(|_| format!("\"{REDACTED}\""))
    }
}

fn secret_key(key: &str) -> bool {
    static KEY: OnceLock<Regex> = OnceLock::new();
    KEY.get_or_init(|| {
        Regex::new(r"(?i)api[_-]?key|token|secret|password|passwd|authorization|cookie").unwrap()
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
            stored.push_str(&format!("<!--{}-->", redact_fragment(comment.as_str())));
        } else if let Some(cdata) = found.get(2) {
            stored.push_str(&format!("<![CDATA[{}]]>", redact_fragment(cdata.as_str())));
        } else {
            stored.push_str(&redact_tag(&text[whole.clone()]));
        }
        last = whole.end;
    }
    stored.push_str(&redact_markup_text(&text[last..]));
    stored
}

fn redact_tag(tag: &str) -> String {
    static ATTRIBUTE: OnceLock<Regex> = OnceLock::new();
    let attribute = ATTRIBUTE
        .get_or_init(|| Regex::new(r#"([\w:.-]+)(\s*=\s*)(?:"([^"]*)"|'([^']*)')"#).unwrap());
    attribute
        .replace_all(tag, |captures: &regex::Captures<'_>| {
            let (quote, raw) = match captures.get(3) {
                Some(value) => ('"', value.as_str()),
                None => ('\'', captures.get(4).map_or("", |value| value.as_str())),
            };
            let value = decode_xml(raw);
            let redacted = if secret_key(&captures[1]) && !is_flag(&value) {
                REDACTED.to_owned()
            } else {
                redact_fragment(&value)
            };
            if redacted == value {
                return captures[0].to_owned();
            }
            let encoded = encode_xml(&redacted);
            format!("{}{}{quote}{encoded}{quote}", &captures[1], &captures[2])
        })
        .into_owned()
}

fn redact_markup_text(text: &str) -> String {
    let value = decode_xml(text);
    let redacted = redact_fragment(&value);
    if redacted == value {
        text.to_owned()
    } else {
        encode_xml(&redacted)
    }
}

fn decode_xml(text: &str) -> String {
    static ENTITY: OnceLock<Regex> = OnceLock::new();
    let entity = ENTITY.get_or_init(|| {
        Regex::new(r"&(?:(lt|gt|amp|quot|apos)|#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6}));").unwrap()
    });
    entity
        .replace_all(text, |captures: &regex::Captures<'_>| {
            let decoded = match (captures.get(1), captures.get(2), captures.get(3)) {
                (Some(name), _, _) => named_entity(name.as_str()),
                (_, Some(decimal), _) => decimal.as_str().parse().ok().and_then(char::from_u32),
                (_, _, Some(hex)) => u32::from_str_radix(hex.as_str(), 16)
                    .ok()
                    .and_then(char::from_u32),
                _ => None,
            };
            decoded.map_or_else(|| captures[0].to_owned(), String::from)
        })
        .into_owned()
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

fn encode_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
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
        assert_eq!(lines[1], "I/app: password=[\"[REDACTED]\",\"[REDACTED]\"]");
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
}
