use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use image::{DynamicImage, GenericImageView, ImageBuffer, ImageFormat, Rgb, RgbImage};
use pickforge_cli::adapters::{Harness, IntegrationPack};
use pickforge_cli::evidence::{
    record_at, EvidenceError, EVIDENCE_SCHEMA_VERSION, MAX_EVIDENCE_STEPS,
};
use pickforge_cli::project::{canonical_project_path, derive_project_id};
use pickforge_cli::{apply_init, plan_init, Environment, InitRequest};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

const PUBSPEC: &str = "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n";

fn encode_png(image: RgbImage) -> Vec<u8> {
    let mut bytes = Vec::new();
    DynamicImage::ImageRgb8(image)
        .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
        .unwrap();
    bytes
}

fn solid_png(width: u32, height: u32) -> Vec<u8> {
    encode_png(ImageBuffer::from_pixel(width, height, Rgb([17, 83, 149])))
}

fn noisy_png(width: u32, height: u32, seed: u32) -> Vec<u8> {
    let mut state = seed;
    let mut pixels = vec![0; width as usize * height as usize * 3];
    for byte in &mut pixels {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        *byte = state as u8;
    }
    encode_png(ImageBuffer::from_raw(width, height, pixels).unwrap())
}

fn fixture() -> (TempDir, PathBuf, Environment, PathBuf) {
    let temp = TempDir::new().unwrap();
    let project = temp.path().join("app");
    std::fs::create_dir(&project).unwrap();
    std::fs::write(project.join("pubspec.yaml"), PUBSPEC).unwrap();
    let state = temp.path().join("state");
    let env = Environment::empty()
        .with_home_dir(temp.path().join("home"))
        .with_var("PICKFORGE_HOME", &state);
    let mut request = InitRequest::new(&project);
    request.pack = IntegrationPack::flutter();
    request.harnesses = vec![Harness::Codex];
    let bin = temp.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let dart = if cfg!(windows) {
        bin.join("dart.EXE")
    } else {
        bin.join("dart")
    };
    std::fs::write(&dart, "fixture").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dart, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let env = env.with_var("PATH", &bin).with_var("PATHEXT", ".EXE");
    let plan = plan_init(&request, &env).unwrap();
    assert!(apply_init(&plan, "fixture").changed);
    (temp, project, env, PathBuf::from(plan.report.state_dir))
}

fn envelope(before: &[(&str, &Path)], after: &[(&str, &Path)]) -> Vec<u8> {
    let artifacts = |items: &[(&str, &Path)]| {
        items.iter().map(|(label, path)| serde_json::json!({"kind":"screenshot","label":label,"source":path})).collect::<Vec<_>>()
    };
    serde_json::to_vec(&serde_json::json!({
        "schemaVersion":EVIDENCE_SCHEMA_VERSION,
        "scenario":"Counter increments",
        "outcome":"passed",
        "before":{"summary":"Counter was zero.","observations":[{"label":"Counter","value":"0"}],"artifacts":artifacts(before)},
        "after":{"summary":"Counter is one.","observations":[{"label":"Counter","value":"1"}],"artifacts":artifacts(after)},
        "sourceChanges":["lib/main.dart","lib/main.dart"],
        "checks":[{"name":"flutter test","status":"passed","summary":"Passed."}],
        "limitations":["Pixel review was manual."]
    })).unwrap()
}

#[test]
fn golden_documents_are_byte_exact_and_aliases_dedupe() {
    let (_temp, project, env, state) = fixture();
    let first = state.parent().unwrap().join("first.any");
    let alias = state.parent().unwrap().join("alias.jpg");
    let source_bytes = solid_png(1, 1);
    std::fs::write(&first, &source_bytes).unwrap();
    std::fs::write(&alias, &source_bytes).unwrap();
    let mut input: serde_json::Value = serde_json::from_slice(&envelope(
        &[("Initial *shot*", &first)],
        &[("Final [shot]", &alias)],
    ))
    .unwrap();
    input["scenario"] = "Counter *increments*".into();
    input["before"]["summary"] = "Counter was **zero**.\nSecond line.".into();
    input["before"]["observations"][0]["label"] = "Counter_[raw]".into();
    input["before"]["observations"][0]["value"] = "0\nstill zero".into();
    let result = record_at(
        &project,
        &env,
        &serde_json::to_vec(&input).unwrap(),
        UNIX_EPOCH + Duration::from_secs(1_704_067_200),
    )
    .unwrap();
    assert_eq!(result.run_id, "20240101-000000-flutter");
    let json = std::fs::read_to_string(&result.evidence_path).unwrap();
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(value["schemaVersion"], EVIDENCE_SCHEMA_VERSION);
    assert_eq!(value["createdAt"], "2024-01-01T00:00:00Z");
    assert_eq!(value["sourceChanges"], serde_json::json!(["lib/main.dart"]));
    assert_eq!(
        value["before"]["artifacts"][0]["path"],
        value["after"]["artifacts"][0]["path"]
    );
    let canonical_project = canonical_project_path(&project);
    let project_id = derive_project_id(&canonical_project).unwrap();
    let hash = format!("{:x}", Sha256::digest(&source_bytes));
    let hash_prefix = &hash[..12];
    let artifact_path = format!("artifacts/before-initial-shot-{hash_prefix}.png");
    let artifact = serde_json::json!({
        "kind":"screenshot","label":"Initial *shot*",
        "path":artifact_path.clone(),
        "width":1,"height":1,
        "sha256":hash.clone(),
        "bytes":source_bytes.len(),"mediaType":"image/png"
    });
    assert!(value["before"]["artifacts"][0].get("preview").is_none());
    let mut final_artifact = artifact.clone();
    final_artifact["label"] = "Final [shot]".into();
    let expected = serde_json::json!({
        "schemaVersion":EVIDENCE_SCHEMA_VERSION,"runId":"20240101-000000-flutter","projectId":project_id,
        "projectPath":canonical_project.to_str().unwrap(),"createdAt":"2024-01-01T00:00:00Z",
        "scenario":"Counter *increments*","outcome":"passed",
        "before":{"summary":"Counter was **zero**.\nSecond line.","observations":[{"label":"Counter_[raw]","value":"0\nstill zero"}],"artifacts":[artifact]},
        "steps":[],
        "after":{"summary":"Counter is one.","observations":[{"label":"Counter","value":"1"}],"artifacts":[final_artifact]},
        "sourceChanges":["lib/main.dart"],"checks":[{"name":"flutter test","status":"passed","summary":"Passed."}],
        "limitations":["Pixel review was manual."]
    });
    assert_eq!(
        json,
        format!("{}\n", serde_json::to_string_pretty(&expected).unwrap())
    );
    let artifact_dir = Path::new(&result.evidence_path)
        .parent()
        .unwrap()
        .join("artifacts");
    assert_eq!(std::fs::read_dir(artifact_dir).unwrap().count(), 1);
    let report = std::fs::read_to_string(&result.report_path).unwrap();
    let expected_report = format!("# Flutter evidence: Counter \\*increments\\*\n\n**Outcome:** passed\n\n## Before\n\nCounter was \\*\\*zero\\*\\*. Second line.\n\n- **Counter\\_\\[raw\\]:** 0 still zero\n\n## After\n\nCounter is one.\n\n- **Counter:** 1\n\n## Source changes\n\n- lib/main.dart\n\n## Checks\n\n- **flutter test** (Passed): Passed.\n\n## Artifacts\n\n- [Initial \\*shot\\*]({artifact_path}) (1x1, {} bytes, `{hash}`)\n- [Final \\[shot\\]]({artifact_path}) (1x1, {} bytes, `{hash}`)\n\n## Limitations\n\n- Pixel review was manual.\n", source_bytes.len(), source_bytes.len());
    assert_eq!(report, expected_report);
}

#[test]
fn records_steps_in_order_with_deduplicated_artifacts_and_check_references() {
    let (_temp, project, env, state) = fixture();
    let source = state.parent().unwrap().join("clicked.png");
    let alias = state.parent().unwrap().join("clicked-alias.png");
    let source_bytes = solid_png(2000, 1000);
    std::fs::write(&source, &source_bytes).unwrap();
    std::fs::write(&alias, &source_bytes).unwrap();
    let mut input: serde_json::Value = serde_json::from_slice(&envelope(&[], &[])).unwrap();
    input["steps"] = serde_json::json!([
        {
            "label":"Clicks complete",
            "summary":"Counter reached two with the old theme.",
            "observations":[{"label":"Counter","value":"2"}],
            "artifacts":[{"kind":"screenshot","label":"Clicked frame","source":source}]
        },
        {
            "label":"Hot reload complete",
            "summary":"The new theme appeared without resetting the counter.",
            "observations":[{"label":"Theme","value":"teal"}],
            "artifacts":[{"kind":"screenshot","label":"Reloaded frame","source":alias}]
        }
    ]);
    input["checks"] = serde_json::json!([{
        "name":"desktop click",
        "status":"passed",
        "summary":"Counter advanced to two.",
        "step":"Clicks complete"
    }]);

    let result = record_at(
        &project,
        &env,
        &serde_json::to_vec(&input).unwrap(),
        UNIX_EPOCH,
    )
    .unwrap();
    let document: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&result.evidence_path).unwrap()).unwrap();
    assert_eq!(document["steps"][0]["label"], "Clicks complete");
    assert_eq!(document["steps"][1]["label"], "Hot reload complete");
    assert_eq!(document["checks"][0]["step"], "Clicks complete");
    assert_eq!(
        document["steps"][0]["artifacts"][0]["path"],
        document["steps"][1]["artifacts"][0]["path"]
    );
    assert_eq!(
        document["steps"][0]["artifacts"][0]["preview"],
        document["steps"][1]["artifacts"][0]["preview"]
    );
    let artifact_dir = Path::new(&result.evidence_path)
        .parent()
        .unwrap()
        .join("artifacts");
    assert_eq!(std::fs::read_dir(artifact_dir).unwrap().count(), 2);

    let report = std::fs::read_to_string(result.report_path).unwrap();
    let before = report.find("## Before").unwrap();
    let clicks = report.find("## Step: Clicks complete").unwrap();
    let clicked_artifact = report.find("[Clicked frame]").unwrap();
    let reload = report.find("## Step: Hot reload complete").unwrap();
    let reloaded_artifact = report.find("[Reloaded frame]").unwrap();
    let after = report.find("## After").unwrap();
    assert!(
        before < clicks
            && clicks < clicked_artifact
            && clicked_artifact < reload
            && reload < reloaded_artifact
            && reloaded_artifact < after,
        "{report}"
    );
    assert!(
        report.contains("Counter reached two with the old theme.")
            && report.contains("- **Counter:** 2")
            && report.contains("The new theme appeared without resetting the counter.")
            && report.contains("- **Theme:** teal")
            && report.contains("  - [preview]")
            && report.contains("(Passed; step: Clicks complete)"),
        "{report}"
    );
}

#[test]
fn oversized_artifact_gets_one_bounded_preview_and_keeps_its_source_bytes() {
    let (_temp, project, env, state) = fixture();
    let source = state.parent().unwrap().join("wide.png");
    let source_bytes = solid_png(2000, 1000);
    std::fs::write(&source, &source_bytes).unwrap();

    let result = record_at(
        &project,
        &env,
        &envelope(&[("Wide before", &source)], &[("Wide after", &source)]),
        UNIX_EPOCH,
    )
    .unwrap();
    let document: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&result.evidence_path).unwrap()).unwrap();
    let before = &document["before"]["artifacts"][0];
    let after = &document["after"]["artifacts"][0];
    assert_eq!(before["path"], after["path"]);
    assert_eq!(before["preview"], after["preview"]);
    assert_eq!(before["width"], 2000);
    assert_eq!(before["height"], 1000);
    assert_eq!(before["preview"]["width"], 1568);
    assert_eq!(before["preview"]["height"], 784);

    let run_dir = Path::new(&result.evidence_path).parent().unwrap();
    let artifact_path = run_dir.join(before["path"].as_str().unwrap());
    let preview_path = run_dir.join(before["preview"]["path"].as_str().unwrap());
    assert_eq!(std::fs::read(&artifact_path).unwrap(), source_bytes);
    let preview_bytes = std::fs::read(&preview_path).unwrap();
    assert_eq!(
        before["preview"]["sha256"],
        format!("{:x}", Sha256::digest(&preview_bytes))
    );
    assert_eq!(before["preview"]["bytes"], preview_bytes.len() as u64);
    assert_eq!(
        image::load_from_memory(&preview_bytes)
            .unwrap()
            .dimensions(),
        (1568, 784)
    );
    assert_eq!(
        std::fs::read_dir(run_dir.join("artifacts"))
            .unwrap()
            .count(),
        2
    );

    let report = std::fs::read_to_string(result.report_path).unwrap();
    let preview_relative = before["preview"]["path"].as_str().unwrap();
    let artifact_relative = before["path"].as_str().unwrap();
    // The report offers the preview but must never replace the primary evidence with it: a
    // reader of the Markdown alone still has to reach and verify the full capture.
    assert!(report.contains(preview_relative), "{report}");
    assert!(report.contains("1568x784"), "{report}");
    assert!(report.contains(artifact_relative), "{report}");
    assert!(report.contains("2000x1000"), "{report}");
}

#[test]
fn preview_bytes_count_toward_the_total_budget() {
    let (_temp, project, env, state) = fixture();
    let mut paths = Vec::new();
    for seed in 1..=5 {
        let path = state.parent().unwrap().join(format!("noise-{seed}.png"));
        let bytes = noisy_png(1569, 1569, seed);
        assert!(bytes.len() < 8 * 1024 * 1024, "{}", bytes.len());
        std::fs::write(&path, bytes).unwrap();
        paths.push(path);
    }
    let mut input: serde_json::Value = serde_json::from_slice(&envelope(
        &[("noise", paths[0].as_path())],
        &[("noise", paths[4].as_path())],
    ))
    .unwrap();
    input["steps"] = serde_json::json!([
        {"label":"one","summary":"","observations":[],"artifacts":[{"kind":"screenshot","label":"noise","source":paths[1]}]},
        {"label":"two","summary":"","observations":[],"artifacts":[{"kind":"screenshot","label":"noise","source":paths[2]}]},
        {"label":"three","summary":"","observations":[],"artifacts":[{"kind":"screenshot","label":"noise","source":paths[3]}]}
    ]);

    let error = record_at(
        &project,
        &env,
        &serde_json::to_vec(&input).unwrap(),
        UNIX_EPOCH,
    )
    .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("artifacts and previews exceed 64 MiB total"),
        "{error}"
    );
    assert!(std::fs::read_dir(state.join("runs"))
        .unwrap()
        .next()
        .is_none());
}

#[test]
fn collision_suffixing_and_atomic_failure_cleanup() {
    let (_temp, project, env, state) = fixture();
    let image = state.parent().unwrap().join("image");
    std::fs::write(&image, solid_png(1, 1)).unwrap();
    let now = UNIX_EPOCH + Duration::from_secs(1_704_067_200);
    let first = record_at(&project, &env, &envelope(&[], &[("Image", &image)]), now).unwrap();
    let second = record_at(&project, &env, &envelope(&[], &[]), now).unwrap();
    assert_eq!(first.run_id, "20240101-000000-flutter");
    assert_eq!(second.run_id, "20240101-000000-flutter-2");
    let bad = state.parent().unwrap().join("bad");
    std::fs::write(&bad, "not image").unwrap();
    assert!(record_at(
        &project,
        &env,
        &envelope(&[("Good", &image)], &[("Bad", &bad)]),
        now
    )
    .is_err());
    let names = std::fs::read_dir(state.join("runs"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(names.len(), 2, "{names:?}");
    assert!(names
        .iter()
        .all(|name| !name.starts_with(".pickforge-evidence-")));
}

#[test]
fn rejects_receipt_schema_paths_controls_unknown_fields_and_limits() {
    let (_temp, project, env, state) = fixture();
    let valid = envelope(&[], &[]);
    let cases = [
        // Version 0 is below the accepted range and a future version is above it. Version 1 is
        // still valid input: the new fields are derived, so the input shape never changed.
        serde_json::json!({"schemaVersion":0,"scenario":"x","outcome":"passed","before":{"summary":"","observations":[],"artifacts":[]},"after":{"summary":"","observations":[],"artifacts":[]}}),
        serde_json::json!({"schemaVersion":EVIDENCE_SCHEMA_VERSION + 1,"scenario":"x","outcome":"passed","before":{"summary":"","observations":[],"artifacts":[]},"after":{"summary":"","observations":[],"artifacts":[]}}),
        serde_json::json!({"schemaVersion":EVIDENCE_SCHEMA_VERSION,"scenario":"x\n# fake","outcome":"passed","before":{"summary":"","observations":[],"artifacts":[]},"after":{"summary":"","observations":[],"artifacts":[]}}),
        serde_json::json!({"schemaVersion":EVIDENCE_SCHEMA_VERSION,"scenario":"x","outcome":"passed","before":{"summary":"","observations":[],"artifacts":[]},"after":{"summary":"","observations":[],"artifacts":[]},"sourceChanges":["../secret"]}),
        serde_json::json!({"schemaVersion":EVIDENCE_SCHEMA_VERSION,"scenario":"x","outcome":"passed","before":{"summary":"safe\u{202e}spoof","observations":[],"artifacts":[]},"after":{"summary":"","observations":[] ,"artifacts":[]}}),
        serde_json::json!({"schemaVersion":EVIDENCE_SCHEMA_VERSION,"scenario":"x","outcome":"passed","before":{"summary":"","observations":[],"artifacts":[]},"after":{"summary":"","observations":[],"artifacts":[]},"sourceChanges":["lib/safe\u{2066}spoof.dart"]}),
        serde_json::json!({"schemaVersion":EVIDENCE_SCHEMA_VERSION,"scenario":"x","outcome":"passed","before":{"summary":"","observations":[],"artifacts":[]},"steps":[{"label":"safe\u{202e}spoof","summary":"","observations":[],"artifacts":[]}],"after":{"summary":"","observations":[],"artifacts":[]}}),
        serde_json::json!({"schemaVersion":EVIDENCE_SCHEMA_VERSION,"scenario":"x","outcome":"passed","before":{"summary":"","observations":[],"artifacts":[]},"after":{"summary":"","observations":[],"artifacts":[]},"unknown":1}),
    ];
    for case in cases {
        assert!(
            record_at(
                &project,
                &env,
                &serde_json::to_vec(&case).unwrap(),
                UNIX_EPOCH
            )
            .is_err(),
            "{case}"
        );
    }
    // Callers written against versions 1 and 2 keep working. Recorded documents carry v3 and
    // project the absent intermediate states as an empty ordered array.
    for (offset, version) in [1, 2].into_iter().enumerate() {
        let mut legacy: serde_json::Value = serde_json::from_slice(&valid).unwrap();
        legacy["schemaVersion"] = serde_json::json!(version);
        legacy.as_object_mut().unwrap().remove("steps");
        let recorded = record_at(
            &project,
            &env,
            &serde_json::to_vec(&legacy).unwrap(),
            UNIX_EPOCH + Duration::from_secs(offset as u64),
        )
        .unwrap_or_else(|error| panic!("a version {version} document failed: {error}"));
        assert_eq!(recorded.schema_version, EVIDENCE_SCHEMA_VERSION);
        let document: serde_json::Value =
            serde_json::from_slice(&std::fs::read(recorded.evidence_path).unwrap()).unwrap();
        assert_eq!(document["schemaVersion"], 3);
        assert_eq!(document["steps"], serde_json::json!([]));
    }

    let bidi_artifact = project.join("image\u{202e}.png");
    let bidi_input = envelope(&[("image", &bidi_artifact)], &[]);
    assert!(matches!(
        record_at(&project, &env, &bidi_input, UNIX_EPOCH),
        Err(EvidenceError::Input(_))
    ));
    assert!(matches!(
        record_at(&project, &env, &[b'x'; 1024 * 1024 + 1], UNIX_EPOCH),
        Err(EvidenceError::InputTooLarge)
    ));
    assert!(matches!(
        record_at(&project, &env, &[0xff], UNIX_EPOCH),
        Err(EvidenceError::InputUtf8)
    ));
    let mut receipt: serde_json::Value =
        serde_json::from_slice(&std::fs::read(state.join("project.json")).unwrap()).unwrap();
    receipt["schemaVersion"] = 9.into();
    std::fs::write(
        state.join("project.json"),
        serde_json::to_vec(&receipt).unwrap(),
    )
    .unwrap();
    assert!(matches!(
        record_at(&project, &env, &valid, UNIX_EPOCH),
        Err(EvidenceError::Receipt(_))
    ));
    receipt["schemaVersion"] = 1.into();
    receipt["harnesses"] = serde_json::json!(["future-harness"]);
    std::fs::write(
        state.join("project.json"),
        serde_json::to_vec(&receipt).unwrap(),
    )
    .unwrap();
    assert!(matches!(
        record_at(&project, &env, &valid, UNIX_EPOCH),
        Err(EvidenceError::Receipt(_))
    ));
}

#[test]
fn enforces_step_limit_and_rejects_ambiguous_check_references() {
    let (_temp, project, env, _state) = fixture();
    let valid: serde_json::Value = serde_json::from_slice(&envelope(&[], &[])).unwrap();

    let mut too_many = valid.clone();
    too_many["steps"] = serde_json::Value::Array(
        (0..=MAX_EVIDENCE_STEPS)
            .map(|index| {
                serde_json::json!({
                    "label":format!("step {index}"),
                    "summary":"",
                    "observations":[],
                    "artifacts":[]
                })
            })
            .collect(),
    );
    let error = record_at(
        &project,
        &env,
        &serde_json::to_vec(&too_many).unwrap(),
        UNIX_EPOCH,
    )
    .unwrap_err();
    assert!(
        error
            .to_string()
            .contains(&format!("steps exceeds {MAX_EVIDENCE_STEPS} entries")),
        "{error}"
    );

    let mut duplicate = valid.clone();
    duplicate["steps"] = serde_json::json!([
        {"label":"clicked","summary":"first","observations":[],"artifacts":[]},
        {"label":"clicked","summary":"second","observations":[],"artifacts":[]}
    ]);
    duplicate["checks"] = serde_json::json!([{
        "name":"desktop click","status":"passed","summary":"done","step":"clicked"
    }]);
    let error = record_at(
        &project,
        &env,
        &serde_json::to_vec(&duplicate).unwrap(),
        UNIX_EPOCH,
    )
    .unwrap_err();
    assert!(
        error.to_string().contains("step labels must be unique"),
        "{error}"
    );

    let mut redacted_duplicate = valid.clone();
    redacted_duplicate["steps"] = serde_json::json!([
        {"label":"token=first-secret","summary":"","observations":[],"artifacts":[]},
        {"label":"token=second-secret","summary":"","observations":[],"artifacts":[]}
    ]);
    let error = record_at(
        &project,
        &env,
        &serde_json::to_vec(&redacted_duplicate).unwrap(),
        UNIX_EPOCH,
    )
    .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("must remain unique after redaction"),
        "{error}"
    );

    let mut unknown = valid;
    unknown["steps"] = serde_json::json!([
        {"label":"clicked","summary":"","observations":[],"artifacts":[]}
    ]);
    unknown["checks"] = serde_json::json!([{
        "name":"hot reload","status":"passed","summary":"done","step":"reloaded"
    }]);
    let error = record_at(
        &project,
        &env,
        &serde_json::to_vec(&unknown).unwrap(),
        UNIX_EPOCH,
    )
    .unwrap_err();
    assert!(
        error.to_string().contains("references unknown step"),
        "{error}"
    );
}

#[cfg(windows)]
#[test]
fn windows_refuses_hardlinked_receipts_and_source_images() {
    let (_temp, project, env, state) = fixture();
    let receipt = state.join("project.json");
    std::fs::hard_link(&receipt, state.join("receipt-link.json")).unwrap();
    let error = record_at(&project, &env, &envelope(&[], &[]), UNIX_EPOCH).unwrap_err();
    assert!(error.to_string().contains("hardlinked"), "{error}");

    std::fs::remove_file(state.join("receipt-link.json")).unwrap();
    let image = project.join("source.png");
    std::fs::write(&image, solid_png(1, 1)).unwrap();
    std::fs::hard_link(&image, project.join("source-link.png")).unwrap();
    let error = record_at(
        &project,
        &env,
        &envelope(&[("hardlink", &image)], &[]),
        UNIX_EPOCH,
    )
    .unwrap_err();
    assert!(error.to_string().contains("hardlinked"), "{error}");
}

#[test]
fn v1_flutter_receipt_remains_compatible_with_pack_v2_and_future_fields() {
    let (_temp, project, env, state) = fixture();
    let receipt_path = state.join("project.json");
    let mut receipt: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&receipt_path).unwrap()).unwrap();
    assert_eq!(receipt["pack"]["version"], 2);
    receipt["pack"]["version"] = 1.into();
    receipt["futureReceiptField"] = serde_json::json!({"ignored": true});
    receipt["pack"]["futurePackField"] = "ignored".into();
    std::fs::write(&receipt_path, serde_json::to_vec(&receipt).unwrap()).unwrap();

    let result = record_at(&project, &env, &envelope(&[], &[]), UNIX_EPOCH).unwrap();
    assert!(Path::new(&result.evidence_path).is_file());

    let mut request = InitRequest::new(&project);
    request.pack = IntegrationPack::flutter();
    request.harnesses = vec![Harness::Codex];
    let update = plan_init(&request, &env).unwrap();
    assert!(apply_init(&update, "pack-v2-update").changed);
    let updated: serde_json::Value =
        serde_json::from_slice(&std::fs::read(receipt_path).unwrap()).unwrap();
    assert_eq!(updated["pack"]["version"], 2);
}

#[test]
fn every_supported_secret_shape_is_absent_from_both_outputs() {
    let (_temp, project, env, state) = fixture();
    let source = state.parent().unwrap().join("redaction.png");
    std::fs::write(&source, solid_png(1, 1)).unwrap();
    let secrets = "safe-before token: \"quotedsecret\" safe-middle password='singlesecret' api_key=abc123 {\"token\":\"jsonsecret\"} Authorization: Bearer authsecret safe-after eyJabc.def.ghi ghp_123456789 sk-123456789 AKIA1234567890123456 Cookie: sid=cookiesecret";
    let step_label = "Clicked token=step-label-secret";
    let input = serde_json::to_vec(&serde_json::json!({"schemaVersion":EVIDENCE_SCHEMA_VERSION,"scenario":"Secrets test","outcome":"inconclusive","before":{"summary":secrets,"observations":[{"label":"safe","value":secrets}],"artifacts":[]},"steps":[{"label":step_label,"summary":secrets,"observations":[{"label":"token=observation-label-secret","value":secrets}],"artifacts":[{"kind":"screenshot","label":"token=artifact-label-secret","source":source}]}],"after":{"summary":secrets,"observations":[],"artifacts":[]},"sourceChanges":[],"checks":[{"name":"check","status":"skipped","summary":secrets,"step":step_label}],"limitations":[secrets]})).unwrap();
    let result = record_at(&project, &env, &input, UNIX_EPOCH).unwrap();
    let outputs = [
        std::fs::read_to_string(result.evidence_path).unwrap(),
        std::fs::read_to_string(result.report_path).unwrap(),
    ];
    assert!(outputs[0].contains("[REDACTED]"), "{}", outputs[0]);
    assert!(outputs[1].contains("\\[REDACTED\\]"), "{}", outputs[1]);
    for output in &outputs {
        assert!(
            output.contains("safe-before") && output.contains("safe-after"),
            "{output}"
        );
    }
    for secret in [
        "quotedsecret",
        "singlesecret",
        "abc123",
        "jsonsecret",
        "authsecret",
        "cookiesecret",
        "step-label-secret",
        "observation-label-secret",
        "artifact-label-secret",
        "eyJabc.def.ghi",
        "ghp_123456789",
        "sk-123456789",
        "AKIA1234567890123456",
    ] {
        for output in &outputs {
            assert!(!output.contains(secret), "{secret} leaked in {output}");
        }
    }
}

#[test]
fn enforces_image_magic_size_count_and_total_limits() {
    let (_temp, project, env, state) = fixture();
    let oversized = state.parent().unwrap().join("oversized");
    let mut bytes = vec![0; 8 * 1024 * 1024 + 1];
    bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    std::fs::write(&oversized, bytes).unwrap();
    assert!(record_at(
        &project,
        &env,
        &envelope(&[("large", &oversized)], &[]),
        UNIX_EPOCH
    )
    .is_err());

    let small = state.parent().unwrap().join("small");
    std::fs::write(&small, solid_png(1, 1)).unwrap();
    let too_many = (0..9)
        .map(|_| ("image", small.as_path()))
        .collect::<Vec<_>>();
    assert!(record_at(&project, &env, &envelope(&too_many, &too_many), UNIX_EPOCH).is_err());

    let artifact = || serde_json::json!({"kind":"screenshot","label":"image","source":small});
    let mut distributed: serde_json::Value = serde_json::from_slice(&envelope(&[], &[])).unwrap();
    distributed["before"]["artifacts"] = serde_json::json!([artifact()]);
    distributed["steps"] = serde_json::json!([
        {"label":"one","summary":"","observations":[],"artifacts":(0..8).map(|_| artifact()).collect::<Vec<_>>()},
        {"label":"two","summary":"","observations":[],"artifacts":(0..7).map(|_| artifact()).collect::<Vec<_>>()}
    ]);
    distributed["after"]["artifacts"] = serde_json::json!([artifact()]);
    let error = record_at(
        &project,
        &env,
        &serde_json::to_vec(&distributed).unwrap(),
        UNIX_EPOCH,
    )
    .unwrap_err();
    assert!(
        error.to_string().contains("at most 16 artifacts"),
        "{error}"
    );

    let mut paths = Vec::new();
    for index in 0..9u8 {
        let path = state.parent().unwrap().join(format!("large-{index}"));
        let mut image = vec![index; 7_500_000];
        image[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        std::fs::write(&path, image).unwrap();
        paths.push(path);
    }
    let before = paths[..8]
        .iter()
        .map(|path| ("large", path.as_path()))
        .collect::<Vec<_>>();
    let after = [("large", paths[8].as_path())];
    assert!(record_at(&project, &env, &envelope(&before, &after), UNIX_EPOCH).is_err());
    assert!(std::fs::read_dir(state.join("runs"))
        .unwrap()
        .next()
        .is_none());
}

#[cfg(unix)]
#[test]
fn refuses_symlink_hardlink_and_nonregular_artifacts() {
    use std::os::unix::fs::symlink;
    let (_temp, project, env, state) = fixture();
    let image = state.parent().unwrap().join("image");
    std::fs::write(&image, solid_png(1, 1)).unwrap();
    let symlink_path = state.parent().unwrap().join("link");
    symlink(&image, &symlink_path).unwrap();
    let hardlink = state.parent().unwrap().join("hard");
    std::fs::hard_link(&image, &hardlink).unwrap();
    for source in [&symlink_path, &hardlink, state.parent().unwrap()] {
        assert!(record_at(
            &project,
            &env,
            &envelope(&[("bad", source)], &[]),
            UNIX_EPOCH
        )
        .is_err());
    }
}
