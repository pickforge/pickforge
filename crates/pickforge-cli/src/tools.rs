//! Executable discovery. Tools are only located on `PATH`, never executed, and
//! never passed through a shell.

use std::path::PathBuf;

use crate::env::Environment;

/// Locate `name` on the supplied `PATH`. Returns `None` when `PATH` is unset,
/// empty, or holds no match.
#[cfg(not(windows))]
pub fn find_on_path(env: &Environment, name: &str) -> Option<PathBuf> {
    let path = env.path()?;
    if path.is_empty() {
        return None;
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    which::which_in(name, Some(path), cwd).ok()
}

#[cfg(windows)]
pub fn find_on_path(env: &Environment, name: &str) -> Option<PathBuf> {
    let path = env.path()?;
    if path.is_empty() {
        return None;
    }
    let extensions = env
        .var("PATHEXT")
        .and_then(|value| value.to_str())
        .unwrap_or(".COM;.EXE;.BAT;.CMD");
    let extensions: Vec<&str> = extensions
        .split(';')
        .filter(|extension| extension.starts_with('.') && extension.len() > 1)
        .collect();
    let cwd = std::env::current_dir().ok();

    for directory in std::env::split_paths(path) {
        if directory.as_os_str().is_empty() {
            continue;
        }
        let directory = if directory.is_absolute() {
            directory
        } else if let Some(cwd) = &cwd {
            cwd.join(directory)
        } else {
            continue;
        };
        for extension in &extensions {
            let candidate = directory.join(format!("{name}{extension}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}
