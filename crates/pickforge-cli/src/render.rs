//! Deterministic, color-free rendering of a [`DoctorReport`].

use crate::report::{CheckStatus, DoctorReport};

fn label(status: CheckStatus) -> &'static str {
    match status {
        CheckStatus::Pass => "PASS",
        CheckStatus::Warning => "WARN",
        CheckStatus::Fail => "FAIL",
    }
}

pub fn terminal_safe(value: &str) -> String {
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

fn action_label(action: crate::init::ActionKind) -> &'static str {
    match action {
        crate::init::ActionKind::Create => "CREATE",
        crate::init::ActionKind::Update => "UPDATE",
        crate::init::ActionKind::Unchanged => "UNCHANGED",
    }
}

pub fn render_init_plan(report: &crate::init::InitPlanReport) -> String {
    let mut out = String::from("pickforge init\n");
    out.push_str(&format!(
        "project: {}\n",
        terminal_safe(&report.project_path)
    ));
    out.push_str(&format!(
        "project id: {}\n",
        terminal_safe(&report.project_id)
    ));
    out.push_str(&format!(
        "state dir: {}\n",
        terminal_safe(&report.state_dir)
    ));
    out.push_str(&format!(
        "pack: {} v{}\n",
        terminal_safe(&report.pack.name),
        report.pack.version
    ));
    out.push_str(&format!(
        "harnesses: {}\n",
        report
            .harnesses
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", ")
    ));
    for action in &report.actions {
        out.push_str(&format!(
            "[{}] {}: {}\n",
            action_label(action.action),
            terminal_safe(&action.target),
            terminal_safe(&action.summary)
        ));
        if !action.server_names.is_empty() {
            out.push_str(&format!(
                "       servers: {}\n",
                action
                    .server_names
                    .iter()
                    .map(|name| terminal_safe(name))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if action.backup_needed {
            out.push_str("       backup: required\n");
        }
        if let Some(warning) = &action.warning {
            out.push_str(&format!("       warning: {}\n", terminal_safe(warning)));
        }
    }
    out
}

pub fn render_init_outcome(report: &crate::init::ApplyReport) -> String {
    use crate::init::ApplyState;

    let outcome = match report.outcome {
        ApplyState::Success => "success",
        ApplyState::NoOp => "no-op",
        ApplyState::FailedRolledBack => "failed-rolled-back",
        ApplyState::FailedPartial => "failed-partial",
    };
    let mut out = format!(
        "outcome: {outcome}\nchanged: {}\n",
        if report.changed { "yes" } else { "no" }
    );
    for path in &report.backup_paths {
        out.push_str(&format!("backup: {}\n", terminal_safe(path)));
    }
    for path in &report.rollback_residuals {
        out.push_str(&format!("rollback residual: {}\n", terminal_safe(path)));
    }
    if let Some(error) = &report.error {
        out.push_str(&format!("error: {}\n", terminal_safe(error)));
    }
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
