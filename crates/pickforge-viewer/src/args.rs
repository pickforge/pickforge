//! Command-line parsing and validation. Invalid arguments exit with code 2.

use std::ffi::OsString;
use std::fmt;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Largest session or window side the X protocol can address.
pub const MAX_SIDE: u32 = 32767;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placement {
    /// The host moves and resizes the window through the compositor.
    Host,
    /// The viewer resizes itself and reports the result.
    SelfPlaced,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub display: u32,
    pub xvfb_pid: u32,
    pub xvfb_start_ticks: u64,
    pub width: u32,
    pub height: u32,
    pub class: String,
    pub thumbnail_width: u32,
    pub placement: Placement,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Invocation {
    Version,
    SelfTest,
    Help,
    Run(Config),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArgError(pub String);

impl fmt::Display for ArgError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

pub const USAGE: &str = "usage: pickforge-viewer --display :N --xvfb-pid P --xvfb-start-ticks T \
--width W --height H --class NAME [--thumbnail-width 384] [--placement host|self]
       pickforge-viewer --version
       pickforge-viewer --self-test";

const DEFAULT_THUMBNAIL_WIDTH: u32 = 384;

fn err(message: impl Into<String>) -> ArgError {
    ArgError(message.into())
}

/// Parses the arguments after the program name.
pub fn parse<I>(args: I) -> Result<Invocation, ArgError>
where
    I: IntoIterator<Item = OsString>,
{
    let mut items = Vec::new();
    for arg in args {
        items.push(
            arg.into_string()
                .map_err(|_| err("arguments must be valid UTF-8"))?,
        );
    }
    if items.len() == 1 {
        match items[0].as_str() {
            "--version" => return Ok(Invocation::Version),
            "--self-test" => return Ok(Invocation::SelfTest),
            "--help" | "-h" => return Ok(Invocation::Help),
            _ => {}
        }
    }

    let mut display = None;
    let mut pid = None;
    let mut ticks = None;
    let mut width = None;
    let mut height = None;
    let mut class = None;
    let mut thumbnail = None;
    let mut placement = None;

    let mut iter = items.into_iter();
    while let Some(arg) = iter.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name.to_string(), Some(value.into())),
            _ => (arg, None),
        };
        let slot: &mut Option<String> = match name.as_str() {
            "--display" => &mut display,
            "--xvfb-pid" => &mut pid,
            "--xvfb-start-ticks" => &mut ticks,
            "--width" => &mut width,
            "--height" => &mut height,
            "--class" => &mut class,
            "--thumbnail-width" => &mut thumbnail,
            "--placement" => &mut placement,
            "--version" | "--self-test" | "--help" => {
                return Err(err(format!("{name} must be the only argument")))
            }
            _ => return Err(err(format!("unknown argument: {name}"))),
        };
        if slot.is_some() {
            return Err(err(format!("{name} given twice")));
        }
        let value = match inline {
            Some(value) => value,
            None => iter
                .next()
                .ok_or_else(|| err(format!("{name} needs a value")))?,
        };
        *slot = Some(value);
    }

    let required =
        |value: Option<String>, name: &str| value.ok_or_else(|| err(format!("missing {name}")));
    let config = Config {
        display: parse_display(&required(display, "--display")?)?,
        xvfb_pid: parse_number(
            &required(pid, "--xvfb-pid")?,
            "--xvfb-pid",
            1,
            i32::MAX as u64,
        )? as u32,
        xvfb_start_ticks: parse_number(
            &required(ticks, "--xvfb-start-ticks")?,
            "--xvfb-start-ticks",
            0,
            u64::MAX,
        )?,
        width: parse_number(&required(width, "--width")?, "--width", 1, MAX_SIDE as u64)? as u32,
        height: parse_number(
            &required(height, "--height")?,
            "--height",
            1,
            MAX_SIDE as u64,
        )? as u32,
        class: parse_class(&required(class, "--class")?)?,
        thumbnail_width: match thumbnail {
            Some(value) => parse_number(&value, "--thumbnail-width", 64, 4096)? as u32,
            None => DEFAULT_THUMBNAIL_WIDTH,
        },
        placement: match placement.as_deref() {
            None | Some("self") => Placement::SelfPlaced,
            Some("host") => Placement::Host,
            Some(other) => {
                return Err(err(format!(
                    "--placement must be host or self, not {other:?}"
                )))
            }
        },
    };
    Ok(Invocation::Run(config))
}

fn parse_number(value: &str, name: &str, min: u64, max: u64) -> Result<u64, ArgError> {
    let invalid = || err(format!("{name} must be a whole number from {min} to {max}"));
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(invalid());
    }
    let number: u64 = value.parse().map_err(|_| invalid())?;
    if number < min || number > max {
        return Err(invalid());
    }
    Ok(number)
}

/// Accepts only the local form `:N`.
fn parse_display(value: &str) -> Result<u32, ArgError> {
    let digits = value
        .strip_prefix(':')
        .filter(|d| !d.is_empty() && d.len() <= 5 && d.bytes().all(|b| b.is_ascii_digit()))
        .ok_or_else(|| err("--display must look like :N"))?;
    let number: u32 = digits
        .parse()
        .map_err(|_| err("--display must look like :N"))?;
    if number > 65535 {
        return Err(err("--display must look like :N"));
    }
    Ok(number)
}

fn parse_class(value: &str) -> Result<String, ArgError> {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.');
    if !valid {
        return Err(err(
            "--class must be 1 to 128 characters of letters, digits, '.', '_' or '-'",
        ));
    }
    Ok(value.to_string())
}

/// The display number in a `DISPLAY` value such as `:0`, `:1.0` or
/// `unix:2`. The host part is ignored, so a match is refused even for a
/// remote form; that errs on the safe side.
pub fn display_number(value: &str) -> Option<u32> {
    let (_, rest) = value.rsplit_once(':')?;
    let digits = rest.split('.').next()?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// True when the session display is the viewer's own window display.
pub fn is_own_display(own: Option<&str>, session: u32) -> bool {
    own.and_then(display_number) == Some(session)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run<S: AsRef<str>>(args: &[S]) -> Result<Invocation, ArgError> {
        parse(args.iter().map(|s| OsString::from(s.as_ref())))
    }

    const BASE: &[&str] = &[
        "--display",
        ":12345",
        "--xvfb-pid",
        "4242",
        "--xvfb-start-ticks",
        "987654",
        "--width",
        "1280",
        "--height",
        "800",
        "--class",
        "pickforge-viewer-abc123",
    ];

    fn with(extra: &[&str]) -> Vec<String> {
        BASE.iter().chain(extra).map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_full_launch_line() {
        let args = with(&["--thumbnail-width", "384", "--placement", "host"]);
        let Invocation::Run(config) = run(&args).unwrap() else {
            panic!("expected run");
        };
        assert_eq!(
            config,
            Config {
                display: 12345,
                xvfb_pid: 4242,
                xvfb_start_ticks: 987654,
                width: 1280,
                height: 800,
                class: "pickforge-viewer-abc123".into(),
                thumbnail_width: 384,
                placement: Placement::Host,
            }
        );
    }

    #[test]
    fn defaults_thumbnail_and_placement() {
        let Invocation::Run(config) = run(BASE).unwrap() else {
            panic!("expected run");
        };
        assert_eq!(config.thumbnail_width, 384);
        assert_eq!(config.placement, Placement::SelfPlaced);
    }

    #[test]
    fn accepts_inline_values() {
        let args = with(&["--placement=self"]);
        assert!(matches!(run(&args), Ok(Invocation::Run(_))));
    }

    #[test]
    fn single_flags() {
        assert_eq!(run(&["--version"]), Ok(Invocation::Version));
        assert_eq!(run(&["--self-test"]), Ok(Invocation::SelfTest));
        assert_eq!(run(&["--help"]), Ok(Invocation::Help));
        assert!(run(&["--version", "--self-test"]).is_err());
    }

    #[test]
    fn rejects_bad_values() {
        let cases: [&[&str]; 3] = [&[], &["--display", ":1"], &["--bogus"]];
        for case in cases {
            assert!(run(case).is_err(), "{case:?}");
        }
        let replace = |flag: &str, value: &str| {
            let mut args = with(&[]);
            let at = args.iter().position(|a| a == flag).unwrap();
            args[at + 1] = value.to_string();
            run(&args)
        };
        for (flag, value) in [
            ("--display", "1"),
            ("--display", ":"),
            ("--display", ":1.0"),
            ("--display", "host:1"),
            ("--display", ":99999"),
            ("--display", ":-1"),
            ("--xvfb-pid", "0"),
            ("--xvfb-pid", "-5"),
            ("--xvfb-pid", "+5"),
            ("--xvfb-start-ticks", "abc"),
            ("--width", "0"),
            ("--width", "40000"),
            ("--height", ""),
            ("--class", ""),
            ("--class", "bad class"),
            ("--class", "a/b"),
        ] {
            assert!(replace(flag, value).is_err(), "{flag} {value}");
        }
        assert!(run(&with(&["--placement", "both"])).is_err());
        assert!(run(&with(&["--thumbnail-width", "10"])).is_err());
        assert!(run(&with(&["--width", "10"])).is_err(), "duplicate flag");
        assert!(run(&with(&["--placement"])).is_err(), "missing value");
    }

    #[test]
    fn own_display_detection() {
        assert_eq!(display_number(":0"), Some(0));
        assert_eq!(display_number(":12.0"), Some(12));
        assert_eq!(display_number("unix:7"), Some(7));
        assert_eq!(display_number("localhost:3.1"), Some(3));
        assert_eq!(display_number("wayland-0"), None);
        assert_eq!(display_number(":x"), None);
        assert!(is_own_display(Some(":5"), 5));
        assert!(is_own_display(Some(":5.0"), 5));
        assert!(!is_own_display(Some(":5"), 6));
        assert!(!is_own_display(None, 5));
        assert!(!is_own_display(Some(""), 0));
    }
}
