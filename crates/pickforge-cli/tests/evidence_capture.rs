//! Schema v4: capture records, UI tree, log and report artifacts, and v3 compatibility.

use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use pickforge_cli::adapters::{Harness, IntegrationPack};
use pickforge_cli::evidence::{
    record_at, EvidenceError, EVIDENCE_SCHEMA_VERSION, MAX_TEXT_ARTIFACT_BYTES,
};
use pickforge_cli::{apply_init, plan_init, Environment, InitRequest};
use serde_json::{json, Value};
use tempfile::TempDir;

const PUBSPEC: &str = "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n";
const V3_FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/evidence-v3");
const V3_RUN: &str = "20261028-161825-flutter";

fn fixture() -> (TempDir, PathBuf, Environment, PathBuf) {
    let temp = TempDir::new().unwrap();
    let project = temp.path().join("app");
    std::fs::create_dir(&project).unwrap();
    std::fs::write(project.join("pubspec.yaml"), PUBSPEC).unwrap();
    let bin = temp.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let dart = bin.join(if cfg!(windows) { "dart.EXE" } else { "dart" });
    std::fs::write(&dart, "fixture").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dart, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let env = Environment::empty()
        .with_home_dir(temp.path().join("home"))
        .with_var("PICKFORGE_HOME", temp.path().join("state"))
        .with_var("PATH", &bin)
        .with_var("PATHEXT", ".EXE");
    let mut request = InitRequest::new(&project);
    request.pack = IntegrationPack::flutter();
    request.harnesses = vec![Harness::Codex];
    let plan = plan_init(&request, &env).unwrap();
    assert!(apply_init(&plan, "fixture").changed);
    (temp, project, env, PathBuf::from(plan.report.state_dir))
}

fn base() -> Value {
    json!({
        "schemaVersion": EVIDENCE_SCHEMA_VERSION,
        "scenario": "Labels survive a fold",
        "outcome": "passed",
        "before": {"summary": "Folded.", "observations": [], "artifacts": []},
        "after": {"summary": "Unfolded.", "observations": [], "artifacts": []},
        "checks": [],
        "limitations": []
    })
}

fn write(dir: &Path, name: &str, content: impl AsRef<[u8]>) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, content).unwrap();
    path
}

fn record(project: &Path, env: &Environment, input: &Value) -> Result<Value, EvidenceError> {
    let result = record_at(
        project,
        env,
        &serde_json::to_vec(input).unwrap(),
        UNIX_EPOCH + Duration::from_secs(1_704_067_200),
    )?;
    Ok(json!({
        "document": serde_json::from_slice::<Value>(&std::fs::read(&result.evidence_path).unwrap()).unwrap(),
        "report": std::fs::read_to_string(&result.report_path).unwrap(),
        "dir": Path::new(&result.evidence_path).parent().unwrap().to_str().unwrap(),
    }))
}

fn assert_no_runs(state: &Path) {
    let runs = state.join("runs");
    if runs.exists() {
        let names = std::fs::read_dir(runs)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert!(names.is_empty(), "{names:?}");
    }
}

#[test]
fn records_requested_and_observed_state_with_unknowns_never_guessed() {
    let (_temp, project, env, _state) = fixture();
    let mut input = base();
    input["after"]["capture"] = json!({
        "capturedAt": "2026-10-28T12:00:00+01:00",
        "appBuild": "1.4.0+42",
        "emulatorVersion": "35.2.10",
        "systemImage": "system-images;android-35;google_apis;x86_64",
        "requested": {"foldState": "flat", "darkMode": true, "fontScale": 1.3},
        "observed": {"foldState": "flat", "posture": "unknown", "rotation": 90, "density": 420,
            "fontScale": 1.3, "darkMode": true, "locale": "pt-BR"}
    });
    let recorded = record(&project, &env, &input).unwrap();
    let after = &recorded["document"]["after"]["capture"];
    assert_eq!(
        *after,
        json!({
            "capturedAt": "2026-10-28T12:00:00+01:00",
            "appBuild": "1.4.0+42",
            "emulatorVersion": "35.2.10",
            "systemImage": "system-images;android-35;google_apis;x86_64",
            "requested": {"foldState": "flat", "fontScale": 1.3, "darkMode": true},
            "observed": {"displayMode": "unknown", "foldState": "flat", "posture": "unknown",
                "rotation": 90, "density": 420, "fontScale": 1.3, "darkMode": true, "locale": "pt-BR"}
        })
    );
    assert_eq!(recorded["document"]["schemaVersion"], 4);
    let before = &recorded["document"]["before"]["capture"];
    assert_eq!(before["capturedAt"], "unknown");
    assert_eq!(before["requested"], json!({}));
    assert_eq!(before["observed"]["darkMode"], "unknown");

    let report = recorded["report"].as_str().unwrap();
    let after_heading = report.find("## After").unwrap();
    let capture = report.find("### Capture").unwrap();
    assert!(capture > after_heading, "{report}");
    assert_eq!(report.matches("### Capture").count(), 1, "{report}");
    assert!(report.contains("- **App build:** 1.4.0+42"), "{report}");
    assert!(
        report.contains("- **Requested:** foldState flat, fontScale 1.3, darkMode true"),
        "{report}"
    );
    assert!(
        report.contains("- **Observed:** displayMode unknown, foldState flat, posture unknown, rotation 90, density 420, fontScale 1.3, darkMode true, locale pt-BR"),
        "{report}"
    );
}

#[test]
fn stores_trees_logs_and_reports_as_redacted_inert_text() {
    let (temp, project, env, _state) = fixture();
    let dir = temp.path();
    let tree = write(
        dir,
        "tree.xml",
        r#"<?xml version="1.0"?><hierarchy><node text="Sign in" password="false" bounds="[0,0][96,96]"/><node text="api_key=treesecret1" bounds="[0,96][96,192]"/></hierarchy>"#,
    );
    let logcat = write(
        dir,
        "logcat.txt",
        "I/flutter: login ok\nD/http: Authorization: Bearer logsecret123\nI/flutter: patient=SYN-0001\n",
    );
    let lighthouse = write(
        dir,
        "lighthouse.html",
        "<!doctype html><html><body><script>alert(document.cookie)</script><img src=x onerror=alert(1)></body></html>",
    );
    let mut input = base();
    input["before"]["artifacts"] = json!([
        {"kind": "tree", "origin": "android-ui-tree", "label": "UI tree", "source": tree,
            "capturedAt": "2026-10-28T11:00:00Z"},
        {"kind": "log", "origin": "android-logcat", "label": "Logcat", "source": logcat},
        {"kind": "tree", "origin": "atspi-tree", "label": "Desktop tree",
            "capturedAt": "2026-10-28T11:00:02Z",
            "unavailable": "AT-SPI capture is not supported yet; token=reasonsecret"}
    ]);
    input["after"]["artifacts"] = json!([
        {"kind": "report", "origin": "lighthouse", "label": "<b>Lighthouse</b>", "source": lighthouse,
            "capturedAt": "2026-10-28T11:05:00Z"},
        {"kind": "log", "origin": "android-logcat", "label": "Logcat again", "source": logcat}
    ]);
    let recorded = record(&project, &env, &input).unwrap();
    let run = PathBuf::from(recorded["dir"].as_str().unwrap());
    let before = &recorded["document"]["before"]["artifacts"];
    let after = &recorded["document"]["after"]["artifacts"];

    assert_eq!(before[0]["kind"], "tree");
    assert_eq!(before[0]["origin"], "android-ui-tree");
    assert_eq!(before[0]["status"], "captured");
    assert_eq!(before[0]["format"], "xml");
    assert_eq!(before[0]["capturedAt"], "2026-10-28T11:00:00Z");
    assert_eq!(before[0]["mediaType"], "text/plain; charset=utf-8");
    let stored_tree =
        std::fs::read_to_string(run.join(before[0]["path"].as_str().unwrap())).unwrap();
    // The tree keeps its structure and its password flags after redaction, so a
    // rule check can still parse it.
    assert!(!stored_tree.contains("treesecret1"), "{stored_tree}");
    assert!(
        stored_tree.contains(r#"password="false" bounds="[0,0][96,96]"/><node text="api_key=[REDACTED]" bounds="[0,96][96,192]"/>"#),
        "{stored_tree}"
    );

    assert_eq!(before[1]["capturedAt"], "unknown");
    assert_eq!(before[1]["format"], "text");
    let log_path = before[1]["path"].as_str().unwrap();
    let stored_log = std::fs::read_to_string(run.join(log_path)).unwrap();
    assert!(!stored_log.contains("logsecret123"), "{stored_log}");
    assert!(stored_log.contains("patient=SYN-0001"), "{stored_log}");
    assert_eq!(before[1]["bytes"], stored_log.len());
    assert_eq!(after[1]["path"], log_path, "identical text is stored once");

    assert_eq!(
        before[2],
        json!({"kind": "tree", "origin": "atspi-tree", "label": "Desktop tree", "capturedAt": "2026-10-28T11:00:02Z",
            "status": "unavailable", "reason": "AT-SPI capture is not supported yet; token=[REDACTED]"})
    );

    let html_path = after[0]["path"].as_str().unwrap();
    assert!(html_path.ends_with(".txt"), "{html_path}");
    assert_eq!(after[0]["format"], "html");
    assert_eq!(
        std::fs::read_to_string(run.join(html_path)).unwrap(),
        std::fs::read_to_string(&lighthouse).unwrap()
    );
    for entry in std::fs::read_dir(run.join("artifacts")).unwrap() {
        let name = entry.unwrap().file_name().into_string().unwrap();
        assert!(name.ends_with(".txt"), "only inert text is stored: {name}");
    }

    let report = recorded["report"].as_str().unwrap();
    for unsafe_text in ["<script", "onerror", "<b>", "logsecret123", "reasonsecret"] {
        assert!(!report.contains(unsafe_text), "{unsafe_text} in {report}");
    }
    assert!(report.contains("\\<b\\>Lighthouse\\</b\\>"), "{report}");
    assert!(
        report.contains(&format!(
            "({html_path}) (report from lighthouse, html, captured at 2026-10-28T11:05:00Z, "
        )),
        "{report}"
    );
    assert!(
        report.contains("- Desktop tree (tree from atspi-tree): unavailable at 2026-10-28T11:00:02Z, AT-SPI capture is not supported yet; token=\\[REDACTED\\]"),
        "{report}"
    );
}

#[test]
fn rejects_invalid_captures_and_artifacts_before_writing_a_run() {
    let (temp, project, env, state) = fixture();
    let log = write(temp.path(), "log.txt", "I/flutter: ok\n");
    let png = write(temp.path(), "frame.png", b"\x89PNG\r\n\x1a\n");
    let artifact_cases = [
        (
            json!({"kind": "log", "label": "x", "source": log}),
            "need an origin",
        ),
        (
            json!({"kind": "log", "origin": "lighthouse", "label": "x", "source": log}),
            "records a report artifact, not a log",
        ),
        (
            json!({"kind": "screenshot", "origin": "android-ui-tree", "label": "x", "source": png}),
            "take only kind, label and source",
        ),
        (
            json!({"kind": "screenshot", "label": "x", "unavailable": "no display"}),
            "take only kind, label and source",
        ),
        (
            json!({"kind": "screenshot", "label": "x"}),
            "source is required",
        ),
        (
            json!({"kind": "log", "origin": "android-logcat", "label": "x"}),
            "source is required",
        ),
        (
            json!({"kind": "log", "origin": "android-logcat", "label": "x", "source": log, "unavailable": "adb offline"}),
            "not both",
        ),
        (
            json!({"kind": "log", "origin": "android-logcat", "label": "x", "unavailable": "line\nbreak"}),
            "unavailable reason",
        ),
        (
            json!({"kind": "log", "origin": "android-logcat", "label": "x", "source": log, "capturedAt": "yesterday"}),
            "RFC 3339",
        ),
        (
            json!({"kind": "log", "origin": "adb-shell", "label": "x", "source": log}),
            "unknown variant",
        ),
        (
            json!({"kind": "video", "label": "x", "source": log}),
            "unknown variant",
        ),
    ];
    for (artifact, message) in artifact_cases {
        let mut input = base();
        input["before"]["artifacts"] = json!([artifact]);
        let error = record(&project, &env, &input).unwrap_err().to_string();
        assert!(error.contains(message), "{artifact}: {error}");
    }
    let capture_cases = [
        (
            json!({"requested": {"darkMode": "unknown"}}),
            "must be a concrete value",
        ),
        (
            json!({"requested": {"rotation": 45}}),
            "rotation must be 0, 90, 180 or 270 degrees",
        ),
        (json!({"observed": {"rotation": 45}}), "or \"unknown\""),
        (
            json!({"observed": {"density": 0}}),
            "density must be an integer dpi",
        ),
        (
            json!({"observed": {"fontScale": -1}}),
            "fontScale must be a number",
        ),
        (
            json!({"observed": {"darkMode": "yes"}}),
            "darkMode must be true or false",
        ),
        (
            json!({"observed": {"locale": "en\u{202e}US"}}),
            "locale must be a single-line string",
        ),
        (json!({"observed": {"hinge": "open"}}), "unknown field"),
        (
            json!({"capturedAt": "2026-10-28"}),
            "capturedAt must be RFC 3339",
        ),
        (json!({"appBuild": ""}), "appBuild must be nonempty"),
        (json!({"battery": 9}), "unknown field"),
    ];
    for (capture, message) in capture_cases {
        let mut input = base();
        input["after"]["capture"] = capture.clone();
        let error = record(&project, &env, &input).unwrap_err().to_string();
        assert!(error.contains(message), "{capture}: {error}");
    }
    assert_no_runs(&state);
}

#[test]
fn oversize_and_non_utf8_text_fail_without_leaving_a_partial_run() {
    let (temp, project, env, state) = fixture();
    let fine = write(temp.path(), "fine.txt", "I/flutter: ok\n");
    let limit = usize::try_from(MAX_TEXT_ARTIFACT_BYTES).unwrap();
    let at_limit = write(temp.path(), "at-limit.txt", "a".repeat(limit));
    let oversize = write(temp.path(), "oversize.txt", "a".repeat(limit + 1));
    // Exactly at the limit when read, but each redacted line grows from 8 to 17 bytes.
    let grows = write(temp.path(), "grows.txt", "token=a\n".repeat(limit / 8));
    let binary = write(temp.path(), "binary.txt", [0xff, 0xfe, 0x00, 0x41]);
    let missing = temp.path().join("missing.txt");
    for (source, message) in [
        (&oversize, "text artifact exceeds 4 MiB"),
        (&grows, "exceeds 4 MiB after redaction"),
        (&binary, "not valid UTF-8"),
        (&missing, "unsafe artifact"),
    ] {
        let mut input = base();
        // The first artifact is valid and copied before the second one fails.
        input["before"]["artifacts"] = json!([
            {"kind": "log", "origin": "devtools-console", "label": "first", "source": fine},
            {"kind": "log", "origin": "devtools-console", "label": "second", "source": source}
        ]);
        let error = record(&project, &env, &input).unwrap_err().to_string();
        assert!(error.contains(message), "{error}");
        assert_no_runs(&state);
    }
    let mut input = base();
    input["before"]["artifacts"] = json!([
        {"kind": "tree", "origin": "devtools-accessibility", "label": "snapshot", "source": at_limit}
    ]);
    let recorded = record(&project, &env, &input).unwrap();
    assert_eq!(
        recorded["document"]["before"]["artifacts"][0]["bytes"],
        limit
    );
}

#[cfg(unix)]
#[test]
fn refuses_linked_text_sources() {
    let (temp, project, env, state) = fixture();
    let log = write(temp.path(), "log.txt", "I/flutter: ok\n");
    let link = temp.path().join("link.txt");
    std::os::unix::fs::symlink(&log, &link).unwrap();
    let hard = temp.path().join("hard.txt");
    std::fs::hard_link(&log, &hard).unwrap();
    for source in [&link, &hard] {
        let mut input = base();
        input["before"]["artifacts"] =
            json!([{"kind": "log", "origin": "android-logcat", "label": "x", "source": source}]);
        assert!(
            record(&project, &env, &input).is_err(),
            "{}",
            source.display()
        );
    }
    assert_no_runs(&state);
}

fn noisy_png(side: u32) -> Vec<u8> {
    let mut state = 7u32;
    let mut pixels = vec![0; side as usize * side as usize * 3];
    for byte in &mut pixels {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        *byte = state as u8;
    }
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgb8(image::RgbImage::from_raw(side, side, pixels).unwrap())
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .unwrap();
    bytes
}

#[test]
fn text_artifacts_count_toward_the_run_budget() {
    let (temp, project, env, state) = fixture();
    let image = write(temp.path(), "noise.png", noisy_png(1569));
    let limit = usize::try_from(MAX_TEXT_ARTIFACT_BYTES).unwrap();
    // Fifteen distinct 4 MiB logs plus one image of about 7 MiB cross the 64 MiB run budget.
    let log = |index: usize| {
        let source = write(
            temp.path(),
            &format!("log-{index}.txt"),
            char::from(b'a' + index as u8).to_string().repeat(limit),
        );
        json!({"kind": "log", "origin": "android-logcat", "label": "log", "source": source})
    };
    let mut input = base();
    input["before"]["artifacts"] =
        json!([{"kind": "screenshot", "label": "noise", "source": image}]);
    input["steps"] = json!([
        {"label": "one", "summary": "", "observations": [], "artifacts": (0..8).map(log).collect::<Vec<_>>()},
        {"label": "two", "summary": "", "observations": [], "artifacts": (8..15).map(log).collect::<Vec<_>>()}
    ]);
    let error = record(&project, &env, &input).unwrap_err().to_string();
    assert!(error.contains("exceed 64 MiB total"), "{error}");
    assert!(
        error.contains("log-"),
        "the text artifact crossed the budget: {error}"
    );
    assert_no_runs(&state);
}

#[test]
fn a_real_v3_input_still_records_and_matches_its_v3_document() {
    let (temp, project, env, _state) = fixture();
    let fixture = Path::new(V3_FIXTURE);
    let run = fixture.join(V3_RUN);
    let v3: Value =
        serde_json::from_slice(&std::fs::read(run.join("evidence.json")).unwrap()).unwrap();
    assert_eq!(v3["schemaVersion"], 3);
    let mut input: Value =
        serde_json::from_slice(&std::fs::read(fixture.join("input.json")).unwrap()).unwrap();
    assert_eq!(input["schemaVersion"], 3);
    // The recorded sources lived in a throwaway directory; the run kept identical copies.
    for phase in ["before", "after"] {
        let stored = v3[phase]["artifacts"][0]["path"].as_str().unwrap();
        let copy = write(
            temp.path(),
            &format!("{phase}.png"),
            std::fs::read(run.join(stored)).unwrap(),
        );
        input[phase]["artifacts"][0]["source"] = json!(copy);
    }
    let recorded = record(&project, &env, &input).unwrap();
    let document = &recorded["document"];
    assert_eq!(document["schemaVersion"], EVIDENCE_SCHEMA_VERSION);
    for field in [
        "scenario",
        "outcome",
        "sourceChanges",
        "checks",
        "limitations",
    ] {
        assert_eq!(document[field], v3[field], "{field}");
    }
    for phase in ["before", "after"] {
        let mut v4 = document[phase].clone();
        assert_eq!(v4["capture"]["observed"]["foldState"], "unknown");
        v4.as_object_mut().unwrap().remove("capture");
        assert_eq!(v4, v3[phase], "{phase}");
    }
    assert_eq!(document["steps"][0]["label"], v3["steps"][0]["label"]);
    let v3_report = std::fs::read_to_string(run.join("report.md")).unwrap();
    assert_eq!(recorded["report"].as_str().unwrap(), v3_report);
}
