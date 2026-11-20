use std::{env, fs, path::Path, process::Command};

fn main() {
  ai_bridge();
  tauri_build::build()
}

/// Builds `voa-ai` (ai/main.swift, Apple's on-device model) where Tauri bundles it from:
/// binaries/voa-ai-<target> (`externalBin` in tauri.macos.conf.json). Without a Swift that
/// has FoundationModels, it writes a stand-in that says the model is unavailable, so the build
/// never fails over it and the app just goes without them.
fn ai_bridge() {
  let target = env::var("TARGET").unwrap();
  if !target.contains("apple-darwin") {
    return;
  }
  println!("cargo:rerun-if-changed=ai/main.swift");
  fs::create_dir_all("binaries").unwrap();
  let out = format!("binaries/voa-ai-{target}");
  let arch = if target.starts_with("aarch64") { "arm64" } else { "x86_64" };
  let built = Command::new("swiftc")
    .args(["-O", "-parse-as-library", "-target", &format!("{arch}-apple-macos26"), "ai/main.swift", "-o", &out])
    .status()
    .map(|s| s.success())
    .unwrap_or(false);
  if !built {
    println!("cargo:warning=voa-ai not built (no Swift with FoundationModels): Apple Intelligence features are off");
    fs::write(&out, "#!/bin/sh\necho '{\"unavailable\": true}'\n").unwrap();
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      fs::set_permissions(Path::new(&out), fs::Permissions::from_mode(0o755)).unwrap();
    }
  }
}
