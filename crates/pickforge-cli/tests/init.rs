use std::path::Path;
use std::time::SystemTime;

use pickforge_cli::adapters::{
    codex_config, json_config, AdapterError, Harness, HarnessArgsSpec, IntegrationPack,
    McpServerSpec, WorkflowRoot,
};
#[cfg(unix)]
use pickforge_cli::adapters::{WorkflowSpec, WorkflowTargetSpec};
#[cfg(windows)]
use pickforge_cli::init::ActionKind;
use pickforge_cli::init::{ApplyReport, ApplyState};
use pickforge_cli::{apply_init, plan_init, render, Environment, InitRequest};
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
            harness_args: vec![],
        }],
        required_tools: vec![],
        workflows: vec![],
    }
}

fn fake_tool(root: &Path, name: &str) -> std::path::PathBuf {
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    #[cfg(windows)]
    let tool = bin.join(format!("{name}.EXE"));
    #[cfg(not(windows))]
    let tool = bin.join(name);
    std::fs::write(&tool, "not executed").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    bin
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
fn empty_or_owned_interruption_state_allows_receipt_recovery() {
    let (_temp, project, env) = fixture();
    let request = InitRequest::new(&project);
    let initial_plan = plan_init(&request, &env).unwrap();
    let state_dir = Path::new(&initial_plan.report.state_dir);
    std::fs::create_dir_all(state_dir).unwrap();
    assert!(plan_init(&request, &env).is_ok());
    std::fs::write(state_dir.join(".pickforge-tmp-interrupted"), "partial").unwrap();
    let recovery = plan_init(&request, &env).unwrap();
    assert!(apply_init(&recovery, "recovery").changed);
    let receipt = state_dir.join("project.json");
    assert!(receipt.is_file());
    std::fs::rename(
        &receipt,
        state_dir.join("project.json.pickforge-backup-interrupted"),
    )
    .unwrap();
    let backup_recovery = plan_init(&request, &env).unwrap();
    assert!(apply_init(&backup_recovery, "backup-recovery").changed);
    assert!(receipt.is_file());
}

#[cfg(unix)]
#[test]
fn symlinked_home_and_state_roots_are_resolved_safely() {
    use std::os::unix::fs::symlink;

    let (temp, project, _) = fixture();
    let real_home = temp.path().join("real-home");
    let real_state = temp.path().join("real-state");
    std::fs::create_dir(&real_home).unwrap();
    std::fs::create_dir(&real_state).unwrap();
    let linked_home = temp.path().join("linked-home");
    let linked_state = temp.path().join("linked-state");
    symlink(&real_home, &linked_home).unwrap();
    symlink(&real_state, &linked_state).unwrap();
    let env = Environment::empty()
        .with_home_dir(&linked_home)
        .with_var("PICKFORGE_HOME", &linked_state);
    let mut request = InitRequest::new(&project);
    request.pack = pack();
    request.harnesses = vec![Harness::ClaudeCode];
    let plan = plan_init(&request, &env).unwrap();
    let receipt_action = plan.report.actions.last().unwrap();
    assert_eq!(
        Path::new(&plan.report.state_dir),
        Path::new(&receipt_action.target).parent().unwrap()
    );
    assert!(apply_init(&plan, "symlinked").changed);
    assert!(real_home.join(".claude.json").is_file());
    assert!(real_state.join("projects").is_dir());
}

#[test]
fn json_adapters_create_merge_validate_and_are_equivalent_and_idempotent() {
    let created = json_config(None, &pack(), Harness::ClaudeCode, "config")
        .unwrap()
        .unwrap();
    let created_value: serde_json::Value = serde_json::from_slice(&created).unwrap();
    assert_eq!(
        created_value["mcpServers"]["pickforge-helper"]["command"],
        "pickforge"
    );

    let input = r#"{"root":1,"mcpServers":{"foreign":{"command":"x"}}}"#;
    let claude = json_config(
        Some(input),
        &pack(),
        Harness::ClaudeCode,
        "Claude Code config",
    )
    .unwrap()
    .unwrap();
    let pi = json_config(Some(input), &pack(), Harness::Pi, "Pi MCP config")
        .unwrap()
        .unwrap();
    assert_eq!(claude, pi);
    assert_eq!(
        json_config(
            Some(std::str::from_utf8(&claude).unwrap()),
            &pack(),
            Harness::ClaudeCode,
            "Claude Code config"
        )
        .unwrap()
        .unwrap(),
        claude
    );
    let value: serde_json::Value = serde_json::from_slice(&claude).unwrap();
    assert_eq!(value["root"], 1);
    assert_eq!(value["mcpServers"]["foreign"]["command"], "x");
    assert!(json_config(Some("[]"), &pack(), Harness::ClaudeCode, "config").is_err());
    assert!(json_config(Some("{"), &pack(), Harness::ClaudeCode, "config").is_err());
    assert!(json_config(
        Some(r#"{"mcpServers":1}"#),
        &pack(),
        Harness::ClaudeCode,
        "config",
    )
    .is_err());

    let mut invalid = pack();
    invalid.mcp_servers[0].name = "pickforge-invalid.name".into();
    assert!(json_config(None, &invalid, Harness::ClaudeCode, "config").is_err());
    let mut duplicate = pack();
    duplicate.mcp_servers.push(duplicate.mcp_servers[0].clone());
    assert!(json_config(None, &duplicate, Harness::ClaudeCode, "config").is_err());
    let mut control = pack();
    control.mcp_servers[0].args.push("bad\u{7f}".into());
    assert!(codex_config(None, &control).is_err());
}

#[test]
fn codex_managed_block_creates_and_preserves_surroundings_and_newline_style() {
    let created = String::from_utf8(codex_config(None, &pack()).unwrap().unwrap()).unwrap();
    assert!(created.parse::<toml::Table>().is_ok());
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
        "mcp_servers.\"pickforge-helper\".command = \"foreign\"\n",
        "mcp_servers = { \"pickforge-helper\" = { command = \"foreign\", args = [] } }\n",
        "[mcp_servers]\n\"pickforge-helper\" = { command = \"foreign\" }\n",
    ] {
        assert!(codex_config(Some(foreign), &pack()).is_err(), "{foreign}");
    }
    assert!(codex_config(Some("[mcp_servers.\"pickforge-helperx\"]\n"), &pack()).is_ok());
    assert!(codex_config(Some("[mcp_servers]\n"), &pack()).is_ok());
    assert!(codex_config(Some("not = [valid"), &pack()).is_err());
    assert!(matches!(
        codex_config(
            Some("mcp_servers = { other = { command = \"z\" } }\n"),
            &pack()
        ),
        Err(AdapterError::GeneratedToml(_))
    ));

    let crossing_scope = "# >>> pickforge >>>\n[mcp_servers.\"pickforge-helper\"]\ncommand = \"old\"\nargs = []\n# <<< pickforge <<<\nmodel = \"gpt\"\n";
    assert!(codex_config(Some(crossing_scope), &pack()).is_err());
    let mixed = "title = \"foreign\"\r\n# >>> pickforge >>>\nold = true\n# <<< pickforge <<<\n[other]\r\nx = 1\r\n";
    let mixed_output =
        String::from_utf8(codex_config(Some(mixed), &pack()).unwrap().unwrap()).unwrap();
    assert!(mixed_output.starts_with("title = \"foreign\"\r\n# >>> pickforge >>>"));
    assert!(mixed_output.ends_with("\n[other]\r\nx = 1\r\n"));
}

#[test]
fn flutter_pack_plans_owned_harness_configs_and_deduplicated_workflows_in_order() {
    let (temp, project, env) = fixture();
    let bin = fake_tool(temp.path(), "dart");
    let env = env.with_var("PATH", &bin).with_var("PATHEXT", ".EXE");
    let mut request = InitRequest::new(&project);
    request.pack = IntegrationPack::flutter();

    let before = std::fs::read(project.join("pubspec.yaml")).unwrap();
    let plan = plan_init(&request, &env).unwrap();
    assert_eq!(plan.report.pack.name, "pickforge-flutter");
    assert_eq!(plan.report.actions.len(), 6);
    assert!(plan.report.actions[0].target.ends_with(".claude.json"));
    assert!(plan.report.actions[1].target.ends_with("config.toml"));
    assert!(plan.report.actions[2].target.ends_with("mcp.json"));
    assert!(Path::new(&plan.report.actions[3].target)
        .ends_with(Path::new(".claude/skills/pickforge-flutter/SKILL.md")));
    assert!(Path::new(&plan.report.actions[4].target)
        .ends_with(Path::new(".agents/skills/pickforge-flutter/SKILL.md")));
    assert!(plan.report.actions[5].target.ends_with("project.json"));
    assert!(plan.report.actions[2].warning.is_some());
    assert!(!temp.path().join("home").exists());
    assert_eq!(std::fs::read(project.join("pubspec.yaml")).unwrap(), before);

    assert!(apply_init(&plan, "flutter").changed);
    let asset = include_bytes!("../assets/skills/pickforge-flutter/SKILL.md");
    assert_eq!(
        std::fs::read(
            temp.path()
                .join("home/.claude/skills/pickforge-flutter/SKILL.md")
        )
        .unwrap(),
        asset
    );
    assert_eq!(
        std::fs::read(
            temp.path()
                .join("home/.agents/skills/pickforge-flutter/SKILL.md")
        )
        .unwrap(),
        asset
    );
    let claude: serde_json::Value =
        serde_json::from_slice(&std::fs::read(temp.path().join("home/.claude.json")).unwrap())
            .unwrap();
    assert_eq!(
        claude["mcpServers"]["pickforge-dart"],
        serde_json::json!({"command":"dart","args":["mcp-server"]})
    );
    let pi: serde_json::Value = serde_json::from_slice(
        &std::fs::read(temp.path().join("home/.config/mcp/mcp.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        pi["mcpServers"]["pickforge-dart"]["args"],
        serde_json::json!(["mcp-server", "--force-roots-fallback"])
    );
    let codex = std::fs::read_to_string(temp.path().join("home/.codex/config.toml")).unwrap();
    assert!(codex.contains("args = [\"mcp-server\", \"--force-roots-fallback\"]"));

    let snapshots = plan
        .report
        .actions
        .iter()
        .map(|action| {
            let path = std::path::PathBuf::from(&action.target);
            (
                path.clone(),
                std::fs::read(&path).unwrap(),
                std::fs::metadata(&path).unwrap().modified().unwrap(),
            )
        })
        .collect::<Vec<_>>();
    let second = plan_init(&request, &env).unwrap();
    let outcome = apply_init(&second, "flutter-second");
    assert!(!outcome.changed);
    assert!(outcome.backup_paths.is_empty());
    for (path, bytes, mtime) in snapshots {
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(std::fs::metadata(path).unwrap().modified().unwrap(), mtime);
    }
}

#[test]
fn flutter_pack_requires_dart_only_when_a_harness_is_selected() {
    let (temp, project, env) = fixture();
    let mut request = InitRequest::new(&project);
    request.pack = IntegrationPack::flutter();
    let error = plan_init(&request, &env).unwrap_err().to_string();
    assert!(error.contains("requires dart on PATH"), "{error}");
    assert!(error.contains("pickforge doctor"), "{error}");
    assert!(!temp.path().join("state").exists());
    assert!(!temp.path().join("home").exists());

    request.harnesses.clear();
    let plan = plan_init(&request, &env).unwrap();
    assert_eq!(plan.report.actions.len(), 1);
}

#[test]
fn pack_validation_rejects_invalid_harness_tool_and_workflow_policy() {
    let mut pack = pack();
    pack.mcp_servers[0].harness_args = vec![
        HarnessArgsSpec {
            harness: Harness::Pi,
            extra_args: vec!["one".into()],
        },
        HarnessArgsSpec {
            harness: Harness::Pi,
            extra_args: vec!["two".into()],
        },
    ];
    assert!(matches!(
        pack.validate(),
        Err(AdapterError::DuplicateHarnessPolicy(_))
    ));
    pack.mcp_servers[0].harness_args.truncate(1);
    pack.mcp_servers[0].harness_args[0].extra_args.clear();
    assert!(matches!(
        pack.validate(),
        Err(AdapterError::InvalidHarnessPolicy(_))
    ));

    let mut invalid = IntegrationPack::flutter();
    invalid.required_tools = vec!["".into()];
    assert!(matches!(
        invalid.validate(),
        Err(AdapterError::InvalidRequiredTool(_))
    ));
    let mut invalid = IntegrationPack::flutter();
    invalid.workflows[0].name = "../foreign".into();
    assert!(matches!(
        invalid.validate(),
        Err(AdapterError::InvalidWorkflowName(_))
    ));
    let mut invalid = IntegrationPack::flutter();
    invalid.workflows.push(invalid.workflows[0].clone());
    assert!(matches!(
        invalid.validate(),
        Err(AdapterError::DuplicateWorkflowName(_))
    ));
    let mut invalid = IntegrationPack::flutter();
    invalid.workflows[0].content.clear();
    assert!(matches!(
        invalid.validate(),
        Err(AdapterError::InvalidWorkflowContent(_))
    ));
    for marker in ["", "bad\nmarker", "foreign"] {
        let mut invalid = IntegrationPack::flutter();
        invalid.workflows[0].ownership_marker = marker.into();
        assert!(matches!(
            invalid.validate(),
            Err(AdapterError::InvalidWorkflowOwnership(_))
        ));
    }
    let mut invalid = IntegrationPack::flutter();
    invalid.workflows[0].targets[0].root = WorkflowRoot::SharedAgentSkills;
    assert!(matches!(
        invalid.validate(),
        Err(AdapterError::InvalidWorkflowTarget(_))
    ));
}

#[test]
fn foreign_workflow_is_refused_while_owned_updates_receive_backups() {
    let (temp, project, env) = fixture();
    let bin = fake_tool(temp.path(), "dart");
    let env = env.with_var("PATH", &bin).with_var("PATHEXT", ".EXE");
    let mut request = InitRequest::new(&project);
    request.pack = IntegrationPack::flutter();
    request.harnesses = vec![Harness::Codex];
    let workflow = temp
        .path()
        .join("home/.agents/skills/pickforge-flutter/SKILL.md");
    std::fs::create_dir_all(workflow.parent().unwrap()).unwrap();
    std::fs::write(&workflow, "user-owned\n").unwrap();

    let error = plan_init(&request, &env).unwrap_err().to_string();
    assert!(error.contains("not managed by Pickforge"), "{error}");
    assert_eq!(std::fs::read_to_string(&workflow).unwrap(), "user-owned\n");
    assert!(!temp.path().join("home/.codex/config.toml").exists());
    assert!(!temp.path().join("state").exists());

    let owned = "<!-- pickforge-managed: pickforge-flutter -->\nold\n";
    std::fs::write(&workflow, owned).unwrap();
    let plan = plan_init(&request, &env).unwrap();
    let outcome = apply_init(&plan, "owned-update");
    assert_eq!(outcome.outcome, ApplyState::Success);
    assert!(outcome
        .backup_paths
        .iter()
        .any(|path| path.ends_with("SKILL.md.pickforge-backup-owned-update")));
    assert_eq!(
        std::fs::read(&workflow).unwrap(),
        include_bytes!("../assets/skills/pickforge-flutter/SKILL.md")
    );
}

#[cfg(unix)]
#[test]
fn physically_shared_workflow_roots_are_planned_and_written_once() {
    use std::os::unix::fs::symlink;

    let (temp, project, env) = fixture();
    let bin = fake_tool(temp.path(), "dart");
    let env = env.with_var("PATH", &bin);
    let claude_skills = temp.path().join("home/.claude/skills");
    std::fs::create_dir_all(&claude_skills).unwrap();
    std::fs::create_dir_all(temp.path().join("home/.agents")).unwrap();
    symlink(&claude_skills, temp.path().join("home/.agents/skills")).unwrap();
    let mut request = InitRequest::new(&project);
    request.pack = IntegrationPack::flutter();
    request.harnesses = vec![Harness::ClaudeCode, Harness::Codex];

    let plan = plan_init(&request, &env).unwrap();
    let workflow_actions = plan
        .report
        .actions
        .iter()
        .filter(|action| action.summary.contains("workflow"))
        .count();
    assert_eq!(workflow_actions, 1);
    assert_eq!(
        apply_init(&plan, "shared-root").outcome,
        ApplyState::Success
    );
    assert!(claude_skills.join("pickforge-flutter/SKILL.md").is_file());
}

#[cfg(unix)]
#[test]
fn physically_shared_workflow_targets_with_different_contents_conflict() {
    use std::os::unix::fs::symlink;

    let (temp, project, env) = fixture();
    let first_dir = temp.path().join("home/.claude/skills/pickforge-first");
    std::fs::create_dir_all(&first_dir).unwrap();
    let shared_skills = temp.path().join("home/.agents/skills");
    std::fs::create_dir_all(&shared_skills).unwrap();
    symlink(&first_dir, shared_skills.join("pickforge-second")).unwrap();
    let mut request = InitRequest::new(&project);
    request.harnesses = vec![Harness::ClaudeCode, Harness::Codex];
    request.pack = IntegrationPack {
        name: "fixture".into(),
        version: 1,
        mcp_servers: vec![],
        required_tools: vec![],
        workflows: vec![
            WorkflowSpec {
                name: "pickforge-first".into(),
                content: b"<!-- first-owned -->\nfirst\n".to_vec(),
                ownership_marker: "<!-- first-owned -->".into(),
                targets: vec![WorkflowTargetSpec {
                    harness: Harness::ClaudeCode,
                    root: WorkflowRoot::ClaudeSkills,
                }],
            },
            WorkflowSpec {
                name: "pickforge-second".into(),
                content: b"<!-- second-owned -->\nsecond\n".to_vec(),
                ownership_marker: "<!-- second-owned -->".into(),
                targets: vec![WorkflowTargetSpec {
                    harness: Harness::Codex,
                    root: WorkflowRoot::SharedAgentSkills,
                }],
            },
        ],
    };

    let error = plan_init(&request, &env).unwrap_err().to_string();
    assert!(
        error.contains("workflow targets resolve to") && error.contains("with different contents"),
        "{error}"
    );
    assert!(!first_dir.join("SKILL.md").exists());
    assert!(!temp.path().join("state").exists());
}

#[test]
fn repeated_missing_home_conflicts_are_reported_once() {
    let (temp, project, _) = fixture();
    let bin = fake_tool(temp.path(), "dart");
    let env = Environment::empty()
        .with_var("PATH", &bin)
        .with_var("PATHEXT", ".EXE")
        .with_var("PICKFORGE_HOME", temp.path().join("state"));
    let mut request = InitRequest::new(&project);
    request.pack = IntegrationPack::flutter();

    let error = plan_init(&request, &env).unwrap_err().to_string();
    assert_eq!(
        error.matches("no home directory could be resolved").count(),
        1
    );
    assert!(!temp.path().join("state").exists());
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
fn nonempty_pack_apply_is_byte_and_mtime_stable_on_rerun() {
    let (_temp, project, env) = fixture();
    let mut request = InitRequest::new(project);
    request.pack = pack();
    let first_plan = plan_init(&request, &env).unwrap();
    let first = apply_init(&first_plan, "first");
    assert!(first.changed);
    assert!(first.backup_paths.is_empty());
    let snapshots = first_plan
        .report
        .actions
        .iter()
        .map(|action| {
            let path = std::path::PathBuf::from(&action.target);
            (
                path.clone(),
                std::fs::read(&path).unwrap(),
                std::fs::metadata(&path).unwrap().modified().unwrap(),
            )
        })
        .collect::<Vec<_>>();
    let second_plan = plan_init(&request, &env).unwrap();
    let second = apply_init(&second_plan, "second");
    assert!(!second.changed);
    assert!(second.backup_paths.is_empty());
    for (path, bytes, mtime) in snapshots {
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(std::fs::metadata(path).unwrap().modified().unwrap(), mtime);
    }
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

#[cfg(unix)]
#[test]
fn dangling_state_artifact_symlinks_are_refused_as_foreign_state() {
    use std::os::unix::fs::symlink;

    let (_temp, project, env) = fixture();
    let request = InitRequest::new(&project);
    let initial = plan_init(&request, &env).unwrap();
    let state_dir = Path::new(&initial.report.state_dir);
    std::fs::create_dir_all(state_dir).unwrap();
    symlink("missing", state_dir.join(".pickforge-tmp-dangling")).unwrap();
    let error = plan_init(&request, &env).unwrap_err().to_string();
    assert!(error.contains("non-empty but has no Pickforge project receipt"));
    assert!(!error.contains("could not inspect state artifact"));
}

#[cfg(windows)]
#[test]
#[allow(clippy::permissions_set_readonly_false)]
fn windows_readonly_init_rerun_is_a_noop_without_verbatim_paths() {
    let (_temp, project, env) = fixture();
    let mut request = InitRequest::new(project);
    request.pack = pack();
    request.harnesses = vec![Harness::ClaudeCode];
    let first = plan_init(&request, &env).unwrap();
    assert!(apply_init(&first, "first").changed);
    let config = env.home_dir().unwrap().join(".claude.json");
    let mut permissions = std::fs::metadata(&config).unwrap().permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&config, permissions).unwrap();

    let second = plan_init(&request, &env).unwrap();
    assert!(second
        .report
        .actions
        .iter()
        .all(|action| !action.target.starts_with("\\\\?\\")));
    assert!(!second.report.state_dir.starts_with("\\\\?\\"));
    assert!(second.report.actions.iter().any(|action| {
        action.target.ends_with(".claude.json") && action.action == ActionKind::Unchanged
    }));
    assert!(!apply_init(&second, "second").changed);

    let mut permissions = std::fs::metadata(&config).unwrap().permissions();
    permissions.set_readonly(false);
    std::fs::set_permissions(config, permissions).unwrap();
}

#[test]
fn failed_apply_reports_render_residuals_and_backups_without_controls() {
    let report = ApplyReport {
        schema_version: 1,
        outcome: ApplyState::FailedPartial,
        changed: true,
        backup_paths: vec!["backup\npath".into()],
        rollback_residuals: vec!["residual\tpath".into()],
        error: Some("failed\rreason".into()),
    };
    let text = render::render_init_outcome(&report);
    assert!(text.contains("outcome: failed-partial"), "{text:?}");
    assert!(text.contains("changed: yes"), "{text:?}");
    assert!(text.contains("backup\\npath"), "{text:?}");
    assert!(text.contains("residual\\tpath"), "{text:?}");
    assert!(text.contains("failed\\rreason"), "{text:?}");
}
