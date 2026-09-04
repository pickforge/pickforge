use std::fs::File;
use std::io;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use clap::{Parser, Subcommand};
use pickforge_cli::adapters::Harness;
use pickforge_cli::evidence::EVIDENCE_SCHEMA_VERSION;
use pickforge_cli::init::{ApplyState, InitRequest};
use pickforge_cli::{apply_init, diagnose, plan_init, render, Environment};
use serde::Serialize;

#[derive(Parser)]
#[command(
    name = "pickforge",
    about = "Experimental Pickforge CLI",
    version,
    disable_help_subcommand = true
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Diagnose whether a project is ready for Pickforge (read-only).
    Doctor {
        #[arg(long, value_name = "PATH")]
        project_dir: Option<PathBuf>,
        #[arg(long)]
        json: bool,
    },
    /// Record one completed Flutter evidence run.
    Evidence {
        #[command(subcommand)]
        command: EvidenceCommand,
    },
    /// Plan or apply the Flutter integration for the selected harnesses.
    Init {
        #[arg(long, value_name = "PATH")]
        project_dir: Option<PathBuf>,
        #[arg(long, value_name = "HARNESS", value_parser = ["claude-code", "codex", "pi"])]
        harness: Vec<String>,
        #[arg(long)]
        dry_run: bool,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum EvidenceCommand {
    /// Validate and record a complete evidence document.
    Record {
        #[arg(long, value_name = "PATH")]
        project_dir: Option<PathBuf>,
        #[arg(long, value_name = "PATH", default_value = "-")]
        input: String,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InitOutput<'a> {
    plan: &'a pickforge_cli::InitPlanReport,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<&'a pickforge_cli::ApplyReport>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorOutput<'a> {
    schema_version: u32,
    error: &'a str,
}

fn json_line<T: Serialize>(value: &T) -> String {
    let mut output = serde_json::to_string_pretty(value).expect("CLI reports serialize");
    output.push('\n');
    output
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Command::Doctor { project_dir, json } => {
            let project_dir = project_dir
                .or_else(|| std::env::current_dir().ok())
                .unwrap_or_else(|| PathBuf::from("."));
            let report = diagnose(&project_dir, &Environment::from_process());
            print!(
                "{}",
                if json {
                    render::render_json(&report)
                } else {
                    render::render_text(&report)
                }
            );
            if report.ready {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Command::Evidence { command } => match command {
            EvidenceCommand::Record {
                project_dir,
                input,
                json,
            } => {
                let project_dir = project_dir
                    .or_else(|| std::env::current_dir().ok())
                    .unwrap_or_else(|| PathBuf::from("."));
                let bytes = if input == "-" {
                    pickforge_cli::evidence::read_bounded(io::stdin().lock())
                } else {
                    File::open(&input)
                        .map_err(|error| {
                            pickforge_cli::EvidenceError::Io(format!(
                                "could not read evidence input file {input}: {error}; verify or fix `--input`"
                            ))
                        })
                        .and_then(|file| {
                            pickforge_cli::evidence::read_bounded(file).map_err(|error| {
                                pickforge_cli::EvidenceError::Io(format!(
                                    "could not read evidence input file {input}: {error}; verify or fix `--input`"
                                ))
                            })
                        })
                };
                let outcome = bytes.and_then(|bytes| {
                    pickforge_cli::record(&project_dir, &Environment::from_process(), &bytes)
                });
                match outcome {
                    Ok(result) => {
                        if json {
                            print!("{}", json_line(&result));
                        } else {
                            println!("recorded Flutter evidence run {}", result.run_id);
                            println!("evidence: {}", render::terminal_safe(&result.evidence_path));
                            println!("report: {}", render::terminal_safe(&result.report_path));
                        }
                        ExitCode::SUCCESS
                    }
                    Err(error) => {
                        let message = error.to_string();
                        if json {
                            print!(
                                "{}",
                                json_line(&ErrorOutput {
                                    schema_version: EVIDENCE_SCHEMA_VERSION,
                                    error: &message
                                })
                            );
                        } else {
                            eprintln!(
                                "pickforge evidence record failed: {}",
                                render::terminal_safe(&message)
                            );
                        }
                        ExitCode::FAILURE
                    }
                }
            }
        },
        Command::Init {
            project_dir,
            harness,
            dry_run,
            json,
        } => {
            let project_dir = project_dir
                .or_else(|| std::env::current_dir().ok())
                .unwrap_or_else(|| PathBuf::from("."));
            let mut request = InitRequest::new(project_dir);
            if !harness.is_empty() {
                request.harnesses = harness
                    .iter()
                    .map(|value| value.parse::<Harness>().expect("clap validated harness"))
                    .collect();
            }
            let plan = match plan_init(&request, &Environment::from_process()) {
                Ok(plan) => plan,
                Err(error) => {
                    let message = error.to_string();
                    if json {
                        print!(
                            "{}",
                            json_line(&ErrorOutput {
                                schema_version: 1,
                                error: &message
                            })
                        );
                    } else {
                        println!("pickforge init failed: {}", render::terminal_safe(&message));
                    }
                    return ExitCode::FAILURE;
                }
            };
            if dry_run {
                if json {
                    print!(
                        "{}",
                        json_line(&InitOutput {
                            plan: &plan.report,
                            outcome: None
                        })
                    );
                } else {
                    println!(
                        "{}dry run: no files written",
                        render::render_init_plan(&plan.report)
                    );
                }
                return ExitCode::SUCCESS;
            }
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
                .to_string();
            let outcome = apply_init(&plan, &stamp);
            if json {
                print!(
                    "{}",
                    json_line(&InitOutput {
                        plan: &plan.report,
                        outcome: Some(&outcome)
                    })
                );
            } else {
                print!(
                    "{}{}",
                    render::render_init_plan(&plan.report),
                    render::render_init_outcome(&outcome)
                );
            }
            if matches!(outcome.outcome, ApplyState::Success | ApplyState::NoOp) {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
    }
}
