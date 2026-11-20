//! Runs `voa-ai` (Apple's on-device model, see ai/main.swift) on one request.

use std::{process::Stdio, time::Duration};
use tokio::{io::AsyncWriteExt, process::Command};

/// `request` is the bridge's JSON (instructions, schema, input); the answer is its JSON, unchecked:
/// the app checks it. `{"unavailable": true}` when the Mac has no model.
#[tauri::command]
pub async fn ai_ask(request: String) -> Result<String, String> {
    // Tauri puts an externalBin next to the app's own executable, without its target suffix.
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut child = Command::new(exe.with_file_name("voa-ai"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("voa-ai: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("voa-ai: no stdin")?;
    stdin.write_all(request.as_bytes()).await.map_err(|e| e.to_string())?;
    drop(stdin);
    let out = tokio::time::timeout(Duration::from_secs(60), child.wait_with_output())
        .await
        .map_err(|_| "voa-ai: timed out".to_string())?
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("voa-ai: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The microphone, while the copilot listens: closing its stdin ends it.
#[derive(Default)]
pub struct Listening(tokio::sync::Mutex<Option<tokio::process::ChildStdin>>);

/// Starts `voa-ai listen` and passes each line it prints (level, text so far, done, why) to `lines`.
#[tauri::command]
pub async fn listen_start(state: tauri::State<'_, Listening>, lines: tauri::ipc::Channel<String>) -> Result<(), String> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut child = Command::new(exe.with_file_name("voa-ai"))
        .arg("listen")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("voa-ai: {e}"))?;
    let stdin = child.stdin.take().ok_or("voa-ai: no stdin")?;
    let mut out = BufReader::new(child.stdout.take().ok_or("voa-ai: no stdout")?).lines();
    // A new start ends the one before it (its stdin dropped).
    *state.0.lock().await = Some(stdin);
    tauri::async_runtime::spawn(async move {
        while let Ok(Some(line)) = out.next_line().await {
            let _ = lines.send(line);
        }
        let _ = child.wait().await;
        // Its last word, after `done` or `why` (then not read) or in their place when it failed.
        let _ = lines.send(r#"{"why":"ended"}"#.to_string());
    });
    Ok(())
}

/// Stops listening: the helper finishes the text and prints it as `done`.
#[tauri::command]
pub async fn listen_stop(state: tauri::State<'_, Listening>) -> Result<(), String> {
    state.0.lock().await.take();
    Ok(())
}
