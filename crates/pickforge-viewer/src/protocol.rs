//! The stdio JSON-lines protocol from `PROTOCOL.md`.

use serde::Serialize;
use serde_json::Value;
use std::io::{self, BufRead, Write};

/// The longest message line, without its newline.
pub const MAX_LINE: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Thumbnail,
    Expanded,
    Fullscreen,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    Wayland,
    X11,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum EndReason {
    #[serde(rename = "x11-eof")]
    X11Eof,
    #[serde(rename = "xvfb-gone")]
    XvfbGone,
}

/// Events from the viewer to the host.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum Event {
    Ready {
        version: String,
        pid: u32,
        backend: Backend,
        scale: f64,
    },
    Mode {
        mode: Mode,
    },
    ExpandRequested,
    CollapseRequested,
    Closed,
    SessionEnded {
        reason: EndReason,
    },
    Error {
        code: String,
        message: String,
    },
    TakeRequested,
    ReturnRequested {
        reason: ReturnReason,
    },
    ControlAck {
        #[serde(rename = "leaseId")]
        lease_id: String,
        state: AckState,
    },
}

/// Why the viewer gave control back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReturnReason {
    Button,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AckState {
    Granted,
    Revoked,
}

/// Why the host ended control.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevokeReason {
    Returned,
    LeaseLost,
    SessionEnded,
    Stopping,
    Unavailable,
    /// A reason this version does not know. It still revokes.
    Other,
}

/// The longest attention message, in characters.
pub const MAX_ATTENTION_CHARS: usize = 500;
/// The longest lease id, in bytes.
pub const MAX_LEASE_ID: usize = 128;
/// The longest grant the viewer accepts. A longer one is shortened.
pub const MAX_GRANT_MS: u64 = 120_000;

/// The modes the host may set. Fullscreen belongs to the viewer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostMode {
    Thumbnail,
    Expanded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusCode {
    Connecting,
    SessionEnded,
    Stopping,
}

impl StatusCode {
    pub fn text(self) -> &'static str {
        match self {
            StatusCode::Connecting => "Connecting",
            StatusCode::SessionEnded => "Session ended",
            StatusCode::Stopping => "Stopping",
        }
    }
}

/// Commands from the host to the viewer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    SetMode {
        mode: HostMode,
        /// Inner size in logical pixels, when the host gave one.
        size: Option<(u32, u32)>,
    },
    Status(StatusCode),
    SessionEnded,
    Shutdown,
    Attention {
        message: String,
    },
    ClearAttention,
    Grant {
        lease_id: String,
        grant_ms: u64,
    },
    Revoke {
        lease_id: String,
        reason: RevokeReason,
    },
    /// An agent click completed at this session pixel.
    Pulse {
        x: u32,
        y: u32,
    },
    /// A command this version does not know. It is logged and ignored.
    Unknown(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    TooLong,
    NotJson,
    NotObject,
    MissingCmd,
    BadField(&'static str),
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::TooLong => write!(f, "message longer than {MAX_LINE} bytes"),
            ParseError::NotJson => f.write_str("message is not valid JSON"),
            ParseError::NotObject => f.write_str("message is not a JSON object"),
            ParseError::MissingCmd => f.write_str("message has no string cmd"),
            ParseError::BadField(field) => write!(f, "invalid field {field}"),
        }
    }
}

const MAX_LOGICAL_SIDE: f64 = 32767.0;

fn logical_side(value: Option<&Value>, field: &'static str) -> Result<Option<u32>, ParseError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let number = value.as_f64().ok_or(ParseError::BadField(field))?;
            if !(1.0..=MAX_LOGICAL_SIDE).contains(&number) {
                return Err(ParseError::BadField(field));
            }
            Ok(Some(number.round() as u32))
        }
    }
}

/// Parses one command line. Unknown fields are ignored.
pub fn parse_command(line: &[u8]) -> Result<Command, ParseError> {
    if line.len() > MAX_LINE {
        return Err(ParseError::TooLong);
    }
    let value: Value = serde_json::from_slice(line).map_err(|_| ParseError::NotJson)?;
    let object = value.as_object().ok_or(ParseError::NotObject)?;
    let cmd = object
        .get("cmd")
        .and_then(Value::as_str)
        .ok_or(ParseError::MissingCmd)?;
    Ok(match cmd {
        "setMode" => {
            let mode = match object.get("mode").and_then(Value::as_str) {
                Some("thumbnail") => HostMode::Thumbnail,
                Some("expanded") => HostMode::Expanded,
                _ => return Err(ParseError::BadField("mode")),
            };
            let width = logical_side(object.get("width"), "width")?;
            let height = logical_side(object.get("height"), "height")?;
            let size = match (width, height) {
                (Some(w), Some(h)) => Some((w, h)),
                (None, None) => None,
                _ => return Err(ParseError::BadField("width and height")),
            };
            Command::SetMode { mode, size }
        }
        "status" => Command::Status(match object.get("code").and_then(Value::as_str) {
            Some("connecting") => StatusCode::Connecting,
            Some("sessionEnded") => StatusCode::SessionEnded,
            Some("stopping") => StatusCode::Stopping,
            _ => return Err(ParseError::BadField("code")),
        }),
        "sessionEnded" => Command::SessionEnded,
        "shutdown" => Command::Shutdown,
        "attention" => Command::Attention {
            message: attention_message(object.get("message"))?,
        },
        "clearAttention" => Command::ClearAttention,
        "control" => control(object)?,
        "pulse" => Command::Pulse {
            x: session_coordinate(object.get("x"), "x")?,
            y: session_coordinate(object.get("y"), "y")?,
        },
        other => Command::Unknown(truncate(other, 64)),
    })
}

/// A session pixel coordinate: an integer from 0 to the X11 limit. The
/// viewer checks it against the session size.
fn session_coordinate(value: Option<&Value>, field: &'static str) -> Result<u32, ParseError> {
    value
        .and_then(Value::as_u64)
        .filter(|&n| n <= MAX_LOGICAL_SIDE as u64)
        .map(|n| n as u32)
        .ok_or(ParseError::BadField(field))
}

fn attention_message(value: Option<&Value>) -> Result<String, ParseError> {
    let message = value
        .and_then(Value::as_str)
        .ok_or(ParseError::BadField("message"))?;
    if message.chars().count() > MAX_ATTENTION_CHARS || message.chars().any(char::is_control) {
        return Err(ParseError::BadField("message"));
    }
    Ok(message.to_owned())
}

fn lease_id(value: Option<&Value>) -> Option<String> {
    let id = value?.as_str()?;
    (id.len() <= MAX_LEASE_ID && !id.chars().any(char::is_control)).then(|| id.to_owned())
}

/// A grant needs a valid lease id and duration. A revoke always revokes,
/// even with a missing or unknown field, so it fails closed.
fn control(object: &serde_json::Map<String, Value>) -> Result<Command, ParseError> {
    match object.get("state").and_then(Value::as_str) {
        Some("granted") => {
            let lease_id = lease_id(object.get("leaseId"))
                .filter(|id| !id.is_empty())
                .ok_or(ParseError::BadField("leaseId"))?;
            let grant_ms = object
                .get("grantMs")
                .and_then(Value::as_u64)
                .filter(|&ms| ms > 0)
                .ok_or(ParseError::BadField("grantMs"))?;
            Ok(Command::Grant {
                lease_id,
                grant_ms: grant_ms.min(MAX_GRANT_MS),
            })
        }
        Some("revoked") => Ok(Command::Revoke {
            lease_id: lease_id(object.get("leaseId")).unwrap_or_default(),
            reason: match object.get("reason").and_then(Value::as_str) {
                Some("returned") => RevokeReason::Returned,
                Some("lease-lost") => RevokeReason::LeaseLost,
                Some("session-ended") => RevokeReason::SessionEnded,
                Some("stopping") => RevokeReason::Stopping,
                Some("unavailable") => RevokeReason::Unavailable,
                _ => RevokeReason::Other,
            },
        }),
        _ => Err(ParseError::BadField("state")),
    }
}

fn truncate(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

/// Encodes one event as a line, newline included.
pub fn encode_event(event: &Event) -> String {
    let event = match event {
        Event::Error { code, message } => Event::Error {
            code: truncate(code, 64),
            message: truncate(message, 2000),
        },
        other => other.clone(),
    };
    let mut line = serde_json::to_string(&event).expect("events always serialize");
    line.push('\n');
    line
}

/// Writes one event and flushes it.
pub fn write_event(out: &mut impl Write, event: &Event) -> io::Result<()> {
    out.write_all(encode_event(event).as_bytes())?;
    out.flush()
}

/// One framed line from the host.
#[derive(Debug, PartialEq, Eq)]
pub enum Line {
    Message(Vec<u8>),
    /// A line over [`MAX_LINE`]. Its bytes were dropped.
    TooLong,
}

/// Splits a byte stream into lines without holding more than
/// [`MAX_LINE`] bytes of one line.
pub struct LineReader<R> {
    inner: R,
    buf: Vec<u8>,
    overflow: bool,
}

impl<R: BufRead> LineReader<R> {
    pub fn new(inner: R) -> Self {
        Self {
            inner,
            buf: Vec::new(),
            overflow: false,
        }
    }

    /// The next line, or `None` at end of file. A partial last line is
    /// dropped, because the host is gone.
    pub fn next_line(&mut self) -> io::Result<Option<Line>> {
        loop {
            let available = match self.inner.fill_buf() {
                Ok(bytes) => bytes,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            };
            if available.is_empty() {
                return Ok(None);
            }
            let newline = available.iter().position(|&b| b == b'\n');
            let take = newline.unwrap_or(available.len());
            if !self.overflow {
                if self.buf.len() + take > MAX_LINE + 1 {
                    self.overflow = true;
                    self.buf.clear();
                } else {
                    self.buf.extend_from_slice(&available[..take]);
                }
            }
            let consumed = newline.map_or(take, |at| at + 1);
            self.inner.consume(consumed);
            if newline.is_some() {
                return Ok(Some(self.finish_line()));
            }
        }
    }

    fn finish_line(&mut self) -> Line {
        if std::mem::take(&mut self.overflow) {
            return Line::TooLong;
        }
        let mut line = std::mem::take(&mut self.buf);
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        if line.len() > MAX_LINE {
            return Line::TooLong;
        }
        Line::Message(line)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor};

    #[test]
    fn encodes_events() {
        let cases = [
            (
                Event::Ready {
                    version: "0.6.0".into(),
                    pid: 7,
                    backend: Backend::X11,
                    scale: 1.5,
                },
                r#"{"event":"ready","version":"0.6.0","pid":7,"backend":"x11","scale":1.5}"#,
            ),
            (
                Event::Mode {
                    mode: Mode::Fullscreen,
                },
                r#"{"event":"mode","mode":"fullscreen"}"#,
            ),
            (Event::ExpandRequested, r#"{"event":"expandRequested"}"#),
            (Event::CollapseRequested, r#"{"event":"collapseRequested"}"#),
            (Event::Closed, r#"{"event":"closed"}"#),
            (
                Event::SessionEnded {
                    reason: EndReason::X11Eof,
                },
                r#"{"event":"sessionEnded","reason":"x11-eof"}"#,
            ),
            (
                Event::SessionEnded {
                    reason: EndReason::XvfbGone,
                },
                r#"{"event":"sessionEnded","reason":"xvfb-gone"}"#,
            ),
            (
                Event::Error {
                    code: "display".into(),
                    message: "a \"quoted\"\nline".into(),
                },
                r#"{"event":"error","code":"display","message":"a \"quoted\"\nline"}"#,
            ),
        ];
        for (event, json) in cases {
            assert_eq!(encode_event(&event), format!("{json}\n"));
        }
    }

    #[test]
    fn long_error_messages_stay_inside_one_line() {
        let event = Event::Error {
            code: "x".repeat(500),
            message: "\u{1}".repeat(MAX_LINE),
        };
        let line = encode_event(&event);
        assert!(line.len() <= MAX_LINE);
        assert_eq!(line.matches('\n').count(), 1);
    }

    #[test]
    fn parses_commands() {
        assert_eq!(
            parse_command(br#"{"cmd":"setMode","mode":"expanded","width":1280,"height":832}"#),
            Ok(Command::SetMode {
                mode: HostMode::Expanded,
                size: Some((1280, 832))
            })
        );
        assert_eq!(
            parse_command(br#"{"cmd":"setMode","mode":"thumbnail","extra":[1,2]}"#),
            Ok(Command::SetMode {
                mode: HostMode::Thumbnail,
                size: None
            })
        );
        assert_eq!(
            parse_command(br#"{"cmd":"setMode","mode":"expanded","width":640.4,"height":480.6}"#),
            Ok(Command::SetMode {
                mode: HostMode::Expanded,
                size: Some((640, 481))
            })
        );
        assert_eq!(
            parse_command(br#"{"cmd":"status","code":"connecting"}"#),
            Ok(Command::Status(StatusCode::Connecting))
        );
        assert_eq!(
            parse_command(br#"{"cmd":"status","code":"sessionEnded"}"#),
            Ok(Command::Status(StatusCode::SessionEnded))
        );
        assert_eq!(
            parse_command(br#"{"cmd":"status","code":"stopping"}"#),
            Ok(Command::Status(StatusCode::Stopping))
        );
        assert_eq!(
            parse_command(br#"{"cmd":"sessionEnded"}"#),
            Ok(Command::SessionEnded)
        );
        assert_eq!(
            parse_command(br#" {"cmd":"shutdown","why":null} "#),
            Ok(Command::Shutdown)
        );
        assert_eq!(
            parse_command(br#"{"cmd":"later","message":"help"}"#),
            Ok(Command::Unknown("later".into()))
        );
    }

    #[test]
    fn rejects_bad_commands() {
        assert_eq!(parse_command(b"not json"), Err(ParseError::NotJson));
        assert_eq!(parse_command(b"[1]"), Err(ParseError::NotObject));
        assert_eq!(parse_command(b"{}"), Err(ParseError::MissingCmd));
        assert_eq!(parse_command(br#"{"cmd":5}"#), Err(ParseError::MissingCmd));
        assert_eq!(
            parse_command(br#"{"cmd":"setMode","mode":"fullscreen"}"#),
            Err(ParseError::BadField("mode"))
        );
        assert_eq!(
            parse_command(br#"{"cmd":"setMode","mode":"expanded","width":100}"#),
            Err(ParseError::BadField("width and height"))
        );
        assert_eq!(
            parse_command(br#"{"cmd":"setMode","mode":"expanded","width":0,"height":5}"#),
            Err(ParseError::BadField("width"))
        );
        assert_eq!(
            parse_command(br#"{"cmd":"setMode","mode":"expanded","width":5,"height":"5"}"#),
            Err(ParseError::BadField("height"))
        );
        assert_eq!(
            parse_command(br#"{"cmd":"status","code":"nope"}"#),
            Err(ParseError::BadField("code"))
        );
        assert_eq!(
            parse_command(&vec![b' '; MAX_LINE + 1]),
            Err(ParseError::TooLong)
        );
        assert_eq!(
            parse_command(b"{\"cmd\":\"\xff\"}"),
            Err(ParseError::NotJson)
        );
    }

    #[test]
    fn encodes_control_events() {
        let cases = [
            (Event::TakeRequested, r#"{"event":"takeRequested"}"#),
            (
                Event::ReturnRequested {
                    reason: ReturnReason::Button,
                },
                r#"{"event":"returnRequested","reason":"button"}"#,
            ),
            (
                Event::ReturnRequested {
                    reason: ReturnReason::Closed,
                },
                r#"{"event":"returnRequested","reason":"closed"}"#,
            ),
            (
                Event::ControlAck {
                    lease_id: "L1".into(),
                    state: AckState::Granted,
                },
                r#"{"event":"controlAck","leaseId":"L1","state":"granted"}"#,
            ),
            (
                Event::ControlAck {
                    lease_id: String::new(),
                    state: AckState::Revoked,
                },
                r#"{"event":"controlAck","leaseId":"","state":"revoked"}"#,
            ),
        ];
        for (event, json) in cases {
            assert_eq!(encode_event(&event), format!("{json}\n"));
        }
    }

    #[test]
    fn parses_control_commands() {
        assert_eq!(
            parse_command(
                r#"{"cmd":"attention","message":"Entre com a sua senha, é rápido"}"#.as_bytes()
            ),
            Ok(Command::Attention {
                message: "Entre com a sua senha, é rápido".into()
            })
        );
        let longest = format!(r#"{{"cmd":"attention","message":"{}"}}"#, "é".repeat(500));
        assert!(matches!(
            parse_command(longest.as_bytes()),
            Ok(Command::Attention { .. })
        ));
        assert_eq!(
            parse_command(br#"{"cmd":"clearAttention"}"#),
            Ok(Command::ClearAttention)
        );
        assert_eq!(
            parse_command(br#"{"cmd":"control","state":"granted","leaseId":"L1","grantMs":10000}"#),
            Ok(Command::Grant {
                lease_id: "L1".into(),
                grant_ms: 10_000
            })
        );
        assert_eq!(
            parse_command(
                br#"{"cmd":"control","state":"granted","leaseId":"L1","grantMs":9999999}"#
            ),
            Ok(Command::Grant {
                lease_id: "L1".into(),
                grant_ms: MAX_GRANT_MS
            })
        );
        let reasons = [
            ("returned", RevokeReason::Returned),
            ("lease-lost", RevokeReason::LeaseLost),
            ("session-ended", RevokeReason::SessionEnded),
            ("stopping", RevokeReason::Stopping),
            ("unavailable", RevokeReason::Unavailable),
            ("later", RevokeReason::Other),
        ];
        for (name, reason) in reasons {
            let line = format!(
                r#"{{"cmd":"control","state":"revoked","leaseId":"L1","reason":"{name}"}}"#
            );
            assert_eq!(
                parse_command(line.as_bytes()),
                Ok(Command::Revoke {
                    lease_id: "L1".into(),
                    reason
                })
            );
        }
        // A revoke with bad fields still revokes.
        assert_eq!(
            parse_command(br#"{"cmd":"control","state":"revoked","leaseId":7}"#),
            Ok(Command::Revoke {
                lease_id: String::new(),
                reason: RevokeReason::Other
            })
        );
        assert_eq!(
            parse_command(
                br#"{"cmd":"control","state":"revoked","leaseId":"","reason":"unavailable"}"#
            ),
            Ok(Command::Revoke {
                lease_id: String::new(),
                reason: RevokeReason::Unavailable
            })
        );
    }

    #[test]
    fn parses_pulse_commands() {
        assert_eq!(
            parse_command(br#"{"cmd":"pulse","x":0,"y":599,"extra":true}"#),
            Ok(Command::Pulse { x: 0, y: 599 })
        );
        assert_eq!(
            parse_command(br#"{"cmd":"pulse","x":32767,"y":32767}"#),
            Ok(Command::Pulse { x: 32767, y: 32767 })
        );
        let bad = [
            (r#"{"cmd":"pulse","y":3}"#, "x"),
            (r#"{"cmd":"pulse","x":3}"#, "y"),
            (r#"{"cmd":"pulse","x":-1,"y":3}"#, "x"),
            (r#"{"cmd":"pulse","x":1.5,"y":3}"#, "x"),
            (r#"{"cmd":"pulse","x":"1","y":3}"#, "x"),
            (r#"{"cmd":"pulse","x":1,"y":32768}"#, "y"),
            (r#"{"cmd":"pulse","x":1,"y":null}"#, "y"),
        ];
        for (line, field) in bad {
            assert_eq!(
                parse_command(line.as_bytes()),
                Err(ParseError::BadField(field)),
                "{line}"
            );
        }
    }

    #[test]
    fn rejects_bad_control_commands() {
        let too_long = format!(r#"{{"cmd":"attention","message":"{}"}}"#, "a".repeat(501));
        let bad = [
            too_long.as_str(),
            r#"{"cmd":"attention"}"#,
            r#"{"cmd":"attention","message":5}"#,
            r#"{"cmd":"attention","message":"two\nlines"}"#,
            r#"{"cmd":"attention","message":"bell\u0007"}"#,
            r#"{"cmd":"control","state":"granted","grantMs":1000}"#,
            r#"{"cmd":"control","state":"granted","leaseId":"","grantMs":1000}"#,
            r#"{"cmd":"control","state":"granted","leaseId":"L1"}"#,
            r#"{"cmd":"control","state":"granted","leaseId":"L1","grantMs":0}"#,
            r#"{"cmd":"control","state":"granted","leaseId":"L1","grantMs":-5}"#,
            r#"{"cmd":"control","state":"granted","leaseId":"L1","grantMs":1.5}"#,
            r#"{"cmd":"control","state":"granted","leaseId":"L1","grantMs":"1000"}"#,
            r#"{"cmd":"control","state":"granted","leaseId":"a\tb","grantMs":1000}"#,
            r#"{"cmd":"control","state":"held","leaseId":"L1"}"#,
            r#"{"cmd":"control"}"#,
        ];
        for line in bad {
            assert!(
                matches!(parse_command(line.as_bytes()), Err(ParseError::BadField(_))),
                "{line}"
            );
        }
        let long_id = format!(
            r#"{{"cmd":"control","state":"granted","leaseId":"{}","grantMs":1000}}"#,
            "x".repeat(MAX_LEASE_ID + 1)
        );
        assert_eq!(
            parse_command(long_id.as_bytes()),
            Err(ParseError::BadField("leaseId"))
        );
    }

    fn lines(input: &[u8], capacity: usize) -> Vec<Line> {
        let mut reader = LineReader::new(BufReader::with_capacity(capacity, Cursor::new(input)));
        let mut out = Vec::new();
        while let Some(line) = reader.next_line().unwrap() {
            out.push(line);
        }
        out
    }

    #[test]
    fn frames_lines() {
        for capacity in [1, 3, 8192] {
            assert_eq!(
                lines(b"{\"a\":1}\n\r\n{\"b\":2}\r\npartial", capacity),
                vec![
                    Line::Message(b"{\"a\":1}".to_vec()),
                    Line::Message(Vec::new()),
                    Line::Message(b"{\"b\":2}".to_vec()),
                ]
            );
        }
    }

    #[test]
    fn drops_lines_over_the_limit_and_recovers() {
        let mut input = vec![b'x'; MAX_LINE];
        input.push(b'\n');
        input.extend(vec![b'y'; MAX_LINE + 1]);
        input.push(b'\n');
        input.extend(vec![b'z'; MAX_LINE * 3]);
        input.extend_from_slice(b"\n{\"cmd\":\"shutdown\"}\n");
        for capacity in [7, 8192, 200_000] {
            let out = lines(&input, capacity);
            assert_eq!(out.len(), 4, "capacity {capacity}");
            assert_eq!(out[0], Line::Message(vec![b'x'; MAX_LINE]));
            assert_eq!(out[1], Line::TooLong);
            assert_eq!(out[2], Line::TooLong);
            assert_eq!(out[3], Line::Message(b"{\"cmd\":\"shutdown\"}".to_vec()));
        }
    }

    #[test]
    fn reports_end_of_file() {
        assert!(lines(b"", 16).is_empty());
    }
}
