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

fn home_from_vars(vars: &BTreeMap<String, OsString>) -> Option<PathBuf> {
    #[cfg(windows)]
    const HOME_KEYS: [&str; 2] = ["USERPROFILE", "HOME"];
    #[cfg(not(windows))]
    const HOME_KEYS: [&str; 1] = ["HOME"];

    HOME_KEYS.iter().find_map(|key| {
        let path = PathBuf::from(vars.get(*key)?);
        path.is_absolute().then_some(path)
    })
}

/// The ambient inputs CLI commands are allowed to read: environment variables
/// and the user's home directory.
#[derive(Debug, Clone, Default)]
pub struct Environment {
    vars: BTreeMap<String, OsString>,
    home_dir: Option<PathBuf>,
}

impl Environment {
    /// The real process environment.
    pub fn from_process() -> Self {
        let vars = std::env::vars_os()
            .filter_map(|(key, value)| Some((normalize_key(key.into_string().ok()?), value)))
            .collect();
        let home_dir = home_from_vars(&vars)
            .or_else(|| directories::BaseDirs::new().map(|dirs| dirs.home_dir().to_path_buf()));
        Self { vars, home_dir }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_home_requires_an_absolute_path() {
        let mut vars = BTreeMap::new();
        vars.insert(normalize_key("HOME".into()), OsString::from("relative"));
        assert_eq!(home_from_vars(&vars), None);

        #[cfg(windows)]
        let absolute = PathBuf::from(r"C:\isolated-home");
        #[cfg(not(windows))]
        let absolute = PathBuf::from("/isolated-home");
        vars.insert(normalize_key("HOME".into()), absolute.clone().into());
        assert_eq!(home_from_vars(&vars), Some(absolute));
    }

    #[cfg(windows)]
    #[test]
    fn userprofile_precedes_home_on_windows() {
        let profile = PathBuf::from(r"C:\profile");
        let home = PathBuf::from(r"D:\home");
        let vars = BTreeMap::from([
            (normalize_key("UserProfile".into()), profile.clone().into()),
            (normalize_key("Home".into()), home.into()),
        ]);
        assert_eq!(home_from_vars(&vars), Some(profile));
    }

    #[cfg(windows)]
    #[test]
    fn relative_userprofile_falls_through_to_home() {
        let home = PathBuf::from(r"D:\home");
        let vars = BTreeMap::from([
            (
                normalize_key("UserProfile".into()),
                OsString::from("relative"),
            ),
            (normalize_key("Home".into()), home.clone().into()),
        ]);
        assert_eq!(home_from_vars(&vars), Some(home));
    }
}
