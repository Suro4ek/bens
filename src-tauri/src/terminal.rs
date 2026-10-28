//! Local shell bound to the connected cluster (the cluster terminal):
//! `kubectl`, `helm`, `k9s`... started from it talk to the selected context.

use std::io::{Read, Write};
use std::path::PathBuf;

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::error::{Error, Result};
use crate::pods::ExecEvent;
use crate::state::AppState;

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl PtySession {
    pub fn write(&mut self, data: &[u8]) {
        let _ = self.writer.write_all(data);
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let _ = self.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }

    pub fn kill(&mut self) {
        let _ = self.child.kill();
    }
}

fn other(e: impl std::fmt::Display) -> Error {
    Error::Other(e.to_string())
}

/// The overlay's file name: one per cluster (catalog id), not per context name. Two
/// kubeconfigs can both have a context called `default`, and a terminal reads the
/// overlay on every `kubectl` call, so a shared file would point it at the other cluster.
fn overlay_name(cluster: &str, context: &str) -> String {
    let safe: String = context.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
    // FNV-1a: stable across runs and Rust versions, unlike DefaultHasher.
    let hash = cluster.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3));
    format!("{safe}-{hash:016x}.yaml")
}

/// kubectl merges `KUBECONFIG` files and the first one to set `current-context`
/// (or define a context or a cluster) wins, so a tiny overlay in front pins the context,
/// optionally its namespace, and the server of a cluster reached through an SSH tunnel,
/// without touching the user's kubeconfig.
pub fn overlay_yaml(context: &str, file: &str, namespace: Option<&str>, tunnel: Option<&(String, String)>) -> Result<String> {
    let mut overlay = serde_json::json!({ "apiVersion": "v1", "kind": "Config", "current-context": context });
    if namespace.is_some() || tunnel.is_some() {
        // read_from makes certificate paths absolute: they stay valid from the overlay.
        if let Ok(kc) = kube::config::Kubeconfig::read_from(file) {
            if let Some(c) = kc.contexts.into_iter().find(|c| c.name == context).and_then(|c| c.context) {
                if let Some(ns) = namespace {
                    overlay["contexts"] = serde_json::json!([{
                        "name": context,
                        "context": { "cluster": c.cluster, "user": c.user.unwrap_or_default(), "namespace": ns }
                    }]);
                }
                let entry = kc.clusters.into_iter().find(|n| n.name == c.cluster).and_then(|n| n.cluster);
                if let (Some((server, name)), Some(mut entry)) = (tunnel, entry) {
                    entry.server = Some(server.clone());
                    entry.tls_server_name.get_or_insert_with(|| name.clone());
                    overlay["clusters"] = serde_json::json!([{ "name": c.cluster, "cluster": entry }]);
                }
            }
        }
    }
    Ok(serde_yaml_ng::to_string(&overlay)?)
}

fn context_overlay(
    app: &AppHandle,
    cluster: &str,
    context: &str,
    file: &str,
    namespace: Option<&str>,
    tunnel: Option<&(String, String)>,
) -> Result<PathBuf> {
    let dir = app.path().app_data_dir().map_err(other)?.join("shell");
    std::fs::create_dir_all(&dir).map_err(other)?;
    let path = dir.join(overlay_name(cluster, context));
    std::fs::write(&path, overlay_yaml(context, file, namespace, tunnel)?).map_err(other)?;
    Ok(path)
}

/// `KUBECONFIG` value that points CLI tools at a connected cluster.
pub fn cluster_kubeconfig_env(app: &AppHandle, state: &AppState, cluster: &str) -> Result<std::ffi::OsString> {
    let (context, file, namespace, tunnel) = state.with_cluster(cluster, |c| {
        (
            c.context.clone(),
            c.kubeconfig_file.clone(),
            c.prefs.terminal_namespace.clone().filter(|n| !n.trim().is_empty()),
            c.tunnel.as_ref().and_then(|t| t.server.clone()),
        )
    })?;
    let overlay = context_overlay(app, cluster, &context, &file, namespace.as_deref(), tunnel.as_ref())?;
    std::env::join_paths([overlay, PathBuf::from(file)]).map_err(other)
}

#[tauri::command]
pub async fn local_terminal_start(
    app: AppHandle,
    state: State<'_, AppState>,
    cluster: String,
    session_id: String,
    cols: u16,
    rows: u16,
    on_event: Channel<ExecEvent>,
) -> Result<()> {
    let kubeconfig = cluster_kubeconfig_env(&app, &state, &cluster)?;

    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(other)?;
    let shell = crate::prefs::load(&app).app.shell;
    let shell = if shell.trim().is_empty() { default_shell() } else { shell };
    let mut cmd = CommandBuilder::new(&shell);
    // A login shell, so the user's profile (PATH, aliases, prompt) is loaded.
    if cfg!(unix) {
        cmd.arg("-l");
    }
    let home = crate::kubeconfigs::home().to_string_lossy().into_owned();
    let cwd = state.prefs(&cluster)?.terminal_cwd.filter(|d| !d.trim().is_empty());
    let cwd = match cwd {
        Some(d) if d == "~" => home.clone(),
        Some(d) => d.strip_prefix("~/").map(|r| format!("{home}/{r}")).unwrap_or(d),
        None => home,
    };
    if std::path::Path::new(&cwd).is_dir() {
        cmd.cwd(cwd);
    }
    cmd.env("KUBECONFIG", kubeconfig);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Bens");

    let child = pair.slave.spawn_command(cmd).map_err(other)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(other)?;
    let writer = pair.master.take_writer().map_err(other)?;

    std::thread::spawn(move || {
        let b64 = base64::engine::general_purpose::STANDARD;
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if on_event.send(ExecEvent::Data { data: b64.encode(&buf[..n]) }).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = on_event.send(ExecEvent::Exit { message: None });
    });

    state
        .0
        .lock()
        .unwrap()
        .ptys
        .insert(session_id, (cluster, PtySession { master: pair.master, writer, child }));
    Ok(())
}

fn default_shell() -> String {
    if cfg!(windows) {
        "powershell.exe".into()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/bash" }.into())
    }
}

#[cfg(test)]
mod tests {
    use super::overlay_name;

    #[test]
    fn overlays_are_per_cluster() {
        let a = overlay_name("/home/me/.kube/a.yaml#default", "default");
        let b = overlay_name("/home/me/.kube/b.yaml#default", "default");
        assert_ne!(a, b);
        assert_eq!(a, overlay_name("/home/me/.kube/a.yaml#default", "default"));
        assert!(a.starts_with("default-") && a.ends_with(".yaml"));
        // Contexts that only differ in punctuation don't collide either.
        assert_ne!(overlay_name("f#yc-prod", "yc-prod"), overlay_name("f#yc_prod", "yc_prod"));
    }
}
