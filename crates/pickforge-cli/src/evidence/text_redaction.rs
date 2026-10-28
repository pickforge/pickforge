//! Redaction for stored UI trees, logs and reports. A JSON string or an XML value is decoded,
//! redacted on its own and encoded again, so the document's quotes can never be mistaken for
//! a credential's quotes. Text that redaction does not change is stored byte for byte.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use super::{is_flag, redact_secrets, ArtifactOrigin};

const REDACTED: &str = "[REDACTED]";

pub(super) fn redact_text_artifact(text: &str, origin: ArtifactOrigin) -> String {
    if let Some(stored) = redact_json_document(text) {
        return stored;
    }
    let body = text.trim_start_matches('\u{feff}').trim_start();
    // Lighthouse HTML is stored as text: its script bodies are not markup.
    if body.starts_with('<') && origin != ArtifactOrigin::Lighthouse {
        return redact_markup(text);
    }
    text.split_inclusive('\n')
        .map(|line| redact_json_document(line).unwrap_or_else(|| redact_secrets(line)))
        .collect()
}

/// Redact a whole JSON document, or return None when the text is not one.
fn redact_json_document(text: &str) -> Option<String> {
    let body = text.trim_start_matches('\u{feff}').trim();
    if !matches!(body.as_bytes().first(), Some(b'{' | b'[')) {
        return None;
    }
    let value = serde_json::from_str::<Value>(body).ok()?;
    let redacted = redact_json(value.clone(), false);
    if redacted == value {
        return Some(text.to_owned());
    }
    let json = if body.contains('\n') {
        serde_json::to_string_pretty(&redacted)
    } else {
        serde_json::to_string(&redacted)
    };
    let start = text.len() - text.trim_start().len();
    let end = text.trim_end().len();
    Some(format!("{}{}{}", &text[..start], json.ok()?, &text[end..]))
}

/// Under a secret key every number and string is replaced, whatever its type. Booleans and
/// "true" or "false" strings stay, because they are flags rather than credentials.
fn redact_json(value: Value, secret: bool) -> Value {
    match value {
        Value::String(text) if secret && is_flag(&text) => Value::String(text),
        Value::String(_) | Value::Number(_) if secret => Value::String(REDACTED.into()),
        Value::String(text) => Value::String(redact_secrets(&text)),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| redact_json(item, secret))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, item)| {
                    let item = redact_json(item, secret || secret_key(&key));
                    (key, item)
                })
                .collect(),
        ),
        other => other,
    }
}

fn secret_key(key: &str) -> bool {
    static KEY: OnceLock<Regex> = OnceLock::new();
    KEY.get_or_init(|| {
        Regex::new(r"(?i)api[_-]?key|token|secret|password|passwd|authorization|cookie").unwrap()
    })
    .is_match(key)
}

/// Redact XML text and attribute values. A tag match honours quotes, so a `>` inside an
/// attribute value does not end the tag.
fn redact_markup(text: &str) -> String {
    static TAG: OnceLock<Regex> = OnceLock::new();
    let tag = TAG.get_or_init(|| Regex::new(r#"<(?:[^>"']|"[^"]*"|'[^']*')*>"#).unwrap());
    let mut stored = String::with_capacity(text.len());
    let mut last = 0;
    for found in tag.find_iter(text) {
        stored.push_str(&redact_markup_text(&text[last..found.start()]));
        stored.push_str(&redact_tag(found.as_str()));
        last = found.end();
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
                redact_secrets(&value)
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
    let redacted = redact_secrets(&value);
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
