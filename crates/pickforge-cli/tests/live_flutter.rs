#![cfg(unix)]

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Cursor, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use image::{DynamicImage, ImageBuffer, ImageFormat, Rgb};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

const LIVE_ENV: &str = "PICKFORGE_LIVE_FLUTTER";
const SECRET: &str = "ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII";

#[derive(Debug, PartialEq, Eq)]
enum AuditState {
    Missing,
    File([u8; 32]),
    Symlink(PathBuf),
    Directory {
        modified: std::time::SystemTime,
        entries: Vec<(OsString, bool, bool)>,
    },
}

#[derive(Debug)]
struct Output {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

struct GroupChild {
    child: Child,
}

impl GroupChild {
    fn spawn(command: &mut Command) -> Self {
        command.process_group(0);
        Self {
            child: command.spawn().unwrap(),
        }
    }

    fn terminate(&mut self) {
        let pid = self.child.id() as i32;
        unsafe {
            kill(-pid, 9);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for GroupChild {
    fn drop(&mut self) {
        self.terminate();
    }
}

extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
}

fn isolated(command: &mut Command, home: &Path, state: &Path) {
    command
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("XDG_DATA_HOME", home.join(".local/share"))
        .env("PICKFORGE_HOME", state);
}

fn run(
    mut command: Command,
    input: Option<&[u8]>,
    home: &Path,
    state: &Path,
    test_deadline: Instant,
    timeout: Duration,
) -> Output {
    isolated(&mut command, home, state);
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let display = format!("{command:?}");
    let mut child = GroupChild::spawn(&mut command);
    let mut stdin = child.child.stdin.take();
    let mut stdout = child.child.stdout.take().unwrap();
    let mut stderr = child.child.stderr.take().unwrap();
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).unwrap();
        bytes
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).unwrap();
        bytes
    });
    if let Some(input) = input {
        stdin.as_mut().unwrap().write_all(input).unwrap();
    }
    drop(stdin);

    let deadline = std::cmp::min(test_deadline, Instant::now() + timeout);
    let status = loop {
        if let Some(status) = child.child.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "command timed out: {display}");
        thread::sleep(Duration::from_millis(25));
    };
    child.terminate();
    Output {
        status,
        stdout: stdout_reader.join().unwrap(),
        stderr: stderr_reader.join().unwrap(),
    }
}

fn assert_success(output: &Output, label: &str) {
    assert!(
        output.status.success(),
        "{label} failed with {}\nstdout:\n{}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn pickforge(args: &[&str], project: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_pickforge"));
    command.args(args).arg("--project-dir").arg(project);
    command
}

fn snapshot(root: &Path) -> Vec<(PathBuf, Option<[u8; 32]>)> {
    fn visit(root: &Path, path: &Path, entries: &mut Vec<(PathBuf, Option<[u8; 32]>)>) {
        if !path.exists() {
            return;
        }
        let metadata = std::fs::symlink_metadata(path).unwrap();
        let relative = path.strip_prefix(root).unwrap_or(path).to_path_buf();
        if metadata.file_type().is_symlink() {
            let target = std::fs::read_link(path).unwrap();
            entries.push((relative, Some(hash(target.as_os_str().as_encoded_bytes()))));
        } else if metadata.is_file() {
            entries.push((relative, Some(hash(&std::fs::read(path).unwrap()))));
        } else if metadata.is_dir() {
            entries.push((relative, None));
            let mut children = std::fs::read_dir(path)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect::<Vec<_>>();
            children.sort();
            for child in children {
                visit(root, &child, entries);
            }
        }
    }

    let mut entries = Vec::new();
    visit(root, root, &mut entries);
    entries
}

fn hash(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// A real 1x1 PNG: the evidence recorder decodes artifacts, so hand-written bytes will not do.
fn solid_png() -> Vec<u8> {
    let mut bytes = Vec::new();
    DynamicImage::ImageRgb8(ImageBuffer::from_pixel(1, 1, Rgb([17, 83, 149])))
        .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
        .unwrap();
    bytes
}

fn audit(path: &Path) -> AuditState {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return AuditState::Missing;
    };
    if metadata.file_type().is_symlink() {
        return AuditState::Symlink(std::fs::read_link(path).unwrap());
    }
    if metadata.is_file() {
        return AuditState::File(hash(&std::fs::read(path).unwrap()));
    }
    let mut entries = std::fs::read_dir(path)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            let kind = entry.file_type().unwrap();
            (entry.file_name(), kind.is_dir(), kind.is_symlink())
        })
        .collect::<Vec<_>>();
    entries.sort();
    AuditState::Directory {
        modified: metadata.modified().unwrap(),
        entries,
    }
}

fn hex_hash(bytes: &[u8]) -> String {
    hash(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn pub_cache() -> Option<PathBuf> {
    if let Some(cache) = std::env::var_os("PUB_CACHE") {
        return Some(PathBuf::from(cache));
    }
    let cache = PathBuf::from(std::env::var_os("HOME")?).join(".pub-cache");
    cache.is_dir().then_some(cache)
}

fn create_project(temp: &Path, home: &Path, state: &Path, deadline: Instant) -> PathBuf {
    let app = temp.join("app");
    let mut command = Command::new("flutter");
    command.args([
        "create",
        "--offline",
        "--platforms=linux",
        "--project-name",
        "pickforge_live_e2e",
    ]);
    command.arg(&app);
    // The isolated home moves the pub cache too, so an offline resolve would always miss and
    // this fixture would silently degrade to the minimal fallback. Point pub at the real
    // cache for fixture creation only; the CLI under test never sees it.
    if let Some(cache) = pub_cache() {
        command.env("PUB_CACHE", cache);
    }
    let output = run(
        command,
        None,
        home,
        state,
        deadline,
        Duration::from_secs(120),
    );
    if output.status.success() {
        eprintln!("live Flutter fixture: flutter create --offline");
        return app;
    }

    eprintln!(
        "live Flutter fixture: minimal fallback (flutter create failed: {})",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    if app.exists() {
        std::fs::remove_dir_all(&app).unwrap();
    }
    std::fs::create_dir_all(app.join("lib")).unwrap();
    std::fs::write(
        app.join("pubspec.yaml"),
        "name: pickforge_live_e2e\nenvironment:\n  sdk: ^3.0.0\ndependencies:\n  flutter:\n    sdk: flutter\n",
    )
    .unwrap();
    std::fs::write(
        app.join("lib/main.dart"),
        "import 'package:flutter/widgets.dart';\nvoid main() => runApp(const SizedBox());\n",
    )
    .unwrap();
    app
}

fn receive_response(receiver: &Receiver<String>, id: i64, deadline: Instant) -> serde_json::Value {
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .expect("MCP response timed out");
        let line = receiver
            .recv_timeout(remaining)
            .unwrap_or_else(|error| panic!("MCP response {id} failed: {error}"));
        let value: serde_json::Value = serde_json::from_str(&line)
            .unwrap_or_else(|error| panic!("invalid MCP JSON ({error}): {line}"));
        if value["id"] == id {
            assert!(value.get("error").is_none(), "MCP error response: {value}");
            return value;
        }
    }
}

fn mcp_handshake(
    command_name: &str,
    args: &[String],
    project: &Path,
    home: &Path,
    state: &Path,
    test_deadline: Instant,
) {
    let mut command = Command::new(command_name);
    command.args(args).current_dir(project);
    isolated(&mut command, home, state);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = GroupChild::spawn(&mut command);
    let mut stdin = child.child.stdin.take().unwrap();
    let stdout = child.child.stdout.take().unwrap();
    let mut stderr = child.child.stderr.take().unwrap();
    let (sender, receiver) = mpsc::channel();
    let stdout_reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if sender.send(line.unwrap()).is_err() {
                break;
            }
        }
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).unwrap();
        bytes
    });
    let deadline = std::cmp::min(test_deadline, Instant::now() + Duration::from_secs(60));
    let initialize = serde_json::json!({
        "jsonrpc":"2.0",
        "id":1,
        "method":"initialize",
        "params":{
            "protocolVersion":"2025-03-26",
            "capabilities":{"roots":{"listChanged":false}},
            "clientInfo":{"name":"pickforge-live-test","version":"1"}
        }
    });
    writeln!(stdin, "{initialize}").unwrap();
    stdin.flush().unwrap();
    let initialized = receive_response(&receiver, 1, deadline);
    assert!(
        initialized["result"]["serverInfo"]["name"]
            .as_str()
            .is_some_and(|name| !name.is_empty()),
        "missing MCP server name: {initialized}"
    );
    writeln!(
        stdin,
        "{}",
        serde_json::json!({"jsonrpc":"2.0","method":"notifications/initialized"})
    )
    .unwrap();
    writeln!(
        stdin,
        "{}",
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}})
    )
    .unwrap();
    stdin.flush().unwrap();
    let tools = receive_response(&receiver, 2, deadline);
    assert!(
        tools["result"]["tools"]
            .as_array()
            .is_some_and(|tools| !tools.is_empty()),
        "MCP returned no tools: {tools}"
    );
    drop(stdin);
    child.terminate();
    stdout_reader.join().unwrap();
    let stderr = stderr_reader.join().unwrap();
    assert!(
        !stderr
            .windows(SECRET.len())
            .any(|bytes| bytes == SECRET.as_bytes()),
        "secret leaked to MCP stderr"
    );
}

#[test]
fn live_flutter_cli_and_mcp_end_to_end() {
    if std::env::var(LIVE_ENV).as_deref() != Ok("1") {
        eprintln!("skipping live Flutter end-to-end test; set {LIVE_ENV}=1 to run it");
        return;
    }
    for tool in ["flutter", "dart"] {
        if which::which(tool).is_err() {
            eprintln!("skipping live Flutter end-to-end test; {tool} is not on PATH");
            return;
        }
    }

    let started = Instant::now();
    let test_deadline = started + Duration::from_secs(295);
    let real_home = std::env::var_os("HOME").map(PathBuf::from);
    let mut real_audit = real_home.as_ref().map(|real_home| {
        let paths = vec![
            real_home.join(".pickforge"),
            real_home.join(".claude"),
            real_home.join(".codex"),
            real_home.join(".pi"),
            real_home.join(".claude.json"),
            real_home.join(".claude/skills/pickforge-flutter/SKILL.md"),
            real_home.join(".codex/config.toml"),
            real_home.join(".agents/skills/pickforge-flutter/SKILL.md"),
            real_home.join(".config/mcp/mcp.json"),
        ];
        let states = paths.iter().map(|path| audit(path)).collect::<Vec<_>>();
        (paths, states)
    });
    let temp = TempDir::new().unwrap();
    let home = temp.path().join("home");
    let state = temp.path().join("pickforge-state");
    std::fs::create_dir_all(&home).unwrap();
    let project = create_project(temp.path(), &home, &state, test_deadline);
    if let (Some(real_home), Some((paths, states))) = (&real_home, &mut real_audit) {
        let project_id = pickforge_cli::project::derive_project_id(
            &pickforge_cli::project::canonical_project_path(&project),
        )
        .unwrap();
        let real_project_state = real_home
            .join(".pickforge/pickforge/projects")
            .join(project_id);
        states.push(audit(&real_project_state));
        paths.push(real_project_state);
    }

    let doctor = run(
        pickforge(&["doctor", "--json"], &project),
        None,
        &home,
        &state,
        test_deadline,
        Duration::from_secs(30),
    );
    assert_success(&doctor, "doctor");
    let doctor: serde_json::Value = serde_json::from_slice(&doctor.stdout).unwrap();
    assert_eq!(doctor["ready"], true, "{doctor}");
    assert_eq!(doctor["project"]["framework"], "flutter");
    let reported_state = Path::new(doctor["project"]["stateDir"].as_str().unwrap());
    assert!(reported_state.starts_with(&state), "{reported_state:?}");

    let init_args = [
        "init",
        "--harness",
        "claude-code",
        "--harness",
        "codex",
        "--harness",
        "pi",
        "--json",
    ];
    let home_before_dry_run = snapshot(&home);
    let state_before_dry_run = snapshot(&state);
    let mut dry_run_args = init_args.to_vec();
    dry_run_args.push("--dry-run");
    let dry_run = run(
        pickforge(&dry_run_args, &project),
        None,
        &home,
        &state,
        test_deadline,
        Duration::from_secs(30),
    );
    assert_success(&dry_run, "init dry-run");
    let dry_run: serde_json::Value = serde_json::from_slice(&dry_run.stdout).unwrap();
    let targets = dry_run["plan"]["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|action| action["target"].as_str().unwrap())
        .collect::<Vec<_>>();
    for expected in [".claude.json", ".codex/config.toml", ".config/mcp/mcp.json"] {
        assert!(
            targets.iter().any(|target| target.ends_with(expected)),
            "{targets:?}"
        );
    }
    assert_eq!(dry_run["plan"]["pack"]["name"], "pickforge-flutter");
    assert!(targets
        .iter()
        .any(|target| target.ends_with(".claude/skills/pickforge-flutter/SKILL.md")));
    assert!(targets
        .iter()
        .any(|target| target.ends_with(".agents/skills/pickforge-flutter/SKILL.md")));
    assert_eq!(snapshot(&home), home_before_dry_run);
    assert_eq!(snapshot(&state), state_before_dry_run);

    let apply = run(
        pickforge(&init_args, &project),
        None,
        &home,
        &state,
        test_deadline,
        Duration::from_secs(30),
    );
    assert_success(&apply, "init apply");
    let apply: serde_json::Value = serde_json::from_slice(&apply.stdout).unwrap();
    assert_eq!(apply["outcome"]["changed"], true);

    let claude_path = home.join(".claude.json");
    let codex_path = home.join(".codex/config.toml");
    let pi_path = home.join(".config/mcp/mcp.json");
    let claude: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&claude_path).unwrap()).unwrap();
    let pi: serde_json::Value = serde_json::from_slice(&std::fs::read(&pi_path).unwrap()).unwrap();
    let codex: toml::Table = std::fs::read_to_string(&codex_path)
        .unwrap()
        .parse()
        .unwrap();
    let claude_server = &claude["mcpServers"]["pickforge-dart"];
    let pi_server = &pi["mcpServers"]["pickforge-dart"];
    let codex_server = &codex["mcp_servers"]["pickforge-dart"];
    for server in [claude_server, pi_server] {
        assert_eq!(server["command"], "dart");
        assert_eq!(server["args"][0], "mcp-server");
    }
    assert_eq!(codex_server["command"].as_str(), Some("dart"));
    assert_eq!(codex_server["args"][0].as_str(), Some("mcp-server"));
    assert_eq!(pi_server["args"][1], "--force-roots-fallback");
    assert_eq!(
        codex_server["args"][1].as_str(),
        Some("--force-roots-fallback")
    );
    for skill in [
        home.join(".claude/skills/pickforge-flutter/SKILL.md"),
        home.join(".agents/skills/pickforge-flutter/SKILL.md"),
    ] {
        let contents = std::fs::read_to_string(skill).unwrap();
        assert!(contents.contains("<!-- pickforge-managed: pickforge-flutter -->"));
    }

    let written_hashes = apply["plan"]["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|action| {
            let path = PathBuf::from(action["target"].as_str().unwrap());
            assert!(path.is_file(), "missing applied file: {path:?}");
            (path.clone(), hash(&std::fs::read(path).unwrap()))
        })
        .collect::<BTreeMap<_, _>>();

    let mcp_command = claude_server["command"].as_str().unwrap();
    let mcp_args = claude_server["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(|arg| arg.as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    mcp_handshake(
        mcp_command,
        &mcp_args,
        &project,
        &home,
        &state,
        test_deadline,
    );

    let second_apply = run(
        pickforge(&init_args, &project),
        None,
        &home,
        &state,
        test_deadline,
        Duration::from_secs(30),
    );
    assert_success(&second_apply, "second init apply");
    let second_apply: serde_json::Value = serde_json::from_slice(&second_apply.stdout).unwrap();
    assert_eq!(second_apply["outcome"]["changed"], false, "{second_apply}");
    for (path, expected_hash) in &written_hashes {
        assert_eq!(
            &hash(&std::fs::read(path).unwrap()),
            expected_hash,
            "{path:?}"
        );
    }

    let screenshot = temp.path().join("source.png");
    let screenshot_bytes = solid_png();
    std::fs::write(&screenshot, &screenshot_bytes).unwrap();
    let project_before_evidence = snapshot(&project);
    let evidence = serde_json::to_vec(&serde_json::json!({
        "schemaVersion":1,
        "scenario":"Live Flutter MCP",
        "outcome":"passed",
        "before":{"summary":format!("Before token: {SECRET}"),"observations":[],"artifacts":[{"kind":"screenshot","label":"Before","source":screenshot}]},
        "after":{"summary":"MCP tools were listed.","observations":[],"artifacts":[]},
        "sourceChanges":[],
        "checks":[{"name":"MCP handshake","status":"passed","summary":"Server initialized and listed tools."}],
        "limitations":[]
    }))
    .unwrap();
    let recorded = run(
        pickforge(&["evidence", "record", "--json"], &project),
        Some(&evidence),
        &home,
        &state,
        test_deadline,
        Duration::from_secs(30),
    );
    assert_success(&recorded, "evidence record");
    let recorded: serde_json::Value = serde_json::from_slice(&recorded.stdout).unwrap();
    let evidence_path = PathBuf::from(recorded["evidencePath"].as_str().unwrap());
    let report_path = PathBuf::from(recorded["reportPath"].as_str().unwrap());
    for path in [&evidence_path, &report_path] {
        assert!(path.is_file(), "missing evidence output: {path:?}");
        assert!(
            path.starts_with(&state),
            "evidence escaped PICKFORGE_HOME: {path:?}"
        );
        assert!(
            !path.starts_with(&project),
            "evidence entered project: {path:?}"
        );
    }
    assert_eq!(snapshot(&project), project_before_evidence);
    let evidence_bytes = std::fs::read(&evidence_path).unwrap();
    let report_bytes = std::fs::read(&report_path).unwrap();
    assert!(!evidence_bytes
        .windows(SECRET.len())
        .any(|bytes| bytes == SECRET.as_bytes()));
    assert!(!report_bytes
        .windows(SECRET.len())
        .any(|bytes| bytes == SECRET.as_bytes()));
    let evidence_document: serde_json::Value = serde_json::from_slice(&evidence_bytes).unwrap();
    let copied_relative = evidence_document["before"]["artifacts"][0]["path"]
        .as_str()
        .unwrap();
    let copied = evidence_path.parent().unwrap().join(copied_relative);
    let source_hash = hash(&screenshot_bytes);
    assert_eq!(hash(&std::fs::read(&copied).unwrap()), source_hash);
    assert_eq!(
        evidence_document["before"]["artifacts"][0]["sha256"],
        hex_hash(&screenshot_bytes)
    );

    if let Some((paths, before)) = real_audit {
        for (path, expected) in paths.iter().zip(before) {
            assert_eq!(audit(path), expected, "real path changed: {path:?}");
        }
    }
    assert!(started.elapsed() < Duration::from_secs(300));
}
