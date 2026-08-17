//! The serializable shape of a `pickforge doctor` run.

use serde::Serialize;

/// Bumped whenever the JSON shape changes incompatibly.
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Pass,
    Warning,
    Fail,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    /// Stable machine identifier, e.g. `project.framework`.
    pub id: String,
    pub status: CheckStatus,
    /// One line, always present.
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remediation: Option<String>,
}

impl Check {
    pub fn new(id: &str, status: CheckStatus, summary: impl Into<String>) -> Self {
        Self {
            id: id.to_string(),
            status,
            summary: summary.into(),
            detail: None,
            remediation: None,
        }
    }

    #[must_use]
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    #[must_use]
    pub fn with_remediation(mut self, remediation: impl Into<String>) -> Self {
        self.remediation = Some(remediation.into());
        self
    }
}

/// What the diagnostics resolved about the target project. Fields are omitted
/// when they could not be resolved at all (a missing home directory leaves no
/// state directory to report).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    /// Canonical absolute path when the directory exists, otherwise the
    /// lexically resolved absolute path.
    pub path: String,
    /// `flutter` when a Flutter project was detected.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub framework: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    /// `<state root>/projects/<projectId>`; never created by `doctor`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_dir: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub schema_version: u32,
    /// True iff no check failed.
    pub ready: bool,
    pub project: ProjectInfo,
    pub checks: Vec<Check>,
}

impl DoctorReport {
    pub fn new(project: ProjectInfo, checks: Vec<Check>) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            ready: !checks.iter().any(|check| check.status == CheckStatus::Fail),
            project,
            checks,
        }
    }
}
