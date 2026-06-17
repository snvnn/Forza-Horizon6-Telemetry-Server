#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use std::{env, process::ExitCode};

use forza_telemetry_server::{app, native_gui};

fn main() -> ExitCode {
    if should_run_server_mode() {
        return match run_server_mode() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("sim telemetry server failed: {error}");
                ExitCode::from(1)
            }
        };
    }

    #[cfg(target_os = "windows")]
    {
        return ExitCode::from(native_gui::run() as u8);
    }

    #[cfg(not(target_os = "windows"))]
    {
        match run_server_mode() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("sim telemetry server failed: {error}");
                ExitCode::from(1)
            }
        }
    }
}

fn should_run_server_mode() -> bool {
    if !cfg!(target_os = "windows") {
        return true;
    }

    env::args().skip(1).any(|arg| {
        matches!(
            arg.as_str(),
            "--server" | "--open-dashboard" | "--open-settings" | "--help" | "-h"
        )
    })
}

fn run_server_mode() -> std::io::Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    runtime.block_on(app::run(app::parse_launch_options()))
}
