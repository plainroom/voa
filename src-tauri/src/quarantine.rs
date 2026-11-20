//! Marks an attachment written to disk as downloaded from the internet, so Gatekeeper checks it
//! the way it checks a file a browser saved.

use std::path::{Path, PathBuf};

/// The folder `openAttachment` writes to (the fs and opener scopes allow only this one).
fn attachments_dir() -> PathBuf {
    std::env::temp_dir().join("voa")
}

/// `path` resolved, when it is inside the attachments folder.
fn inside_attachments(path: &Path) -> Result<PathBuf, String> {
    let dir = attachments_dir().canonicalize().map_err(|e| e.to_string())?;
    let file = path.canonicalize().map_err(|e| e.to_string())?;
    if file.starts_with(&dir) && file != dir {
        Ok(file)
    } else {
        Err("Not an attachment file".into())
    }
}

/// `com.apple.quarantine`'s value: flags, the time in hex seconds, the agent that downloaded it.
fn quarantine_value(unix_secs: u64) -> String {
    format!("0081;{unix_secs:x};voa;")
}

#[cfg(target_os = "macos")]
fn set_quarantine(file: &Path, value: &str) -> Result<(), String> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let path = CString::new(file.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let name = CString::new("com.apple.quarantine").expect("no nul");
    // SAFETY: both strings are nul-terminated and outlive the call; the value pointer and length match.
    let rc = unsafe {
        libc::setxattr(
            path.as_ptr(),
            name.as_ptr(),
            value.as_ptr() as *const libc::c_void,
            value.len(),
            0,
            0,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn set_quarantine(_file: &Path, _value: &str) -> Result<(), String> {
    Ok(())
}

/// Sets `com.apple.quarantine` on a file in the attachments folder (macOS; elsewhere nothing).
#[tauri::command]
pub fn quarantine_file(path: String) -> Result<(), String> {
    let file = inside_attachments(Path::new(&path))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    set_quarantine(&file, &quarantine_value(now))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_has_flags_hex_time_and_agent() {
        assert_eq!(quarantine_value(0x6731_2a00), "0081;67312a00;voa;");
    }

    #[test]
    fn refuses_a_file_outside_the_attachments_folder() {
        let outside = std::env::temp_dir().join("voa-quarantine-test-outside");
        std::fs::write(&outside, b"x").unwrap();
        assert!(quarantine_file(outside.to_string_lossy().into()).is_err());
        let _ = std::fs::remove_file(outside);
    }

    #[test]
    fn marks_a_file_inside_it() {
        let dir = attachments_dir().join("quarantine-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.pdf");
        std::fs::write(&file, b"x").unwrap();
        assert!(quarantine_file(file.to_string_lossy().into()).is_ok());
        #[cfg(target_os = "macos")]
        {
            let out = std::process::Command::new("xattr").args(["-p", "com.apple.quarantine"]).arg(&file).output().unwrap();
            assert!(String::from_utf8_lossy(&out.stdout).starts_with("0081;"));
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
