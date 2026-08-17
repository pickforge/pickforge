//! Pure integration-pack policy and harness config transformations.

use std::collections::BTreeSet;
use std::fmt;
use std::path::PathBuf;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Harness {
    ClaudeCode,
    Codex,
    Pi,
}

impl Harness {
    pub const ALL: [Self; 3] = [Self::ClaudeCode, Self::Codex, Self::Pi];
}

impl fmt::Display for Harness {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
            Self::Pi => "pi",
        })
    }
}

impl FromStr for Harness {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "claude-code" => Ok(Self::ClaudeCode),
            "codex" => Ok(Self::Codex),
            "pi" => Ok(Self::Pi),
            _ => Err(format!("unknown harness {value:?}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessArgsSpec {
    pub harness: Harness,
    pub extra_args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerSpec {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub harness_args: Vec<HarnessArgsSpec>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkflowRoot {
    ClaudeSkills,
    SharedAgentSkills,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowTargetSpec {
    pub harness: Harness,
    pub root: WorkflowRoot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSpec {
    pub name: String,
    pub content: Vec<u8>,
    pub targets: Vec<WorkflowTargetSpec>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationPack {
    pub name: String,
    pub version: u32,
    pub mcp_servers: Vec<McpServerSpec>,
    pub required_tools: Vec<String>,
    pub workflows: Vec<WorkflowSpec>,
}

impl IntegrationPack {
    pub fn base() -> Self {
        Self {
            name: "pickforge-base".into(),
            version: 1,
            mcp_servers: Vec::new(),
            required_tools: Vec::new(),
            workflows: Vec::new(),
        }
    }

    pub fn flutter() -> Self {
        Self {
            name: "pickforge-flutter".into(),
            version: 1,
            mcp_servers: vec![McpServerSpec {
                name: "pickforge-dart".into(),
                command: "dart".into(),
                args: vec!["mcp-server".into()],
                harness_args: vec![
                    HarnessArgsSpec {
                        harness: Harness::Codex,
                        extra_args: vec!["--force-roots-fallback".into()],
                    },
                    HarnessArgsSpec {
                        harness: Harness::Pi,
                        extra_args: vec!["--force-roots-fallback".into()],
                    },
                ],
            }],
            required_tools: vec!["dart".into()],
            workflows: vec![WorkflowSpec {
                name: "pickforge-flutter".into(),
                content: include_bytes!("../assets/skills/pickforge-flutter/SKILL.md").to_vec(),
                targets: vec![
                    WorkflowTargetSpec {
                        harness: Harness::ClaudeCode,
                        root: WorkflowRoot::ClaudeSkills,
                    },
                    WorkflowTargetSpec {
                        harness: Harness::Codex,
                        root: WorkflowRoot::SharedAgentSkills,
                    },
                    WorkflowTargetSpec {
                        harness: Harness::Pi,
                        root: WorkflowRoot::SharedAgentSkills,
                    },
                ],
            }],
        }
    }

    pub fn validate(&self) -> Result<(), AdapterError> {
        let mut names = BTreeSet::new();
        for server in &self.mcp_servers {
            if !server.name.starts_with("pickforge-")
                || !server
                    .name
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || "-_".contains(character))
            {
                return Err(AdapterError::InvalidServerName(server.name.clone()));
            }
            if !names.insert(&server.name) {
                return Err(AdapterError::DuplicateServerName(server.name.clone()));
            }
            if server.command.is_empty() {
                return Err(AdapterError::EmptyServerCommand(server.name.clone()));
            }
            if std::iter::once(&server.command)
                .chain(&server.args)
                .chain(
                    server
                        .harness_args
                        .iter()
                        .flat_map(|policy| policy.extra_args.iter()),
                )
                .any(|value| value.chars().any(char::is_control))
            {
                return Err(AdapterError::ControlCharacter(server.name.clone()));
            }
            let mut harnesses = BTreeSet::new();
            for policy in &server.harness_args {
                if !harnesses.insert(policy.harness) {
                    return Err(AdapterError::DuplicateHarnessPolicy(server.name.clone()));
                }
                if policy.extra_args.is_empty() {
                    return Err(AdapterError::InvalidHarnessPolicy(server.name.clone()));
                }
            }
        }
        let mut tools = BTreeSet::new();
        for tool in &self.required_tools {
            if tool.is_empty() || tool.chars().any(char::is_control) || !tools.insert(tool) {
                return Err(AdapterError::InvalidRequiredTool(tool.clone()));
            }
        }
        let mut workflows = BTreeSet::new();
        for workflow in &self.workflows {
            if !workflow.name.starts_with("pickforge-")
                || !workflow
                    .name
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '-')
            {
                return Err(AdapterError::InvalidWorkflowName(workflow.name.clone()));
            }
            if !workflows.insert(&workflow.name) {
                return Err(AdapterError::DuplicateWorkflowName(workflow.name.clone()));
            }
            if workflow.content.is_empty() || std::str::from_utf8(&workflow.content).is_err() {
                return Err(AdapterError::InvalidWorkflowContent(workflow.name.clone()));
            }
            let mut harnesses = BTreeSet::new();
            for target in &workflow.targets {
                if !harnesses.insert(target.harness)
                    || matches!(target.harness, Harness::ClaudeCode)
                        != matches!(target.root, WorkflowRoot::ClaudeSkills)
                {
                    return Err(AdapterError::InvalidWorkflowTarget(workflow.name.clone()));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum AdapterError {
    #[error("MCP server name must begin with 'pickforge-' and contain only ASCII letters, digits, '-' or '_': {0}")]
    InvalidServerName(String),
    #[error("MCP server name is duplicated: {0}")]
    DuplicateServerName(String),
    #[error("MCP server command must not be empty: {0}")]
    EmptyServerCommand(String),
    #[error("MCP server command and arguments must not contain control characters: {0}")]
    ControlCharacter(String),
    #[error("MCP server has duplicate per-harness argument policy: {0}")]
    DuplicateHarnessPolicy(String),
    #[error("MCP server per-harness argument policy must add at least one argument: {0}")]
    InvalidHarnessPolicy(String),
    #[error("required tool must be nonempty, unique, and contain no control characters: {0}")]
    InvalidRequiredTool(String),
    #[error("workflow name must begin with 'pickforge-' and contain only ASCII letters, digits, or '-': {0}")]
    InvalidWorkflowName(String),
    #[error("workflow name is duplicated: {0}")]
    DuplicateWorkflowName(String),
    #[error("workflow content must be nonempty UTF-8: {0}")]
    InvalidWorkflowContent(String),
    #[error("workflow has a duplicate or incompatible harness target: {0}")]
    InvalidWorkflowTarget(String),
    #[error("{0} must contain a JSON object")]
    JsonObject(&'static str),
    #[error("{0} contains malformed JSON: {1}")]
    MalformedJson(&'static str, String),
    #[error("{0}.mcpServers must be an object")]
    McpServersObject(&'static str),
    #[error("Codex config has unbalanced Pickforge block markers")]
    UnbalancedMarkers,
    #[error("Codex config contains malformed TOML outside the Pickforge block: {0}")]
    MalformedToml(String),
    #[error("Codex config is incompatible with the generated Pickforge block: {0}")]
    GeneratedToml(String),
    #[error("Codex config mcp_servers value must be a table")]
    McpServersTomlTable,
    #[error("Codex config has values whose TOML scope crosses the Pickforge block markers")]
    MarkerScope,
    #[error(
        "Codex config manages {0} outside the Pickforge block; move or remove that entry first"
    )]
    ManagedTableOutsideBlock(String),
}

fn server_args(server: &McpServerSpec, harness: Harness) -> Vec<String> {
    let mut args = server.args.clone();
    if let Some(policy) = server
        .harness_args
        .iter()
        .find(|policy| policy.harness == harness)
    {
        args.extend(policy.extra_args.clone());
    }
    args
}

pub fn json_config(
    existing: Option<&str>,
    pack: &IntegrationPack,
    harness: Harness,
    label: &'static str,
) -> Result<Option<Vec<u8>>, AdapterError> {
    pack.validate()?;
    if pack.mcp_servers.is_empty() {
        return Ok(None);
    }
    let mut root = match existing {
        Some(raw) => serde_json::from_str::<serde_json::Value>(raw)
            .map_err(|error| AdapterError::MalformedJson(label, error.to_string()))?,
        None => serde_json::json!({}),
    };
    let object = root
        .as_object_mut()
        .ok_or(AdapterError::JsonObject(label))?;
    if !object.contains_key("mcpServers") {
        object.insert("mcpServers".into(), serde_json::json!({}));
    }
    let servers = object
        .get_mut("mcpServers")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or(AdapterError::McpServersObject(label))?;
    for server in &pack.mcp_servers {
        servers.insert(
            server.name.clone(),
            serde_json::json!({"command": server.command, "args": server_args(server, harness)}),
        );
    }
    let mut rendered = serde_json::to_vec_pretty(&root).expect("JSON values serialize");
    rendered.push(b'\n');
    Ok(Some(rendered))
}

const START: &str = "# >>> pickforge >>>";
const END: &str = "# <<< pickforge <<<";

fn without_managed_servers(
    mut table: toml::Table,
    names: &[String],
    keep_empty_servers: bool,
) -> toml::Table {
    let remove_servers = if let Some(toml::Value::Table(servers)) = table.get_mut("mcp_servers") {
        for name in names {
            servers.remove(name);
        }
        servers.is_empty() && !keep_empty_servers
    } else {
        false
    };
    if remove_servers {
        table.remove("mcp_servers");
    }
    table
}

fn validate_codex_outside_block(
    lines: &[&str],
    range: Option<(usize, usize)>,
    names: &[String],
) -> Result<toml::Table, AdapterError> {
    let outside = lines
        .iter()
        .enumerate()
        .filter(|(index, _)| !range.is_some_and(|(start, end)| *index >= start && *index <= end))
        .map(|(_, line)| *line)
        .collect::<Vec<_>>()
        .join("\n");
    let outside = outside
        .parse::<toml::Table>()
        .map_err(|error| AdapterError::MalformedToml(error.to_string()))?;
    if let Some(servers) = outside.get("mcp_servers") {
        let servers = servers
            .as_table()
            .ok_or(AdapterError::McpServersTomlTable)?;
        if let Some(name) = names.iter().find(|name| servers.contains_key(*name)) {
            return Err(AdapterError::ManagedTableOutsideBlock(name.clone()));
        }
    }
    if let Some((_, end)) = range {
        let first_value_after_block = lines[end + 1..]
            .iter()
            .map(|line| line.trim())
            .find(|line| !line.is_empty() && !line.starts_with('#'));
        if first_value_after_block.is_some_and(|line| !line.starts_with('[')) {
            return Err(AdapterError::MarkerScope);
        }
    }
    Ok(outside)
}

fn toml_string(value: &str) -> String {
    serde_json::to_string(value).expect("strings serialize")
}

pub fn codex_config(
    existing: Option<&str>,
    pack: &IntegrationPack,
) -> Result<Option<Vec<u8>>, AdapterError> {
    pack.validate()?;
    if pack.mcp_servers.is_empty() {
        return Ok(None);
    }
    let raw = existing.unwrap_or("");
    let crlf_count = raw.matches("\r\n").count();
    let lf_count = raw.matches('\n').count().saturating_sub(crlf_count);
    let newline = if crlf_count > lf_count { "\r\n" } else { "\n" };
    let normalized = raw.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let raw_lines: Vec<&str> = raw.split_inclusive('\n').collect();
    let starts: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter_map(|(i, line)| (*line == START).then_some(i))
        .collect();
    let ends: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter_map(|(i, line)| (*line == END).then_some(i))
        .collect();
    if starts.len() > 1
        || ends.len() > 1
        || starts.len() != ends.len()
        || starts
            .first()
            .zip(ends.first())
            .is_some_and(|(a, b)| a >= b)
    {
        return Err(AdapterError::UnbalancedMarkers);
    }
    let range = starts.first().zip(ends.first()).map(|(a, b)| (*a, *b));
    let names: Vec<String> = pack.mcp_servers.iter().map(|s| s.name.clone()).collect();
    let outside = validate_codex_outside_block(&lines, range, &names)?;
    let mut block = vec![START.to_string()];
    for (index, server) in pack.mcp_servers.iter().enumerate() {
        if index > 0 {
            block.push(String::new());
        }
        block.push(format!("[mcp_servers.{}]", toml_string(&server.name)));
        block.push(format!("command = {}", toml_string(&server.command)));
        block.push(format!(
            "args = [{}]",
            server_args(server, Harness::Codex)
                .iter()
                .map(|arg| toml_string(arg))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    block.push(END.to_string());
    let block = block.join(newline);
    let output = if let Some((start, end)) = range {
        let mut output = String::new();
        for line in &raw_lines[..start] {
            output.push_str(line);
        }
        output.push_str(&block);
        if raw_lines.get(end).is_some_and(|line| line.ends_with('\n')) || end + 1 < raw_lines.len()
        {
            output.push_str(newline);
        }
        for line in &raw_lines[end + 1..] {
            output.push_str(line);
        }
        output
    } else if raw.is_empty() {
        format!("{block}{newline}")
    } else if normalized.ends_with("\n\n") {
        format!("{raw}{block}{newline}")
    } else if normalized.ends_with('\n') {
        format!("{raw}{newline}{block}{newline}")
    } else {
        format!("{raw}{newline}{newline}{block}{newline}")
    };
    let complete = output
        .parse::<toml::Table>()
        .map_err(|error| AdapterError::GeneratedToml(error.to_string()))?;
    if without_managed_servers(complete, &names, outside.contains_key("mcp_servers")) != outside {
        return Err(AdapterError::MarkerScope);
    }
    Ok(Some(output.into_bytes()))
}

pub(crate) fn workflow_target(
    root: WorkflowRoot,
    name: &str,
    env: &crate::Environment,
) -> Result<PathBuf, String> {
    let home = env
        .home_dir()
        .ok_or_else(|| "no home directory could be resolved".to_string())?;
    let skills = match root {
        WorkflowRoot::ClaudeSkills => home.join(".claude").join("skills"),
        WorkflowRoot::SharedAgentSkills => home.join(".agents").join("skills"),
    };
    Ok(skills.join(name).join("SKILL.md"))
}

pub(crate) fn target_for(harness: Harness, env: &crate::Environment) -> Result<PathBuf, String> {
    let home = || {
        env.home_dir()
            .ok_or_else(|| "no home directory could be resolved".to_string())
    };
    Ok(match harness {
        Harness::ClaudeCode => home()?.join(".claude.json"),
        Harness::Pi => home()?.join(".config").join("mcp").join("mcp.json"),
        Harness::Codex => match env.var("CODEX_HOME") {
            Some(value) if !value.is_empty() => {
                let path = PathBuf::from(value);
                if !path.is_absolute() {
                    return Err(format!(
                        "CODEX_HOME must be an absolute path, got {:?}",
                        path
                    ));
                }
                path.join("config.toml")
            }
            _ => home()?.join(".codex").join("config.toml"),
        },
    })
}
