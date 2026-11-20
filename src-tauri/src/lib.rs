#[cfg(not(target_os = "linux"))]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconId},
};
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::MacosLauncher;

mod ai;
mod claude;
mod commands;
mod images;
mod imap;
mod oauth;
mod quarantine;
mod smtp;

/// Bring the main window forward. Used by the Dock, the tray, and a second launch.
fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// True when autostart launched the app (`--hidden`): the window stays hidden until the user opens it.
#[tauri::command]
fn started_hidden() -> bool {
    std::env::args().any(|a| a == "--hidden")
}

#[tauri::command]
fn set_tray_tooltip(app: tauri::AppHandle, tooltip: String) -> Result<(), String> {
    #[cfg(not(target_os = "linux"))]
    {
        let tray = app
            .tray_by_id(&TrayIconId::new("main-tray"))
            .ok_or_else(|| "Tray icon not found".to_string())?;
        tray.set_tooltip(Some(&tooltip)).map_err(|e| e.to_string())
    }
    #[cfg(target_os = "linux")]
    {
        let _ = tooltip;
        let _ = app;
        log::debug!("set_tray_tooltip is not supported on Linux (KSNI tray)");
        Ok(())
    }
}

/// Puts the unread count next to the menu-bar icon (macOS). Empty string clears it.
#[tauri::command]
fn set_tray_title(app: tauri::AppHandle, title: String) -> Result<(), String> {
    #[cfg(not(target_os = "linux"))]
    {
        let tray = app
            .tray_by_id(&TrayIconId::new("main-tray"))
            .ok_or_else(|| "Tray icon not found".to_string())?;
        // None is ignored on macOS, so a previous count would stay after the inbox is clear.
        // An empty string is what actually removes the number.
        tray.set_title(Some(title.as_str())).map_err(|e| e.to_string())
    }
    #[cfg(target_os = "linux")]
    {
        let _ = title;
        let _ = app;
        Ok(())
    }
}

/// Since macOS 12, Dock `setBadgeLabel` is ignored unless the app has asked
/// `UNUserNotificationCenter` for the Badge option. Call once on `RunEvent::Ready`
/// (during `setup` it is a silent no-op). The OS keeps the grant across launches.
#[cfg(target_os = "macos")]
fn request_badge_authorization() {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::NSError;
    use objc2_user_notifications::{UNAuthorizationOptions, UNUserNotificationCenter};

    let center = UNUserNotificationCenter::currentNotificationCenter();
    let options = UNAuthorizationOptions::Badge
        | UNAuthorizationOptions::Alert
        | UNAuthorizationOptions::Sound;
    let handler = RcBlock::new(|_granted: Bool, _error: *mut NSError| {});
    center.requestAuthorizationWithOptions_completionHandler(options, &handler);
}

/// What a webview does with a URL it is asked to load, in a frame or as a new window.
#[derive(Debug, PartialEq)]
enum Navigation {
    /// The app itself, or the mail frame's own blank/srcdoc document.
    Allow,
    /// A link of the web or a new mail: the system browser or mail app opens it.
    OpenOutside,
    /// Anything else, which would replace the app.
    Block,
}

/// The app is tauri://localhost (tauri.localhost on Windows), plus the dev server in a
/// debug build; the mail's iframe loads about:blank and about:srcdoc.
fn decide(url: &tauri::Url, dev_url: Option<&tauri::Url>) -> Navigation {
    let app = match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "about" => matches!(url.path(), "blank" | "srcdoc"),
        "http" | "https" => {
            url.host_str() == Some("tauri.localhost")
                || dev_url.is_some_and(|dev| dev.origin() == url.origin())
        }
        _ => false,
    };
    if app {
        Navigation::Allow
    } else if matches!(url.scheme(), "http" | "https" | "mailto") {
        Navigation::OpenOutside
    } else {
        Navigation::Block
    }
}

fn dev_url<R: tauri::Runtime>(webview: &tauri::Webview<R>) -> Option<tauri::Url> {
    webview.config().build.dev_url.clone().filter(|_| cfg!(debug_assertions))
}

/// Never loads `url` in the app: opens it outside when it is a web or mail link.
/// Returns whether the app may load it itself.
fn route(url: &tauri::Url, dev_url: Option<&tauri::Url>) -> bool {
    match decide(url, dev_url) {
        Navigation::Allow => true,
        Navigation::OpenOutside => {
            if let Err(e) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
                log::warn!("Failed to open a link outside the app: {e}");
            }
            false
        }
        Navigation::Block => {
            log::warn!("Blocked a navigation away from the app ({})", url.scheme());
            false
        }
    }
}

/// A message's link leaves its sandboxed frame as a popup (target _blank). On macOS
/// WebKit first asks the navigation policy, where the guard opens it and cancels, so
/// this never runs for it; WebView2 and webkitgtk send popups only here. Either way a
/// link is opened once and never becomes a window of the app.
fn open_popup_outside(url: tauri::Url) -> tauri::webview::NewWindowResponse<tauri::Wry> {
    if decide(&url, None) == Navigation::OpenOutside {
        route(&url, None);
    }
    tauri::webview::NewWindowResponse::Deny
}

/// No webview or frame navigates away from the app (on macOS this sees every frame,
/// the mail's iframe included): the web and mail links open outside, the rest is blocked.
fn navigation_guard<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("navigation-guard")
        .on_navigation(|webview, url| route(url, dev_url(webview).as_ref()))
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_app_loads_only_itself_and_web_or_mail_links_open_outside() {
        let dev: tauri::Url = "http://localhost:1420".parse().unwrap();
        let at = |u: &str| decide(&u.parse().unwrap(), Some(&dev));
        for ok in [
            "tauri://localhost/",
            "tauri://localhost/#/settings",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/",
            "about:blank",
            "about:srcdoc",
            "http://localhost:1420/#/t/a/b",
        ] {
            assert_eq!(at(ok), Navigation::Allow, "{ok}");
        }
        for out in ["https://example.com/x", "http://phish.test/", "http://localhost:1421/", "mailto:a@b.com"] {
            assert_eq!(at(out), Navigation::OpenOutside, "{out}");
        }
        for no in ["tauri://evil/", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "about:config", "smb://host/share"] {
            assert_eq!(at(no), Navigation::Block, "{no}");
        }
        // Outside a debug build the dev server is just another web page.
        assert_eq!(decide(&"http://localhost:1420/".parse().unwrap(), None), Navigation::OpenOutside);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Set explicit AUMID on Windows so toast notifications show "voa"
    // instead of "Windows PowerShell"
    #[cfg(windows)]
    {
        use windows::core::w;
        use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
        unsafe {
            let _ = SetCurrentProcessExplicitAppUserModelID(w!("email.voa"));
        }
    }

    tauri::Builder::default()
        // Single instance MUST be first
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            show_main(app);
            // Forward args for deep linking
            let _ = app.emit("single-instance-args", argv);
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .plugin(navigation_guard())
        // A mail's images, fetched by the app (images.rs): the reader asks voa-img://localhost/<url>.
        .register_asynchronous_uri_scheme_protocol("voa-img", |_ctx, request, responder| {
            let path = request.uri().path().to_owned();
            tauri::async_runtime::spawn(async move { responder.respond(images::serve(path).await) });
        })
        .manage(claude::Claude::default())
        .manage(ai::Listening::default())
        .invoke_handler(tauri::generate_handler![
            oauth::start_oauth_server,
            oauth::start_oauth_server_any_port,
            oauth::oauth_exchange_token,
            oauth::oauth_refresh_token,
            started_hidden,
            set_tray_tooltip,
            set_tray_title,
            commands::imap_test_connection,
            commands::imap_list_folders,
            commands::imap_fetch_messages,
            commands::imap_fetch_new_uids,
            commands::imap_fetch_message_body,
            commands::imap_fetch_raw_message,
            commands::imap_set_flags,
            commands::imap_move_messages,
            commands::imap_delete_messages,
            commands::imap_get_folder_status,
            commands::imap_fetch_attachment,
            commands::imap_append_message,
            commands::imap_search_folder,
            commands::imap_delta_check,
            commands::smtp_send_email,
            commands::smtp_test_connection,
            quarantine::quarantine_file,
            ai::ai_ask,
            ai::listen_start,
            ai::listen_stop,
            claude::claude_version,
            claude::claude_open,
            claude::claude_ask,
            claude::claude_close,
        ])
        .setup(|app| {
            {
                let level = if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                };
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(level)
                        .level_for("sqlx::query", log::LevelFilter::Warn)
                        .build(),
                )?;
            }

            // The main window is built here, not from tauri.conf.json alone, to give it the popup handler.
            let main_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .expect("main window in tauri.conf.json");
            tauri::WebviewWindowBuilder::from_config(app.handle(), &main_config)?
                .on_new_window(|url, _features| open_popup_outside(url))
                .build()?;

            #[cfg(not(target_os = "linux"))]
            {
                // Build system tray menu
                let show = MenuItem::with_id(app, "show", "Show voa", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show, &quit])?;

                // Menu bar mark: black silhouette with alpha (template), not the Dock app icon.
                let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon@2x.png"))
                    .expect("tray icon png");

                TrayIconBuilder::with_id("main-tray")
                    .icon(icon)
                    .icon_as_template(true)
                    .tooltip("voa")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => show_main(app),
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                            show_main(tray.app_handle());
                        }
                    })
                    .build(app)?;
            }

            #[cfg(target_os = "linux")]
            {
                use tray_item::{IconSource, TrayItem};

                let app_handle = app.handle().clone();

                std::thread::spawn(move || {
                    let mut tray = match TrayItem::new("voa", IconSource::Resource("mail-read")) {
                        Ok(t) => t,
                        Err(e) => {
                            log::warn!("Failed to create system tray: {e}");
                            return;
                        }
                    };

                    let app_handle_show = app_handle.clone();
                    if let Err(e) = tray.add_menu_item("Show voa", move || {
                        show_main(&app_handle_show);
                    }) {
                        log::warn!("Failed to add tray menu item 'Show voa': {e}");
                    }

                    let app_handle_quit = app_handle.clone();
                    if let Err(e) = tray.add_menu_item("Quit", move || {
                        app_handle_quit.exit(0);
                    }) {
                        log::warn!("Failed to add tray menu item 'Quit': {e}");
                    }

                    loop {
                        std::thread::park();
                    }
                });
            }

            // On Windows/Linux, remove decorations for custom titlebar.
            // macOS uses titleBarStyle: "overlay" from config instead, which
            // preserves native event routing in WKWebView.
            #[cfg(not(target_os = "macos"))]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(false);
                }
            }

            // The window is created hidden (tauri.conf.json). With --hidden the front end leaves it so
            // (`started_hidden`); otherwise it shows it once startup finishes.
            Ok(())
        })
        .on_window_event(|window, event| {
            // The red button hides the window. The app stays in the Dock.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // A Dock click asks to reopen. With the window hidden, nothing else shows it.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_main(app),
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Ready => request_badge_authorization(),
            _ => {
                let _ = app;
            }
        });

    log::info!("Tauri application exited normally");
}
