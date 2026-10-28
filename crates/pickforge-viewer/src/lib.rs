//! `pickforge-viewer` shows one Pickforge lab session in a native window.
//! See `PROTOCOL.md` for the host contract.

pub mod args;
pub mod geometry;
pub mod keymap;
pub mod keysyms;
pub mod procstat;
pub mod protocol;
pub mod scale;
pub mod selftest;

#[cfg(target_os = "linux")]
mod app;
#[cfg(target_os = "linux")]
pub mod capture;
#[cfg(target_os = "linux")]
pub mod input;
#[cfg(target_os = "linux")]
mod ui;

use args::Invocation;
use std::ffi::OsString;

/// Exit code for invalid arguments.
pub const EXIT_USAGE: i32 = 2;
/// Exit code when the session display cannot be opened or is refused.
pub const EXIT_DISPLAY: i32 = 3;
/// Exit code when no host window system is available.
pub const EXIT_NO_WINDOW_SYSTEM: i32 = 4;

/// Runs the viewer with the arguments after the program name and returns
/// the exit code.
pub fn main_entry<I: IntoIterator<Item = OsString>>(args: I) -> i32 {
    match args::parse(args) {
        Ok(Invocation::Version) => {
            println!("pickforge-viewer {}", args::VERSION);
            0
        }
        Ok(Invocation::Help) => {
            println!("{}", args::USAGE);
            0
        }
        Ok(Invocation::SelfTest) => match selftest::run() {
            Ok(()) => {
                println!("pickforge-viewer self-test ok");
                0
            }
            Err(message) => {
                eprintln!("pickforge-viewer: {message}");
                1
            }
        },
        Ok(Invocation::Run(config)) => run(config),
        Err(error) => {
            eprintln!("pickforge-viewer: {error}\n{}", args::USAGE);
            EXIT_USAGE
        }
    }
}

#[cfg(target_os = "linux")]
fn run(config: args::Config) -> i32 {
    app::run(config)
}

#[cfg(not(target_os = "linux"))]
fn run(_config: args::Config) -> i32 {
    eprintln!("pickforge-viewer: only Linux is supported");
    EXIT_NO_WINDOW_SYSTEM
}
