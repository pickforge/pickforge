//! Injectable process environment.
//!
//! Every environment read the diagnostics perform goes through this type, so
//! tests can describe an exact PATH/home/override world without touching the
//! developer's real environment.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

fn normalize_key(key: String) -> String {
    #[cfg(windows)]
    {
        key.to_ascii_uppercase()
    }
    #[cfg(not(windows))]
    {
        key
    }
}

/// The ambient inputs `doctor` is allowed to read: environment variables and
/// the user's home directory.
#[derive(Debug, Clone, Default)]
pub struct Environment {
    vars: BTreeMap<String, OsString>,
    home_dir: Option<PathBuf>,
}

impl Environment {
    /// The real process environment.
    pub fn from_process() -> Self {
        Self {
            vars: std::env::vars_os()
                .filter_map(|(key, value)| Some((normalize_key(key.into_string().ok()?), value)))
                .collect(),
            home_dir: directories::BaseDirs::new().map(|dirs| dirs.home_dir().to_path_buf()),
        }
    }

    /// An environment with no variables and no home directory.
    pub fn empty() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn with_var(mut self, key: impl Into<String>, value: impl Into<OsString>) -> Self {
        self.vars.insert(normalize_key(key.into()), value.into());
        self
    }

    #[must_use]
    pub fn with_home_dir(mut self, home_dir: impl Into<PathBuf>) -> Self {
        self.home_dir = Some(home_dir.into());
        self
    }

    pub fn var(&self, key: &str) -> Option<&OsString> {
        self.vars.get(&normalize_key(key.to_string()))
    }

    /// `PATH` as searched for executables; `None` when unset.
    pub fn path(&self) -> Option<&OsString> {
        self.var("PATH")
    }

    pub fn home_dir(&self) -> Option<&Path> {
        self.home_dir.as_deref()
    }
}
