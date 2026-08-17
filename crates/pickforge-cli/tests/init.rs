use std::path::Path;
use std::time::SystemTime;

use pickforge_cli::adapters::{codex_config, json_config, Harness, IntegrationPack, McpServerSpec};
use pickforge_cli::{apply_init, plan_init, Environment, InitRequest};
use tempfile::TempDir;

const PUBSPEC: &str = "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n";

fn pack() -> IntegrationPack {
    IntegrationPack {
        name: "fixture".into(),
        version: 7,
        mcp_servers: vec![McpServerSpec {
            name: "pickforge-helper".into(),
            command: "pickforge".into(),
            args: vec!["serve".into(), "a b".into()],
        }],
    }
}

fn fixture() -> (TempDir, std::path::PathBuf, Environment) {
    let temp = TempDir::new().unwrap();
    let project = temp.path().join("app");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(project.join("pubspec.yaml"), PUBSPEC).unwrap();
    let env = Environment::empty()
        .with_home_dir(temp.path().join("home"))
        .with_var("PICKFORGE_HOME", temp.path().join("state"));
    (temp, project, env)
}

#[test]
fn empty_pack_only_plans_and_applies_a_deterministic_receipt() {
    let (temp, project, env) = fixture();
    let request = InitRequest::new(&project);
    let plan = plan_init(&request, &env).unwrap();
    assert_eq!(plan.report.actions.len(), 1);
    assert!(!temp.path().join("state").exists());
    let first = apply_init(&plan, "1");
    assert!(first.changed);
    let receipt = Path::new(&plan.report.state_dir).join("project.json");
    let bytes = std::fs::read(&receipt).unwrap();
    let mtime = std::fs::metadata(&receipt).unwrap().modified().unwrap();
    let second_plan = plan_init(&request, &env).unwrap();
    let second = apply_init(&second_plan, "2");
    assert!(!second.changed);
    assert_eq!(std::fs::read(&receipt).unwrap(), bytes);
    assert_eq!(
        std::fs::metadata(&receipt).unwrap().modified().unwrap(),
        mtime
    );
    assert!(first.backup_paths.is_empty());
    assert!(second.backup_paths.is_empty());
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(
        value["harnesses"],
        serde_json::json!(["claude-code", "codex", "pi"])
    );
}

#[test]
fn foreign_or_malformed_receipts_are_never_overwritten() {
    for existing in [
        b"not json\n".as_slice(),
        br#"{"schemaVersion":1,"projectPath":"/other","projectId":"other"}"#.as_slice(),
    ] {
        let (_temp, project, env) = fixture();
        let request = InitRequest::new(&project);
        let initial_plan = plan_init(&request, &env).unwrap();
        let receipt = Path::new(&initial_plan.report.state_dir).join("project.json");
        std::fs::create_dir_all(receipt.parent().unwrap()).unwrap();
        std::fs::write(&receipt, existing).unwrap();
        let error = plan_init(&request, &env).unwrap_err().to_string();
        assert!(error.contains("receipt"), "{error}");
        assert_eq!(std::fs::read(&receipt).unwrap(), existing);
    }
}

#[test]
fn nonempty_unowned_state_directory_is_refused() {
    let (_temp, project, env) = fixture();
    let request = InitRequest::new(&project);
    let initial_plan = plan_init(&request, &env).unwrap();
    let state_dir = Path::new(&initial_plan.report.state_dir);
    std::fs::create_dir_all(state_dir).unwrap();
    std::fs::write(state_dir.join("foreign.txt"), "user-owned").unwrap();
    let error = plan_init(&request, &env).unwrap_err().to_string();
    assert!(error.contains("non-empty"), "{error}");
    assert_eq!(
        std::fs::read_to_string(state_dir.join("foreign.txt")).unwrap(),
        "user-owned"
    );
}

#[test]
fn json_adapters_create_merge_validate_and_are_equivalent_and_idempotent() {
    let created = json_config(None, &pack(), "config").unwrap().unwrap();
    let created_value: serde_json::Value = serde_json::from_slice(&created).unwrap();
    assert_eq!(
        created_value["mcpServers"]["pickforge-helper"]["command"],
        "pickforge"
    );

    let input = r#"{"root":1,"mcpServers":{"foreign":{"command":"x"}}}"#;
    let claude = json_config(Some(input), &pack(), "Claude Code config")
        .unwrap()
        .unwrap();
    let pi = json_config(Some(input), &pack(), "Pi MCP config")
        .unwrap()
        .unwrap();
    assert_eq!(claude, pi);
    assert_eq!(
        json_config(
            Some(std::str::from_utf8(&claude).unwrap()),
            &pack(),
            "Claude Code config"
        )
        .unwrap()
        .unwrap(),
        claude
    );
    let value: serde_json::Value = serde_json::from_slice(&claude).unwrap();
    assert_eq!(value["root"], 1);
    assert_eq!(value["mcpServers"]["foreign"]["command"], "x");
    assert!(json_config(Some("[]"), &pack(), "config").is_err());
    assert!(json_config(Some("{"), &pack(), "config").is_err());
    assert!(json_config(Some(r#"{"mcpServers":1}"#), &pack(), "config").is_err());

    let mut invalid = pack();
    invalid.mcp_servers[0].name = "pickforge-invalid.name".into();
    assert!(json_config(None, &invalid, "config").is_err());
    let mut duplicate = pack();
    duplicate.mcp_servers.push(duplicate.mcp_servers[0].clone());
    assert!(json_config(None, &duplicate, "config").is_err());
}

#[test]
fn codex_managed_block_creates_and_preserves_surroundings_and_newline_style() {
    let created = String::from_utf8(codex_config(None, &pack()).unwrap().unwrap()).unwrap();
    assert!(created.starts_with("# >>> pickforge >>>\n"));
    assert!(created.contains("[mcp_servers.\"pickforge-helper\"]"));
    assert!(created.ends_with("# <<< pickforge <<<\n"));

    let input = "title = \"foreign\"\r\n\r\n# >>> pickforge >>>\r\nold = true\r\n# <<< pickforge <<<\r\n\r\n[other]\r\nx = 1\r\n";
    let rendered = codex_config(Some(input), &pack()).unwrap().unwrap();
    let text = String::from_utf8(rendered.clone()).unwrap();
    assert!(text.starts_with("title = \"foreign\"\r\n\r\n# >>> pickforge >>>"));
    assert!(text.ends_with("\r\n\r\n[other]\r\nx = 1\r\n"));
    assert!(!text.replace("\r\n", "").contains('\n'));
    assert_eq!(
        codex_config(Some(&text), &pack()).unwrap().unwrap(),
        rendered
    );
    assert!(codex_config(Some("# >>> pickforge >>>\n"), &pack()).is_err());
    for foreign in [
        "[mcp_servers.\"pickforge-helper\"]\n",
        "[mcp_servers . 'pickforge-helper'] # foreign\n",
        "[[\"mcp_servers\".'pickforge-helper'.env]]\n",
    ] {
        assert!(codex_config(Some(foreign), &pack()).is_err(), "{foreign}");
    }
    assert!(codex_config(Some("[mcp_servers.\"pickforge-helperx\"]\n"), &pack()).is_ok());
}

#[test]
fn planning_nonempty_pack_is_read_only_and_deduplicates_in_fixed_order() {
    let (temp, project, env) = fixture();
    let mut request = InitRequest::new(project);
    request.pack = pack();
    request.harnesses = vec![Harness::Pi, Harness::ClaudeCode, Harness::Pi];
    let before = SystemTime::now();
    let plan = plan_init(&request, &env).unwrap();
    assert_eq!(
        plan.report.harnesses,
        vec![Harness::ClaudeCode, Harness::Pi]
    );
    assert_eq!(plan.report.actions.len(), 3);
    assert!(plan.report.actions.iter().any(|action| action
        .warning
        .as_deref()
        .is_some_and(|warning| warning.contains("pi-mcp-adapter"))));
    assert!(!temp.path().join("home").exists());
    assert!(!temp.path().join("state").exists());
    assert!(before.elapsed().is_ok());
}

#[test]
fn codex_absolute_home_override_works_without_a_user_home_and_relative_override_refuses() {
    let (temp, project, _) = fixture();
    let mut request = InitRequest::new(&project);
    request.pack = pack();
    request.harnesses = vec![Harness::Codex];
    let env = Environment::empty()
        .with_var("PICKFORGE_HOME", temp.path().join("state"))
        .with_var("CODEX_HOME", temp.path().join("codex"));
    let plan = plan_init(&request, &env).unwrap();
    assert!(plan.report.actions[0].target.ends_with("config.toml"));
    assert!(!temp.path().join("codex").exists());

    let relative = env.with_var("CODEX_HOME", "relative");
    let error = plan_init(&request, &relative).unwrap_err().to_string();
    assert!(
        error.contains("CODEX_HOME must be an absolute path"),
        "{error}"
    );
    assert!(!temp.path().join("state").exists());
}
