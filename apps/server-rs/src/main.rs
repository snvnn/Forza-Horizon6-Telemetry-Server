use forza_telemetry_server::app;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    app::run(app::parse_launch_options()).await
}
