use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use pickforge_cli::adapters::{Harness, IntegrationPack};
use pickforge_cli::evidence::{record_at, EvidenceError, EVIDENCE_SCHEMA_VERSION};
use pickforge_cli::project::{canonical_project_path, derive_project_id};
use pickforge_cli::{apply_init, plan_init, Environment, InitRequest};
use tempfile::TempDir;

const PUBSPEC: &str = "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n";
const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfixture";

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
        "schemaVersion":1,
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
    std::fs::write(&first, PNG).unwrap();
    std::fs::write(&alias, PNG).unwrap();
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
    let artifact = serde_json::json!({
        "kind":"screenshot","label":"Initial *shot*",
        "path":"artifacts/before-initial-shot-bd54b02fae14.png",
        "sha256":"bd54b02fae14b6b9ed73887ded339b8ef846fbcba0d4e5f9d95470ac23ade242",
        "bytes":15,"mediaType":"image/png"
    });
    let mut final_artifact = artifact.clone();
    final_artifact["label"] = "Final [shot]".into();
    let expected = serde_json::json!({
        "schemaVersion":EVIDENCE_SCHEMA_VERSION,"runId":"20240101-000000-flutter","projectId":project_id,
        "projectPath":canonical_project.to_str().unwrap(),"createdAt":"2024-01-01T00:00:00Z",
        "scenario":"Counter *increments*","outcome":"passed",
        "before":{"summary":"Counter was **zero**.\nSecond line.","observations":[{"label":"Counter_[raw]","value":"0\nstill zero"}],"artifacts":[artifact]},
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
    assert_eq!(report, "# Flutter evidence: Counter \\*increments\\*\n\n**Outcome:** passed\n\n## Before\n\nCounter was \\*\\*zero\\*\\*. Second line.\n\n- **Counter\\_\\[raw\\]:** 0 still zero\n\n## After\n\nCounter is one.\n\n- **Counter:** 1\n\n## Source changes\n\n- lib/main.dart\n\n## Checks\n\n- **flutter test** (Passed): Passed.\n\n## Artifacts\n\n- [Initial \\*shot\\*](artifacts/before-initial-shot-bd54b02fae14.png) (15 bytes, `bd54b02fae14b6b9ed73887ded339b8ef846fbcba0d4e5f9d95470ac23ade242`)\n- [Final \\[shot\\]](artifacts/before-initial-shot-bd54b02fae14.png) (15 bytes, `bd54b02fae14b6b9ed73887ded339b8ef846fbcba0d4e5f9d95470ac23ade242`)\n\n## Limitations\n\n- Pixel review was manual.\n");
}

#[test]
fn collision_suffixing_and_atomic_failure_cleanup() {
    let (_temp, project, env, state) = fixture();
    let image = state.parent().unwrap().join("image");
    std::fs::write(&image, PNG).unwrap();
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
        serde_json::json!({"schemaVersion":2,"scenario":"x","outcome":"passed","before":{"summary":"","observations":[],"artifacts":[]},"after":{"summary":"","observations":[],"artifacts":[]}}),
        serde_json::json!({"schemaVersion":1,"scenario":"x\n# fake","outcome":"passed","before":{"summary":"","observations":[],"artifacts":[]},"after":{"summary":"","observations":[],"artifacts":[]}}),
        serde_json::json!({"schemaVersion":1,"scenario":"x","outcome":"passed","before":{"summary":"","observations":[],"artifacts":[]},"after":{"summary":"","observations":[],"artifacts":[]},"sourceChanges":["../secret"]}),
        serde_json::json!({"schemaVersion":1,"scenario":"x","outcome":"passed","before":{"summary":"safe\u{202e}spoof","observations":[],"artifacts":[]},"after":{"summary":"","observations":[] ,"artifacts":[]}}),
        serde_json::json!({"schemaVersion":1,"scenario":"x","outcome":"passed","before":{"summary":"","observations":[],"artifacts":[]},"after":{"summary":"","observations":[],"artifacts":[]},"sourceChanges":["lib/safe\u{2066}spoof.dart"]}),
        serde_json::json!({"schemaVersion":1,"scenario":"x","outcome":"passed","before":{"summary":"","observations":[],"artifacts":[],"unknown":1},"after":{"summary":"","observations":[],"artifacts":[]}}),
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
    std::fs::write(&image, b"\x89PNG\r\n\x1a\nimage").unwrap();
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
    let (_temp, project, env, _state) = fixture();
    let secrets = "safe-before token: \"quotedsecret\" safe-middle password='singlesecret' api_key=abc123 {\"token\":\"jsonsecret\"} Authorization: Bearer authsecret safe-after eyJabc.def.ghi ghp_123456789 sk-123456789 AKIA1234567890123456 Cookie: sid=cookiesecret";
    let input = serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"scenario":"Secrets test","outcome":"inconclusive","before":{"summary":secrets,"observations":[{"label":"safe","value":secrets}],"artifacts":[]},"after":{"summary":secrets,"observations":[],"artifacts":[]},"sourceChanges":[],"checks":[{"name":"check","status":"skipped","summary":secrets}],"limitations":[secrets]})).unwrap();
    let result = record_at(&project, &env, &input, UNIX_EPOCH).unwrap();
    let outputs = [
        std::fs::read_to_string(result.evidence_path).unwrap(),
        std::fs::read_to_string(result.report_path).unwrap(),
    ];
    for output in &outputs {
        assert!(output.contains("[REDACTED]"), "{output}");
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
    std::fs::write(&small, PNG).unwrap();
    let too_many = (0..9)
        .map(|_| ("image", small.as_path()))
        .collect::<Vec<_>>();
    assert!(record_at(&project, &env, &envelope(&too_many, &too_many), UNIX_EPOCH).is_err());

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
    std::fs::write(&image, PNG).unwrap();
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
