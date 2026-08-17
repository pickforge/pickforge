//! Deterministic, color-free rendering of a [`DoctorReport`].

use crate::report::{CheckStatus, DoctorReport};

fn label(status: CheckStatus) -> &'static str {
    match status {
        CheckStatus::Pass => "PASS",
        CheckStatus::Warning => "WARN",
        CheckStatus::Fail => "FAIL",
    }
}

/// Pretty JSON with a trailing newline.
pub fn render_json(report: &DoctorReport) -> String {
    let mut out =
        serde_json::to_string_pretty(report).expect("DoctorReport is a plain serializable struct");
    out.push('\n');
    out
}

pub fn render_text(report: &DoctorReport) -> String {
    let mut out = String::from("pickforge doctor\n");
    out.push_str(&format!("project: {}\n", report.project.path));
    out.push_str(&format!(
        "framework: {}\n",
        report.project.framework.as_deref().unwrap_or("unknown")
    ));
    out.push_str(&format!(
        "project id: {}\n",
        report.project.project_id.as_deref().unwrap_or("unknown")
    ));
    out.push_str(&format!(
        "state dir: {}\n\n",
        report.project.state_dir.as_deref().unwrap_or("unresolved")
    ));

    for check in &report.checks {
        out.push_str(&format!(
            "[{}] {}: {}\n",
            label(check.status),
            check.id,
            check.summary
        ));
        if let Some(detail) = &check.detail {
            out.push_str(&format!("       {detail}\n"));
        }
        if let Some(remediation) = &check.remediation {
            out.push_str(&format!("       fix: {remediation}\n"));
        }
    }

    out.push_str(&format!(
        "\nready: {}\n",
        if report.ready { "yes" } else { "no" }
    ));
    out
}
