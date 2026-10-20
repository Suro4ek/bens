//! GUI apps on macOS/Linux start with a minimal PATH, so kubeconfig exec plugins
//! (aws, gcloud, yc, kubelogin, ...) would not be found. We ask the
//! user's login shell for its PATH once at startup.

#[cfg(unix)]
pub fn sync_path_from_login_shell() {
    use std::process::Command;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let marker = "__BENS_PATH__";
    let out = Command::new(&shell)
        .args(["-ilc", &format!("printf '{marker}%s{marker}' \"$PATH\"")])
        .output();
    let Ok(out) = out else { return };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut parts = text.split(marker);
    if let (Some(_), Some(path)) = (parts.next(), parts.next()) {
        if !path.is_empty() {
            std::env::set_var("PATH", path);
        }
    }
}

#[cfg(not(unix))]
pub fn sync_path_from_login_shell() {}
