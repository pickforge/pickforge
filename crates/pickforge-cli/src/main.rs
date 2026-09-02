use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use pickforge_cli::{diagnose, render, Environment};

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
        /// Project directory to diagnose (defaults to the current directory).
        #[arg(long, value_name = "PATH")]
        project_dir: Option<PathBuf>,
        /// Emit the machine-readable report instead of text.
        #[arg(long)]
        json: bool,
    },
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
    }
}
