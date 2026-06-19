#[cfg(target_os = "windows")]
mod windows_gui {
    use std::{
        ffi::OsStr,
        fs::File,
        os::{windows::ffi::OsStrExt, windows::process::CommandExt},
        path::PathBuf,
        process::{Child, Command, Stdio},
        ptr::{null, null_mut},
        sync::OnceLock,
    };

    use crate::config::{
        load_config, save_public_config, PublicConfig, SUPPORTED_DASHBOARD_LAYOUTS,
        TRANSPORT_BINARY, TRANSPORT_JSON,
    };
    use windows_sys::Win32::{
        Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM},
        Graphics::Gdi::{
            CreateFontW, CreateSolidBrush, DrawTextW, FillRect, FrameRect, SetBkColor, SetBkMode,
            SetTextColor, UpdateWindow, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET,
            DEFAULT_PITCH, DT_CENTER, DT_SINGLELINE, DT_VCENTER, FF_DONTCARE, HBRUSH, HDC, HFONT,
            OUT_DEFAULT_PRECIS, TRANSPARENT,
        },
        System::LibraryLoader::GetModuleHandleW,
        UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
            GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW, LoadCursorW, MessageBoxW,
            PostQuitMessage, RegisterClassW, SendMessageW, SetTimer, SetWindowLongPtrW,
            SetWindowTextW, ShowWindow, TranslateMessage, CS_HREDRAW, CS_VREDRAW, CW_USEDEFAULT,
            GWLP_USERDATA, IDC_ARROW, MB_ICONERROR, MB_ICONINFORMATION, MB_OK, MSG, SW_SHOW,
            WM_CLOSE, WM_COMMAND, WM_DESTROY, WM_SETFONT, WM_TIMER, WNDCLASSW, WS_BORDER, WS_CHILD,
            WS_OVERLAPPEDWINDOW, WS_TABSTOP, WS_VISIBLE,
        },
    };

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const BN_CLICKED: u16 = 0;
    const BM_GETCHECK: u32 = 0x00F0;
    const BM_SETCHECK: u32 = 0x00F1;
    const BST_CHECKED: usize = 1;
    const CB_ADDSTRING: u32 = 0x0143;
    const CB_GETCURSEL: u32 = 0x0147;
    const CB_SETCURSEL: u32 = 0x014E;
    const CBS_DROPDOWNLIST: u32 = 0x0003;
    const ES_AUTOHSCROLL: u32 = 0x0080;
    const BS_AUTOCHECKBOX: u32 = 0x0003;
    const BS_OWNERDRAW: u32 = 0x000B;
    const ES_READONLY: u32 = 0x0800;
    const ODS_SELECTED: u32 = 0x0001;
    const WM_DRAWITEM: u32 = 0x002B;
    const WM_CTLCOLOREDIT: u32 = 0x0133;
    const WM_CTLCOLORLISTBOX: u32 = 0x0134;
    const WM_CTLCOLORBTN: u32 = 0x0135;
    const WM_CTLCOLORSTATIC: u32 = 0x0138;
    const TIMER_STATUS: usize = 1;

    const UI_BG: COLORREF = rgb(3, 5, 7);
    const UI_FIELD: COLORREF = rgb(12, 16, 20);
    const UI_BUTTON: COLORREF = rgb(17, 22, 28);
    const UI_BUTTON_PRESSED: COLORREF = rgb(0, 88, 82);
    const UI_BUTTON_BORDER: COLORREF = rgb(53, 67, 78);
    const UI_TEXT: COLORREF = rgb(232, 238, 246);
    const UI_MUTED: COLORREF = rgb(141, 153, 168);
    const UI_ACCENT: COLORREF = rgb(0, 220, 190);

    static REGULAR_FONT: OnceLock<usize> = OnceLock::new();
    static TITLE_FONT: OnceLock<usize> = OnceLock::new();
    static SECTION_FONT: OnceLock<usize> = OnceLock::new();

    const fn rgb(red: u8, green: u8, blue: u8) -> COLORREF {
        red as COLORREF | ((green as COLORREF) << 8) | ((blue as COLORREF) << 16)
    }

    const ID_HTTP_HOST: i32 = 1001;
    const ID_HTTP_PORT: i32 = 1002;
    const ID_UDP_HOST: i32 = 1003;
    const ID_UDP_PORT: i32 = 1004;
    const ID_BROADCAST_HZ: i32 = 1005;
    const ID_RENDER_HZ: i32 = 1006;
    const ID_TRANSPORT: i32 = 1007;
    const ID_WS_TIMEOUT: i32 = 1008;
    const ID_CONNECTION_TIMEOUT: i32 = 1009;
    const ID_UDP_BUFFER: i32 = 1010;
    const ID_MOCK: i32 = 1011;
    const ID_DEBUG: i32 = 1012;
    const ID_DASHBOARD_LAYOUT: i32 = 1013;
    const ID_SAVE: i32 = 2001;
    const ID_START: i32 = 2002;
    const ID_STOP: i32 = 2003;
    const ID_RESTART: i32 = 2004;
    const ID_OPEN_DASHBOARD: i32 = 2005;
    const ID_STATUS: i32 = 3001;

    #[derive(Default)]
    struct Controls {
        http_host: HWND,
        http_port: HWND,
        udp_host: HWND,
        udp_port: HWND,
        broadcast_hz: HWND,
        render_hz: HWND,
        transport: HWND,
        dashboard_layout: HWND,
        websocket_timeout: HWND,
        connection_timeout: HWND,
        udp_buffer: HWND,
        mock: HWND,
        debug: HWND,
        status: HWND,
    }

    struct GuiState {
        controls: Controls,
        child: Option<Child>,
        config_path: PathBuf,
        dashboard_dist_dir: PathBuf,
        server_exe_path: PathBuf,
        work_dir: PathBuf,
        background_brush: HBRUSH,
        field_brush: HBRUSH,
        button_brush: HBRUSH,
        button_pressed_brush: HBRUSH,
        button_border_brush: HBRUSH,
        accent_controls: Vec<HWND>,
        muted_controls: Vec<HWND>,
    }

    #[repr(C)]
    struct DrawItemStruct {
        ctl_type: u32,
        ctl_id: u32,
        item_id: u32,
        item_action: u32,
        item_state: u32,
        hwnd_item: HWND,
        hdc: HDC,
        rc_item: RECT,
        item_data: usize,
    }

    struct FieldHandles {
        label: HWND,
        control: HWND,
    }

    pub fn run() -> i32 {
        unsafe {
            let loaded = load_config();
            let exe_path = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
            let exe_dir = exe_path
                .parent()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."));
            let server_exe_path = exe_path.clone();
            let work_dir = loaded
                .config_path
                .parent()
                .map(PathBuf::from)
                .unwrap_or_else(|| exe_dir.clone());
            let background_brush = CreateSolidBrush(UI_BG);
            let field_brush = CreateSolidBrush(UI_FIELD);
            let button_brush = CreateSolidBrush(UI_BUTTON);
            let button_pressed_brush = CreateSolidBrush(UI_BUTTON_PRESSED);
            let button_border_brush = CreateSolidBrush(UI_BUTTON_BORDER);

            let state = Box::new(GuiState {
                controls: Controls::default(),
                child: None,
                config_path: loaded.config_path.clone(),
                dashboard_dist_dir: loaded.dashboard_dist_dir.clone(),
                server_exe_path,
                work_dir,
                background_brush,
                field_brush,
                button_brush,
                button_pressed_brush,
                button_border_brush,
                accent_controls: Vec::new(),
                muted_controls: Vec::new(),
            });

            let instance = GetModuleHandleW(null());
            let class_name = wide("SimTelemetryServerNativeGui");
            let window_title = wide("Sim Telemetry Server");
            let wc = WNDCLASSW {
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(wnd_proc),
                hInstance: instance,
                lpszClassName: class_name.as_ptr(),
                hCursor: LoadCursorW(null_mut(), IDC_ARROW),
                hbrBackground: background_brush,
                ..Default::default()
            };

            if RegisterClassW(&wc) == 0 {
                message_box(
                    null_mut(),
                    "Failed to register native GUI window class.",
                    true,
                );
                return 1;
            }

            let raw_state = Box::into_raw(state);
            let hwnd = CreateWindowExW(
                0,
                class_name.as_ptr(),
                window_title.as_ptr(),
                WS_OVERLAPPEDWINDOW,
                CW_USEDEFAULT,
                CW_USEDEFAULT,
                760,
                640,
                null_mut(),
                null_mut(),
                instance,
                null_mut(),
            );

            if hwnd == null_mut() {
                let _ = Box::from_raw(raw_state);
                message_box(null_mut(), "Failed to create native GUI window.", true);
                return 1;
            }

            SetWindowLongPtrW(hwnd, GWLP_USERDATA, raw_state as isize);
            create_controls(hwnd, &mut *raw_state, instance);
            populate_config(&mut *raw_state, &loaded.to_public());
            set_status(
                &*raw_state,
                "Stopped. Edit config, then Start Server. Dashboard is available while the server is running.",
            );

            SetTimer(hwnd, TIMER_STATUS, 1000, None);
            ShowWindow(hwnd, SW_SHOW);
            UpdateWindow(hwnd);

            let mut msg = MSG::default();
            while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            let mut boxed = Box::from_raw(raw_state);
            stop_server(hwnd, &mut boxed, false, false);
            0
        }
    }

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_COMMAND => {
                let id = loword(wparam) as i32;
                let notify = hiword(wparam);
                if notify == BN_CLICKED || id == ID_SAVE || id == ID_TRANSPORT {
                    if let Some(state) = state_mut(hwnd) {
                        handle_command(hwnd, state, id);
                    }
                }
                0
            }
            WM_TIMER => {
                if wparam == TIMER_STATUS {
                    if let Some(state) = state_mut(hwnd) {
                        refresh_child_status(state);
                    }
                }
                0
            }
            WM_CTLCOLORSTATIC => {
                if let Some(state) = state_mut(hwnd) {
                    paint_static(wparam as HDC, lparam as HWND, state)
                } else {
                    0
                }
            }
            WM_CTLCOLOREDIT => {
                if let Some(state) = state_mut(hwnd) {
                    paint_edit(wparam as HDC, state)
                } else {
                    0
                }
            }
            WM_CTLCOLORLISTBOX => {
                if let Some(state) = state_mut(hwnd) {
                    paint_edit(wparam as HDC, state)
                } else {
                    0
                }
            }
            WM_CTLCOLORBTN => {
                if let Some(state) = state_mut(hwnd) {
                    paint_button(wparam as HDC, state)
                } else {
                    0
                }
            }
            WM_DRAWITEM => {
                if let Some(state) = state_mut(hwnd) {
                    draw_owner_button(lparam, state)
                } else {
                    0
                }
            }
            WM_CLOSE => {
                if let Some(state) = state_mut(hwnd) {
                    stop_server(hwnd, state, false, false);
                }
                DestroyWindow(hwnd);
                0
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    unsafe fn handle_command(hwnd: HWND, state: &mut GuiState, id: i32) {
        match id {
            ID_SAVE => match save_from_controls(state) {
                Ok(_) => set_status(state, "Config saved to config.json."),
                Err(error) => message_box(hwnd, &error, true),
            },
            ID_START => start_server(hwnd, state),
            ID_STOP => stop_server(hwnd, state, true, true),
            ID_RESTART => {
                stop_server(hwnd, state, false, true);
                start_server(hwnd, state);
            }
            ID_OPEN_DASHBOARD => open_dashboard(hwnd, state),
            _ => {}
        }
    }

    unsafe fn create_controls(hwnd: HWND, state: &mut GuiState, instance: HINSTANCE) {
        let title = label(hwnd, instance, "SIM TELEMETRY SERVER", 24, 16, 330, 30);
        set_font(title, title_font());
        mark_accent(state, title);
        mark_muted(
            state,
            label(
                hwnd,
                instance,
                "FH6 UDP DATA OUT  /  RUST RUNTIME  /  LOW-LATENCY DASHBOARD",
                24,
                50,
                520,
                20,
            ),
        );
        mark_muted(state, label(hwnd, instance, "ADAPTER", 570, 18, 120, 18));
        let adapter = label(hwnd, instance, "FORZA HORIZON 6", 570, 40, 160, 24);
        set_font(adapter, section_font());
        mark_accent(state, adapter);

        section_title(hwnd, state, instance, "NETWORK", 24, 86, 504);
        let http_host = labeled_edit(hwnd, instance, "HTTP Host", ID_HTTP_HOST, 24, 120);
        let http_port = labeled_edit(hwnd, instance, "HTTP Port", ID_HTTP_PORT, 284, 120);
        let udp_host = labeled_edit(hwnd, instance, "UDP Host", ID_UDP_HOST, 24, 170);
        let udp_port = labeled_edit(hwnd, instance, "UDP Port", ID_UDP_PORT, 284, 170);
        state.controls.http_host = http_host.control;
        state.controls.http_port = http_port.control;
        state.controls.udp_host = udp_host.control;
        state.controls.udp_port = udp_port.control;
        mark_field_label(state, &http_host);
        mark_field_label(state, &http_port);
        mark_field_label(state, &udp_host);
        mark_field_label(state, &udp_port);

        section_title(hwnd, state, instance, "PERFORMANCE", 24, 236, 504);
        let broadcast_hz = labeled_edit(
            hwnd,
            instance,
            "Broadcast Hz (0-240)",
            ID_BROADCAST_HZ,
            24,
            270,
        );
        let render_hz = labeled_edit(
            hwnd,
            instance,
            "Dashboard Render Hz",
            ID_RENDER_HZ,
            284,
            270,
        );
        let transport = labeled_combo(hwnd, instance, "Transport Mode", ID_TRANSPORT, 24, 320);
        let websocket_timeout = labeled_edit(
            hwnd,
            instance,
            "WebSocket Timeout ms",
            ID_WS_TIMEOUT,
            284,
            320,
        );
        let connection_timeout = labeled_edit(
            hwnd,
            instance,
            "Connection Timeout ms",
            ID_CONNECTION_TIMEOUT,
            24,
            370,
        );
        let udp_buffer = labeled_edit(hwnd, instance, "UDP Buffer bytes", ID_UDP_BUFFER, 284, 370);
        let dashboard_layout =
            labeled_combo(hwnd, instance, "Dashboard Layout", ID_DASHBOARD_LAYOUT, 24, 420);
        state.controls.broadcast_hz = broadcast_hz.control;
        state.controls.render_hz = render_hz.control;
        state.controls.transport = transport.control;
        state.controls.dashboard_layout = dashboard_layout.control;
        state.controls.websocket_timeout = websocket_timeout.control;
        state.controls.connection_timeout = connection_timeout.control;
        state.controls.udp_buffer = udp_buffer.control;
        add_combo_item(state.controls.transport, "json");
        add_combo_item(state.controls.transport, "binary");
        for layout in SUPPORTED_DASHBOARD_LAYOUTS {
            add_combo_item(state.controls.dashboard_layout, layout);
        }
        mark_field_label(state, &broadcast_hz);
        mark_field_label(state, &render_hz);
        mark_field_label(state, &transport);
        mark_field_label(state, &dashboard_layout);
        mark_field_label(state, &websocket_timeout);
        mark_field_label(state, &connection_timeout);
        mark_field_label(state, &udp_buffer);

        section_title(hwnd, state, instance, "OPTIONS", 570, 86, 148);
        state.controls.mock =
            checkbox(hwnd, instance, "Mock Telemetry", ID_MOCK, 570, 120, 160, 24);
        state.controls.debug =
            checkbox(hwnd, instance, "Debug Packet", ID_DEBUG, 570, 150, 160, 24);

        section_title(hwnd, state, instance, "RUNTIME", 570, 218, 148);
        button(hwnd, instance, "Start Server", ID_START, 570, 252, 150, 34);
        button(hwnd, instance, "Stop Server", ID_STOP, 570, 294, 150, 34);
        button(hwnd, instance, "Restart", ID_RESTART, 570, 336, 150, 34);
        button(hwnd, instance, "Save Config", ID_SAVE, 570, 386, 150, 30);
        button(
            hwnd,
            instance,
            "Open Dashboard",
            ID_OPEN_DASHBOARD,
            570,
            424,
            150,
            30,
        );

        section_title(hwnd, state, instance, "STATUS", 24, 482, 696);
        mark_muted(
            state,
            label(
                hwnd,
                instance,
                "Forza Data Out: 127.0.0.1:5400 by default. Avoid UDP 5200-5300. Korean setup guide: README-WINDOWS.md",
                24,
                510,
                696,
                20,
            ),
        );
        state.controls.status = child_window(
            hwnd,
            instance,
            "EDIT",
            "",
            ID_STATUS,
            24,
            536,
            696,
            34,
            WS_CHILD | WS_VISIBLE | WS_BORDER | ES_READONLY,
        );
    }

    unsafe fn populate_config(state: &mut GuiState, config: &PublicConfig) {
        set_text(state.controls.http_host, &config.http_host);
        set_text(state.controls.http_port, &config.http_port.to_string());
        set_text(state.controls.udp_host, &config.udp_host);
        set_text(state.controls.udp_port, &config.udp_port.to_string());
        set_text(
            state.controls.broadcast_hz,
            &trim_float(config.broadcast_hz),
        );
        set_text(
            state.controls.render_hz,
            &config.dashboard_render_hz.to_string(),
        );
        set_text(
            state.controls.websocket_timeout,
            &config.websocket_send_timeout_ms.to_string(),
        );
        set_text(
            state.controls.connection_timeout,
            &config.connection_timeout_ms.to_string(),
        );
        set_text(
            state.controls.udp_buffer,
            &config.udp_receive_buffer_bytes.to_string(),
        );
        let transport_index = if config.transport_mode == TRANSPORT_BINARY {
            1
        } else {
            0
        };
        SendMessageW(state.controls.transport, CB_SETCURSEL, transport_index, 0);
        let layout_index = SUPPORTED_DASHBOARD_LAYOUTS
            .iter()
            .position(|layout| *layout == config.dashboard_layout)
            .unwrap_or(0);
        SendMessageW(state.controls.dashboard_layout, CB_SETCURSEL, layout_index, 0);
        set_checked(state.controls.mock, config.mock_telemetry);
        set_checked(state.controls.debug, config.debug_packet);
    }

    unsafe fn save_from_controls(state: &GuiState) -> Result<PublicConfig, String> {
        let config = read_public_config(state)?;
        save_public_config(&config, &state.config_path)?;
        Ok(config)
    }

    unsafe fn read_public_config(state: &GuiState) -> Result<PublicConfig, String> {
        Ok(PublicConfig {
            game_adapter: "forza-horizon-6".to_string(),
            http_host: text(state.controls.http_host),
            http_port: parse_u16("HTTP Port", state.controls.http_port)?,
            udp_host: text(state.controls.udp_host),
            udp_port: parse_u16("UDP Port", state.controls.udp_port)?,
            udp_receive_buffer_bytes: parse_usize("UDP Buffer bytes", state.controls.udp_buffer)?,
            broadcast_hz: parse_f64("Broadcast Hz", state.controls.broadcast_hz)?,
            transport_mode: selected_transport(state.controls.transport),
            dashboard_layout: selected_dashboard_layout(state.controls.dashboard_layout),
            dashboard_render_hz: parse_u16("Dashboard Render Hz", state.controls.render_hz)?,
            websocket_send_timeout_ms: parse_u64(
                "WebSocket Timeout ms",
                state.controls.websocket_timeout,
            )?,
            connection_timeout_ms: parse_u64(
                "Connection Timeout ms",
                state.controls.connection_timeout,
            )?,
            mock_telemetry: is_checked(state.controls.mock),
            debug_packet: is_checked(state.controls.debug),
        })
    }

    unsafe fn start_server(hwnd: HWND, state: &mut GuiState) {
        refresh_child_status(state);
        if state.child.is_some() {
            set_status(state, "Server is already running from this GUI.");
            return;
        }

        if let Err(error) = save_from_controls(state) {
            message_box(hwnd, &error, true);
            return;
        }

        if !state.server_exe_path.exists() {
            message_box(
                hwnd,
                &format!(
                    "Cannot find server executable:\n{}",
                    state.server_exe_path.display()
                ),
                true,
            );
            return;
        }

        let stdout = File::create(state.work_dir.join("sim-telemetry-server.out.log"))
            .map(Stdio::from)
            .unwrap_or_else(|_| Stdio::null());
        let stderr = File::create(state.work_dir.join("sim-telemetry-server.err.log"))
            .map(Stdio::from)
            .unwrap_or_else(|_| Stdio::null());

        let child = Command::new(&state.server_exe_path)
            .arg("--server")
            .current_dir(&state.work_dir)
            .env("DASHBOARD_DIST_DIR", &state.dashboard_dist_dir)
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr)
            .spawn();

        match child {
            Ok(child) => {
                state.child = Some(child);
                set_status(state, "Server started without a console window.");
            }
            Err(error) => message_box(hwnd, &format!("Failed to start server: {error}"), true),
        }
    }

    unsafe fn stop_server(
        hwnd: HWND,
        state: &mut GuiState,
        show_status: bool,
        include_external: bool,
    ) {
        if let Some(mut child) = state.child.take() {
            let result = child.kill().and_then(|_| child.wait().map(|_| ()));
            match result {
                Ok(()) => {
                    if show_status {
                        set_status(state, "Server stopped.");
                    }
                }
                Err(error) => {
                    if show_status {
                        message_box(hwnd, &format!("Failed to stop server: {error}"), true);
                    }
                }
            }
        } else if show_status {
            if include_external {
                match stop_external_server_processes() {
                    Ok(true) => set_status(state, "External server process stopped."),
                    Ok(false) => set_status(state, "No server process was found."),
                    Err(error) => message_box(hwnd, &error, true),
                }
            } else {
                set_status(state, "No server process was started by this GUI.");
            }
        }
    }

    fn stop_external_server_processes() -> Result<bool, String> {
        let output = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "$targets = @(Get-CimInstance Win32_Process -Filter \"Name = 'sim-telemetry-server.exe'\" | Where-Object { $_.CommandLine -match '--server' }); $targets | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Write-Output $targets.Count",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .map_err(|error| format!("Failed to run PowerShell stop command: {error}"))?;

        if !output.status.success() {
            return Err("PowerShell stop command failed.".to_string());
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(stdout.trim().parse::<u32>().unwrap_or(0) > 0)
    }

    unsafe fn open_dashboard(hwnd: HWND, state: &GuiState) {
        match read_public_config(state) {
            Ok(config) => {
                let url = format!("http://localhost:{}/dashboard", config.http_port);
                let status = Command::new("cmd")
                    .args(["/C", "start", "", &url])
                    .creation_flags(CREATE_NO_WINDOW)
                    .status();
                if status.is_err() {
                    message_box(
                        hwnd,
                        "Failed to open the dashboard in the default browser.",
                        true,
                    );
                }
            }
            Err(error) => message_box(hwnd, &error, true),
        }
    }

    unsafe fn refresh_child_status(state: &mut GuiState) {
        if let Some(child) = state.child.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    state.child = None;
                    set_status(state, &format!("Server exited: {status}"));
                }
                Ok(None) => {}
                Err(error) => {
                    state.child = None;
                    set_status(state, &format!("Server status check failed: {error}"));
                }
            }
        }
    }

    unsafe fn paint_static(hdc: HDC, control: HWND, state: &GuiState) -> LRESULT {
        if control == state.controls.status {
            return paint_edit(hdc, state);
        }

        SetBkMode(hdc, TRANSPARENT as i32);
        let text_color = if state.accent_controls.contains(&control) {
            UI_ACCENT
        } else if state.muted_controls.contains(&control) {
            UI_MUTED
        } else {
            UI_TEXT
        };
        SetTextColor(hdc, text_color);
        state.background_brush as LRESULT
    }

    unsafe fn paint_edit(hdc: HDC, state: &GuiState) -> LRESULT {
        SetBkMode(hdc, TRANSPARENT as i32);
        SetBkColor(hdc, UI_FIELD);
        SetTextColor(hdc, UI_TEXT);
        state.field_brush as LRESULT
    }

    unsafe fn paint_button(hdc: HDC, state: &GuiState) -> LRESULT {
        SetBkMode(hdc, TRANSPARENT as i32);
        SetTextColor(hdc, UI_TEXT);
        state.background_brush as LRESULT
    }

    unsafe fn draw_owner_button(lparam: LPARAM, state: &GuiState) -> LRESULT {
        if lparam == 0 {
            return 0;
        }

        let draw = &*(lparam as *const DrawItemStruct);
        let pressed = (draw.item_state & ODS_SELECTED) != 0;
        let fill = if pressed {
            state.button_pressed_brush
        } else {
            state.button_brush
        };

        FillRect(draw.hdc, &draw.rc_item, fill);
        FrameRect(draw.hdc, &draw.rc_item, state.button_border_brush);

        let mut text_rect = draw.rc_item;
        if pressed {
            text_rect.left += 1;
            text_rect.top += 1;
        }

        let text = wide(&text(draw.hwnd_item));
        SetBkMode(draw.hdc, TRANSPARENT as i32);
        SetTextColor(draw.hdc, UI_TEXT);
        DrawTextW(
            draw.hdc,
            text.as_ptr(),
            -1,
            &mut text_rect,
            DT_CENTER | DT_VCENTER | DT_SINGLELINE,
        );

        1
    }

    unsafe fn section_title(
        parent: HWND,
        state: &mut GuiState,
        instance: HINSTANCE,
        text: &str,
        x: i32,
        y: i32,
        width: i32,
    ) {
        let title = label(parent, instance, text, x, y, width, 18);
        set_font(title, section_font());
        mark_accent(state, title);
        divider(parent, instance, x, y + 24, width);
    }

    unsafe fn divider(parent: HWND, instance: HINSTANCE, x: i32, y: i32, width: i32) {
        child_window(
            parent,
            instance,
            "STATIC",
            "",
            0,
            x,
            y,
            width,
            1,
            WS_CHILD | WS_VISIBLE | WS_BORDER,
        );
    }

    fn mark_accent(state: &mut GuiState, control: HWND) -> HWND {
        state.accent_controls.push(control);
        control
    }

    fn mark_muted(state: &mut GuiState, control: HWND) -> HWND {
        state.muted_controls.push(control);
        control
    }

    fn mark_field_label(state: &mut GuiState, field: &FieldHandles) {
        mark_muted(state, field.label);
    }

    unsafe fn labeled_edit(
        parent: HWND,
        instance: HINSTANCE,
        caption: &str,
        id: i32,
        x: i32,
        y: i32,
    ) -> FieldHandles {
        let label = label(parent, instance, caption, x, y, 200, 18);
        let control = child_window(
            parent,
            instance,
            "EDIT",
            "",
            id,
            x,
            y + 20,
            238,
            24,
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL,
        );
        FieldHandles { label, control }
    }

    unsafe fn labeled_combo(
        parent: HWND,
        instance: HINSTANCE,
        caption: &str,
        id: i32,
        x: i32,
        y: i32,
    ) -> FieldHandles {
        let label = label(parent, instance, caption, x, y, 200, 18);
        let control = child_window(
            parent,
            instance,
            "COMBOBOX",
            "",
            id,
            x,
            y + 20,
            238,
            120,
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_BORDER | CBS_DROPDOWNLIST,
        );
        FieldHandles { label, control }
    }

    unsafe fn label(
        parent: HWND,
        instance: HINSTANCE,
        text: &str,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    ) -> HWND {
        child_window(
            parent,
            instance,
            "STATIC",
            text,
            0,
            x,
            y,
            width,
            height,
            WS_CHILD | WS_VISIBLE,
        )
    }

    unsafe fn button(
        parent: HWND,
        instance: HINSTANCE,
        text: &str,
        id: i32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    ) -> HWND {
        child_window(
            parent,
            instance,
            "BUTTON",
            text,
            id,
            x,
            y,
            width,
            height,
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_OWNERDRAW,
        )
    }

    unsafe fn checkbox(
        parent: HWND,
        instance: HINSTANCE,
        text: &str,
        id: i32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    ) -> HWND {
        child_window(
            parent,
            instance,
            "BUTTON",
            text,
            id,
            x,
            y,
            width,
            height,
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTOCHECKBOX,
        )
    }

    unsafe fn child_window(
        parent: HWND,
        instance: HINSTANCE,
        class_name: &str,
        text: &str,
        id: i32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        style: u32,
    ) -> HWND {
        let class_name = wide(class_name);
        let text = wide(text);
        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            text.as_ptr(),
            style,
            x,
            y,
            width,
            height,
            parent,
            id as _,
            instance,
            null_mut(),
        );
        set_font(hwnd, regular_font());
        hwnd
    }

    unsafe fn set_font(hwnd: HWND, font: HFONT) {
        SendMessageW(hwnd, WM_SETFONT, font as WPARAM, 1);
    }

    unsafe fn regular_font() -> HFONT {
        *REGULAR_FONT.get_or_init(|| create_gui_font(-15, 400, "Segoe UI") as usize) as HFONT
    }

    unsafe fn title_font() -> HFONT {
        *TITLE_FONT.get_or_init(|| create_gui_font(-23, 700, "Segoe UI Semibold") as usize) as HFONT
    }

    unsafe fn section_font() -> HFONT {
        *SECTION_FONT.get_or_init(|| create_gui_font(-14, 700, "Segoe UI Semibold") as usize)
            as HFONT
    }

    unsafe fn create_gui_font(height: i32, weight: i32, face_name: &str) -> HFONT {
        let face_name = wide(face_name);
        CreateFontW(
            height,
            0,
            0,
            0,
            weight,
            0,
            0,
            0,
            DEFAULT_CHARSET as u32,
            OUT_DEFAULT_PRECIS as u32,
            CLIP_DEFAULT_PRECIS as u32,
            CLEARTYPE_QUALITY as u32,
            (DEFAULT_PITCH as u32) | (FF_DONTCARE as u32),
            face_name.as_ptr(),
        )
    }

    unsafe fn set_status(state: &GuiState, message: &str) {
        if state.controls.status != null_mut() {
            set_text(state.controls.status, message);
        }
    }

    unsafe fn message_box(parent: HWND, message: &str, error: bool) {
        let message = wide(message);
        let title = wide("Sim Telemetry Server");
        let icon = if error {
            MB_ICONERROR
        } else {
            MB_ICONINFORMATION
        };
        MessageBoxW(parent, message.as_ptr(), title.as_ptr(), MB_OK | icon);
    }

    unsafe fn add_combo_item(hwnd: HWND, value: &str) {
        let value = wide(value);
        SendMessageW(hwnd, CB_ADDSTRING, 0, value.as_ptr() as LPARAM);
    }

    unsafe fn selected_transport(hwnd: HWND) -> String {
        let index = SendMessageW(hwnd, CB_GETCURSEL, 0, 0);
        if index == 1 {
            TRANSPORT_BINARY.to_string()
        } else {
            TRANSPORT_JSON.to_string()
        }
    }

    unsafe fn selected_dashboard_layout(hwnd: HWND) -> String {
        let index = SendMessageW(hwnd, CB_GETCURSEL, 0, 0) as usize;
        SUPPORTED_DASHBOARD_LAYOUTS
            .get(index)
            .unwrap_or(&"race")
            .to_string()
    }

    unsafe fn set_checked(hwnd: HWND, checked: bool) {
        SendMessageW(hwnd, BM_SETCHECK, usize::from(checked), 0);
    }

    unsafe fn is_checked(hwnd: HWND) -> bool {
        SendMessageW(hwnd, BM_GETCHECK, 0, 0) as usize == BST_CHECKED
    }

    unsafe fn parse_u16(name: &str, hwnd: HWND) -> Result<u16, String> {
        text(hwnd)
            .parse::<u16>()
            .map_err(|_| format!("{name} must be a number between 1 and 65535."))
    }

    unsafe fn parse_u64(name: &str, hwnd: HWND) -> Result<u64, String> {
        text(hwnd)
            .parse::<u64>()
            .map_err(|_| format!("{name} must be a positive integer."))
    }

    unsafe fn parse_usize(name: &str, hwnd: HWND) -> Result<usize, String> {
        text(hwnd)
            .parse::<usize>()
            .map_err(|_| format!("{name} must be a positive integer."))
    }

    unsafe fn parse_f64(name: &str, hwnd: HWND) -> Result<f64, String> {
        text(hwnd)
            .parse::<f64>()
            .map_err(|_| format!("{name} must be a number."))
    }

    unsafe fn set_text(hwnd: HWND, value: &str) {
        let value = wide(value);
        SetWindowTextW(hwnd, value.as_ptr());
    }

    unsafe fn text(hwnd: HWND) -> String {
        let len = GetWindowTextLengthW(hwnd);
        let mut buffer = vec![0u16; len as usize + 1];
        let read = GetWindowTextW(hwnd, buffer.as_mut_ptr(), len + 1);
        String::from_utf16_lossy(&buffer[..read as usize])
            .trim()
            .to_string()
    }

    unsafe fn state_mut(hwnd: HWND) -> Option<&'static mut GuiState> {
        let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut GuiState;
        ptr.as_mut()
    }

    fn loword(value: usize) -> u16 {
        (value & 0xffff) as u16
    }

    fn hiword(value: usize) -> u16 {
        ((value >> 16) & 0xffff) as u16
    }

    fn trim_float(value: f64) -> String {
        if value.fract() == 0.0 {
            format!("{value:.0}")
        } else {
            value.to_string()
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }
}

#[cfg(target_os = "windows")]
pub fn run() -> i32 {
    windows_gui::run()
}

#[cfg(not(target_os = "windows"))]
pub fn run() -> i32 {
    eprintln!("Native GUI is available on Windows only.");
    1
}
