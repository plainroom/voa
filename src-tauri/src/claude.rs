//! The owner's own Claude Code, as the writing copilot: voa has no model key of its own. Each draft gets one
//! `claude` process, kept open while the draft is (a fresh one takes about 9 s to answer, an open one 2 to 3 s), so
//! a request can build on the ones before it. It runs with no tools, no MCP servers, no settings or skills: it reads
//! what the app sends and answers text, nothing else.

use std::{collections::HashMap, path::PathBuf, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
};

struct Session {
    _child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
}

/// The open sessions; each has its own lock, so one draft's request never waits on another's.
#[derive(Default)]
pub struct Claude {
    sessions: Mutex<HashMap<String, Arc<Mutex<Session>>>>,
}

/// Where `claude` is: the app does not get the owner's shell PATH (nvm, Homebrew), so their login shell is asked.
/// A few seconds at most: a shell profile that waits for input must not hold the app.
async fn find() -> Option<PathBuf> {
    let shell = Command::new("/bin/zsh").args(["-lic", "command -v claude"]).stdin(Stdio::null()).kill_on_drop(true).output();
    let out = tokio::time::timeout(Duration::from_secs(5), shell).await.ok()?.ok()?;
    // An interactive shell may print its own lines first: the path is the last one.
    let text = String::from_utf8_lossy(&out.stdout);
    let path = PathBuf::from(text.lines().rev().find(|l| l.starts_with('/'))?.trim());
    path.exists().then_some(path)
}

/// The installed Claude Code's version, or None when there is none.
#[tauri::command]
pub async fn claude_version() -> Option<String> {
    let out = Command::new(find().await?).arg("--version").stdin(Stdio::null()).output().await.ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Opens the draft's session with the app's instructions; a session already open is kept.
#[tauri::command]
pub async fn claude_open(state: tauri::State<'_, Claude>, app: tauri::AppHandle, id: String, instructions: String) -> Result<(), String> {
    use tauri::Manager;
    let mut sessions = state.sessions.lock().await;
    if sessions.contains_key(&id) {
        return Ok(());
    }
    let claude = find().await.ok_or("Claude Code is not installed")?;
    // An empty folder of its own: no project's CLAUDE.md or settings come with it.
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("claude");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let none = dir.join("no-mcp.json");
    std::fs::write(&none, r#"{"mcpServers":{}}"#).map_err(|e| e.to_string())?;
    let mut child = Command::new(claude)
        .current_dir(&dir)
        .args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--tools", ""])
        .args(["--setting-sources", "", "--strict-mcp-config", "--mcp-config"])
        .arg(&none)
        .args(["--disable-slash-commands", "--no-session-persistence", "--model", "haiku", "--system-prompt", &instructions])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("claude: {e}"))?;
    let stdin = child.stdin.take().ok_or("claude: no stdin")?;
    let lines = BufReader::new(child.stdout.take().ok_or("claude: no stdout")?).lines();
    sessions.insert(id, Arc::new(Mutex::new(Session { _child: child, stdin, lines })));
    Ok(())
}

/// Sends one message to the draft's session and waits for Claude's answer.
#[tauri::command]
pub async fn claude_ask(state: tauri::State<'_, Claude>, id: String, text: String) -> Result<String, String> {
    let session = state.sessions.lock().await.get(&id).cloned().ok_or("claude: no session")?;
    let mut session = session.lock().await;
    let session = &mut *session;
    let message = serde_json::json!({ "type": "user", "message": { "role": "user", "content": text } });
    let sent = async {
        session.stdin.write_all(format!("{message}\n").as_bytes()).await?;
        session.stdin.flush().await
    };
    if let Err(e) = sent.await {
        state.sessions.lock().await.remove(&id);
        return Err(format!("claude: {e}"));
    }
    let answer = tokio::time::timeout(Duration::from_secs(120), async {
        while let Some(line) = session.lines.next_line().await.map_err(|e| e.to_string())? {
            let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            if event["type"] == "result" {
                if event["is_error"] == true {
                    return Err(event["result"].as_str().unwrap_or("Claude could not answer").to_string());
                }
                return Ok(event["result"].as_str().unwrap_or_default().to_string());
            }
        }
        Err("Claude stopped".to_string())
    })
    .await
    .unwrap_or_else(|_| Err("Claude took too long".to_string()));
    // A session that failed is closed: the next request opens a fresh one.
    if answer.is_err() {
        state.sessions.lock().await.remove(&id);
    }
    answer
}

/// Closes the draft's session (the draft was sent, discarded or left).
#[tauri::command]
pub async fn claude_close(state: tauri::State<'_, Claude>, id: String) -> Result<(), String> {
    state.sessions.lock().await.remove(&id);
    Ok(())
}
