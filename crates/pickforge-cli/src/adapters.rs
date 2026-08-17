//! Pure integration-pack policy and harness config transformations.

use std::collections::BTreeSet;
use std::fmt;
use std::path::PathBuf;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
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
pub struct McpServerSpec {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationPack {
    pub name: String,
    pub version: u32,
    pub mcp_servers: Vec<McpServerSpec>,
}

impl IntegrationPack {
    pub fn base() -> Self {
        Self {
            name: "pickforge-base".into(),
            version: 1,
            mcp_servers: Vec::new(),
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
    #[error("{0} must contain a JSON object")]
    JsonObject(&'static str),
    #[error("{0} contains malformed JSON: {1}")]
    MalformedJson(&'static str, String),
    #[error("{0}.mcpServers must be an object")]
    McpServersObject(&'static str),
    #[error("Codex config has unbalanced Pickforge block markers")]
    UnbalancedMarkers,
    #[error(
        "Codex config manages {0} outside the Pickforge block; move or remove that table first"
    )]
    ManagedTableOutsideBlock(String),
}

pub fn json_config(
    existing: Option<&str>,
    pack: &IntegrationPack,
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
            serde_json::json!({"command": server.command, "args": server.args}),
        );
    }
    let mut rendered = serde_json::to_vec_pretty(&root).expect("JSON values serialize");
    rendered.push(b'\n');
    Ok(Some(rendered))
}

const START: &str = "# >>> pickforge >>>";
const END: &str = "# <<< pickforge <<<";

fn toml_key_segments(table: &str) -> Option<Vec<String>> {
    let mut characters = table.chars().peekable();
    let mut segments = Vec::new();
    loop {
        while characters
            .peek()
            .is_some_and(|character| character.is_whitespace())
        {
            characters.next();
        }
        let segment = match characters.peek().copied()? {
            quote @ ('\'' | '"') => {
                characters.next();
                let mut value = String::new();
                loop {
                    match characters.next()? {
                        character if character == quote => break,
                        '\\' if quote == '"' => return None,
                        character => value.push(character),
                    }
                }
                value
            }
            _ => {
                let mut value = String::new();
                while let Some(character) = characters.peek().copied() {
                    if character == '.' || character.is_whitespace() {
                        break;
                    }
                    value.push(character);
                    characters.next();
                }
                value
            }
        };
        if segment.is_empty() {
            return None;
        }
        segments.push(segment);
        while characters
            .peek()
            .is_some_and(|character| character.is_whitespace())
        {
            characters.next();
        }
        match characters.next() {
            Some('.') => continue,
            None => return Some(segments),
            Some(_) => return None,
        }
    }
}

fn managed_table(line: &str, names: &[String]) -> Option<String> {
    let trimmed = line.trim();
    let (inner, rest) = if let Some(table) = trimmed.strip_prefix("[[") {
        let end = table.find("]]")?;
        (&table[..end], &table[end + 2..])
    } else if let Some(table) = trimmed.strip_prefix('[') {
        let end = table.find(']')?;
        (&table[..end], &table[end + 1..])
    } else {
        return None;
    };
    let rest = rest.trim();
    if !rest.is_empty() && !rest.starts_with('#') {
        return None;
    }
    let segments = toml_key_segments(inner)?;
    if segments
        .first()
        .is_some_and(|segment| segment == "mcp_servers")
    {
        if let Some(name) = segments.get(1) {
            if names.iter().any(|managed| managed == name) {
                return Some(name.clone());
            }
        }
    }
    None
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
    for (index, line) in lines.iter().enumerate() {
        if range.is_some_and(|(start, end)| index >= start && index <= end) {
            continue;
        }
        if let Some(name) = managed_table(line, &names) {
            return Err(AdapterError::ManagedTableOutsideBlock(name));
        }
    }
    let mut block = vec![START.to_string()];
    for (index, server) in pack.mcp_servers.iter().enumerate() {
        if index > 0 {
            block.push(String::new());
        }
        block.push(format!("[mcp_servers.{}]", toml_string(&server.name)));
        block.push(format!("command = {}", toml_string(&server.command)));
        block.push(format!(
            "args = [{}]",
            server
                .args
                .iter()
                .map(|arg| toml_string(arg))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    block.push(END.to_string());
    let block = block.join("\n");
    let output = if let Some((start, end)) = range {
        let mut result = Vec::new();
        result.extend_from_slice(&lines[..start]);
        result.push(&block);
        result.extend_from_slice(&lines[end + 1..]);
        result.join("\n")
    } else if normalized.is_empty() {
        format!("{block}\n")
    } else if normalized.ends_with("\n\n") {
        format!("{normalized}{block}\n")
    } else if normalized.ends_with('\n') {
        format!("{normalized}\n{block}\n")
    } else {
        format!("{normalized}\n\n{block}\n")
    };
    Ok(Some(output.replace('\n', newline).into_bytes()))
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
