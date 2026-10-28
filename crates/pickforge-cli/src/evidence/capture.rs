//! When and on what a state was captured: device state, app build and emulator versions.

use serde::{Deserialize, Serialize};
use time::{format_description, OffsetDateTime};

use super::{bad, bounded_line, normalize_markdown, redact_secrets, EvidenceError, UNKNOWN};

/// When and on what a state was captured. Every field is optional on input; anything absent
/// is recorded as `unknown`, never inferred.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CaptureInput {
    captured_at: Option<String>,
    app_build: Option<String>,
    emulator_version: Option<String>,
    system_image: Option<String>,
    requested: Option<DeviceStateInput>,
    observed: Option<DeviceStateInput>,
}

/// Raw JSON values so each field can fail with its own message.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeviceStateInput {
    display_mode: Option<serde_json::Value>,
    fold_state: Option<serde_json::Value>,
    posture: Option<serde_json::Value>,
    rotation: Option<serde_json::Value>,
    density: Option<serde_json::Value>,
    font_scale: Option<serde_json::Value>,
    dark_mode: Option<serde_json::Value>,
    locale: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Capture {
    captured_at: String,
    app_build: String,
    emulator_version: String,
    system_image: String,
    /// Only the settings the caller asked for.
    requested: DeviceState,
    /// Every setting; `unknown` where nothing was observed.
    observed: DeviceState,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceState {
    #[serde(skip_serializing_if = "Option::is_none")]
    display_mode: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fold_state: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    posture: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rotation: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    density: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    font_scale: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dark_mode: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    locale: Option<serde_json::Value>,
}

/// An RFC 3339 timestamp, or `unknown` when absent.
pub(super) fn captured_at(value: Option<&str>, name: &str) -> Result<String, EvidenceError> {
    match value {
        None => Ok(UNKNOWN.into()),
        Some(UNKNOWN) => Ok(UNKNOWN.into()),
        Some(value) => {
            bounded_line(value, 64, name)?;
            OffsetDateTime::parse(value, &format_description::well_known::Rfc3339).map_err(
                |_| EvidenceError::Input(format!("{name} must be RFC 3339 or \"unknown\"")),
            )?;
            Ok(value.into())
        }
    }
}
fn capture_text(value: Option<&str>, name: &str) -> Result<String, EvidenceError> {
    match value {
        None => Ok(UNKNOWN.into()),
        Some(value) => {
            bounded_line(value, 200, name)?;
            Ok(value.into())
        }
    }
}
/// Validate a capture and project it to its recorded shape. Absent values become `unknown`.
pub(super) fn capture_from(
    input: Option<&CaptureInput>,
    name: &str,
) -> Result<Capture, EvidenceError> {
    let empty = CaptureInput::default();
    let input = input.unwrap_or(&empty);
    let field = |part: &str| format!("{name} capture {part}");
    let empty_state = DeviceStateInput::default();
    Ok(Capture {
        captured_at: captured_at(input.captured_at.as_deref(), &field("capturedAt"))?,
        app_build: capture_text(input.app_build.as_deref(), &field("appBuild"))?,
        emulator_version: capture_text(
            input.emulator_version.as_deref(),
            &field("emulatorVersion"),
        )?,
        system_image: capture_text(input.system_image.as_deref(), &field("systemImage"))?,
        requested: device_state(
            input.requested.as_ref().unwrap_or(&empty_state),
            &field("requested"),
            true,
        )?,
        observed: device_state(
            input.observed.as_ref().unwrap_or(&empty_state),
            &field("observed"),
            false,
        )?,
    })
}
#[derive(Clone, Copy)]
enum StateValueKind {
    Text,
    Rotation,
    Density,
    FontScale,
    Flag,
}
/// Requested state keeps only the settings that were set. Observed state lists every setting
/// and records `unknown` for the ones nobody observed.
fn device_state(
    input: &DeviceStateInput,
    name: &str,
    requested: bool,
) -> Result<DeviceState, EvidenceError> {
    use StateValueKind::*;
    let value = |raw: &Option<serde_json::Value>, key: &str, kind: StateValueKind| {
        state_value(raw.as_ref(), &format!("{name}.{key}"), kind, requested)
    };
    Ok(DeviceState {
        display_mode: value(&input.display_mode, "displayMode", Text)?,
        fold_state: value(&input.fold_state, "foldState", Text)?,
        posture: value(&input.posture, "posture", Text)?,
        rotation: value(&input.rotation, "rotation", Rotation)?,
        density: value(&input.density, "density", Density)?,
        font_scale: value(&input.font_scale, "fontScale", FontScale)?,
        dark_mode: value(&input.dark_mode, "darkMode", Flag)?,
        locale: value(&input.locale, "locale", Text)?,
    })
}
fn state_value(
    raw: Option<&serde_json::Value>,
    name: &str,
    kind: StateValueKind,
    requested: bool,
) -> Result<Option<serde_json::Value>, EvidenceError> {
    use serde_json::Value;
    let unknown = || Value::String(UNKNOWN.into());
    let raw = match raw {
        None | Some(Value::Null) => return Ok((!requested).then(unknown)),
        Some(Value::String(text)) if text == UNKNOWN => {
            return if requested {
                bad(&format!(
                    "{name} must be a concrete value; omit settings that were not requested"
                ))
            } else {
                Ok(Some(unknown()))
            };
        }
        Some(raw) => raw,
    };
    let accepted = match kind {
        StateValueKind::Text => raw
            .as_str()
            .is_some_and(|text| bounded_line(text, 64, name).is_ok()),
        StateValueKind::Rotation => raw
            .as_u64()
            .is_some_and(|degrees| matches!(degrees, 0 | 90 | 180 | 270)),
        StateValueKind::Density => raw.as_u64().is_some_and(|dpi| (1..=10_000).contains(&dpi)),
        StateValueKind::FontScale => raw
            .as_f64()
            .is_some_and(|scale| scale.is_finite() && scale > 0.0 && scale <= 10.0),
        StateValueKind::Flag => raw.is_boolean(),
    };
    if !accepted {
        let expected = match kind {
            StateValueKind::Text => "a single-line string of at most 64 characters",
            StateValueKind::Rotation => "0, 90, 180 or 270 degrees",
            StateValueKind::Density => "an integer dpi from 1 to 10000",
            StateValueKind::FontScale => "a number above 0 and at most 10",
            StateValueKind::Flag => "true or false",
        };
        let unknown_hint = if requested { "" } else { " or \"unknown\"" };
        return bad(&format!("{name} must be {expected}{unknown_hint}"));
    }
    Ok(Some(raw.clone()))
}
pub(super) fn redact_capture(capture: &mut Capture) {
    for value in [
        &mut capture.app_build,
        &mut capture.emulator_version,
        &mut capture.system_image,
    ] {
        *value = redact_secrets(value);
    }
    for state in [&mut capture.requested, &mut capture.observed] {
        for value in [
            &mut state.display_mode,
            &mut state.fold_state,
            &mut state.posture,
            &mut state.locale,
        ]
        .into_iter()
        .flatten()
        {
            if let serde_json::Value::String(text) = value {
                *text = redact_secrets(text);
            }
        }
    }
}

/// Render a capture only when something about it is known.
pub(super) fn render_capture(out: &mut String, capture: &Capture) {
    let requested = state_pairs(&capture.requested);
    let observed = state_pairs(&capture.observed);
    let known = [
        &capture.captured_at,
        &capture.app_build,
        &capture.emulator_version,
        &capture.system_image,
    ]
    .iter()
    .any(|value| value.as_str() != UNKNOWN)
        || !requested.is_empty()
        || has_known_value(&capture.observed);
    if !known {
        return;
    }
    out.push_str("\n### Capture\n\n");
    for (label, value) in [
        ("Captured at", &capture.captured_at),
        ("App build", &capture.app_build),
        ("Emulator", &capture.emulator_version),
        ("System image", &capture.system_image),
    ] {
        out.push_str(&format!("- **{label}:** {}\n", normalize_markdown(value)));
    }
    let requested = if requested.is_empty() {
        "none".to_owned()
    } else {
        requested.join(", ")
    };
    out.push_str(&format!("- **Requested:** {requested}\n"));
    out.push_str(&format!("- **Observed:** {}\n", observed.join(", ")));
}

fn has_known_value(state: &DeviceState) -> bool {
    [
        &state.display_mode,
        &state.fold_state,
        &state.posture,
        &state.rotation,
        &state.density,
        &state.font_scale,
        &state.dark_mode,
        &state.locale,
    ]
    .into_iter()
    .flatten()
    .any(|value| value.as_str() != Some(UNKNOWN))
}

fn state_pairs(state: &DeviceState) -> Vec<String> {
    [
        ("displayMode", &state.display_mode),
        ("foldState", &state.fold_state),
        ("posture", &state.posture),
        ("rotation", &state.rotation),
        ("density", &state.density),
        ("fontScale", &state.font_scale),
        ("darkMode", &state.dark_mode),
        ("locale", &state.locale),
    ]
    .into_iter()
    .filter_map(|(key, value)| {
        let value = value.as_ref()?;
        let text = match value {
            serde_json::Value::String(text) => text.clone(),
            other => other.to_string(),
        };
        Some(format!("{key} {}", normalize_markdown(&text)))
    })
    .collect()
}
