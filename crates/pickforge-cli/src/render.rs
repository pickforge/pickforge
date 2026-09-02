//! Deterministic, color-free rendering of a [`DoctorReport`].

use crate::report::{CheckStatus, DoctorReport};

fn label(status: CheckStatus) -> &'static str {
    match status {
        CheckStatus::Pass => "PASS",
        CheckStatus::Warning => "WARN",
        CheckStatus::Fail => "FAIL",
    }
}

fn terminal_safe(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if character.is_control() {
            escaped.extend(character.escape_default());
        } else {
            escaped.push(character);
        }
    }
    escaped
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
    out.push_str(&format!(
        "project: {}\n",
        terminal_safe(&report.project.path)
    ));
    out.push_str(&format!(
        "framework: {}\n",
        terminal_safe(report.project.framework.as_deref().unwrap_or("unknown"))
    ));
    out.push_str(&format!(
        "project id: {}\n",
        terminal_safe(report.project.project_id.as_deref().unwrap_or("unknown"))
    ));
    out.push_str(&format!(
        "state dir: {}\n\n",
        terminal_safe(report.project.state_dir.as_deref().unwrap_or("unresolved"))
    ));

    for check in &report.checks {
        out.push_str(&format!(
            "[{}] {}: {}\n",
            label(check.status),
            terminal_safe(&check.id),
            terminal_safe(&check.summary)
        ));
        if let Some(detail) = &check.detail {
            out.push_str(&format!("       {}\n", terminal_safe(detail)));
        }
        if let Some(remediation) = &check.remediation {
            out.push_str(&format!("       fix: {}\n", terminal_safe(remediation)));
        }
    }

    out.push_str(&format!(
        "\nready: {}\n",
        if report.ready { "yes" } else { "no" }
    ));
    out
}
