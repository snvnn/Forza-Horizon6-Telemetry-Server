#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use forza_telemetry_server::{app, http::create_http_server::HttpLaunchOptions};

#[tokio::main]
async fn main() -> std::io::Result<()> {
    // Windows GUI mode keeps the Settings UI as the primary control surface:
    // no console window is shown, and the browser opens directly to /settings.
    app::run(HttpLaunchOptions {
        open_dashboard: false,
        open_settings: true,
    })
    .await
}
