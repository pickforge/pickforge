//! Headless checks for `--self-test`. They need no display.

use crate::geometry::{fit, session_point, Rect};
use crate::protocol::{encode_event, parse_command, Command, Event, Line, LineReader, Mode};
use std::io::{BufReader, Cursor};

fn check(ok: bool, what: &str) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err(format!("self-test failed: {what}"))
    }
}

fn protocol_checks() -> Result<(), String> {
    let line = encode_event(&Event::Mode {
        mode: Mode::Expanded,
    });
    check(
        line == "{\"event\":\"mode\",\"mode\":\"expanded\"}\n",
        "event encoding",
    )?;
    let input = b"{\"cmd\":\"shutdown\",\"later\":1}\r\n{\"cmd\":\"next\"}\n";
    let mut reader = LineReader::new(BufReader::with_capacity(5, Cursor::new(&input[..])));
    let mut commands = Vec::new();
    while let Ok(Some(Line::Message(bytes))) = reader.next_line() {
        commands.push(parse_command(&bytes).map_err(|e| e.to_string())?);
    }
    check(
        commands == [Command::Shutdown, Command::Unknown("next".into())],
        "command framing",
    )
}

fn geometry_checks() -> Result<(), String> {
    let image = fit(1280, 800, Rect::new(0, 32, 1000, 1000));
    check(image == Rect::new(0, 219, 1000, 625), "letterbox")?;
    check(
        session_point(image, 1280, 800, 999.9, 843.9) == Some((1279, 799)),
        "pointer mapping",
    )
}

/// Runs every check and reports the first failure.
pub fn run() -> Result<(), String> {
    crate::scale::golden_checks()?;
    protocol_checks()?;
    geometry_checks()?;
    #[cfg(target_os = "linux")]
    crate::ui::font_check()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn self_test_passes() {
        super::run().unwrap();
    }
}
