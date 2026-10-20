//! Where clusters come from: a list of synced kubeconfig files or
//! folders (default `~/.kube`), plus kubeconfigs pasted into the app, which are
//! stored under the app data dir.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use kube::config::Kubeconfig;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};

/// Files bigger than this in a synced folder are not kubeconfigs.
const MAX_KUBECONFIG_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Settings {
    sync_paths: Vec<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextInfo {
    /// Unique across sources: `<file>#<context>`.
    id: String,
    name: String,
    file: String,
    cluster: String,
    user: String,
    namespace: Option<String>,
    server: Option<String>,
    /// Pasted into the app; removing it deletes the stored file.
    pasted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    path: String,
    kind: &'static str,
    exists: bool,
    contexts: usize,
    errors: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    current: Option<String>,
    sources: Vec<SourceInfo>,
    contexts: Vec<ContextInfo>,
}

impl Catalog {
    pub fn has_file(&self, file: &str) -> bool {
        self.contexts.iter().any(|c| c.file == file)
    }
}

/// The user's home folder (`USERPROFILE` on Windows).
pub fn home() -> PathBuf {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default()
}

fn settings_file(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_config_dir().map_err(|e| Error::Other(e.to_string()))?;
    Ok(dir.join("settings.json"))
}

pub fn pasted_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_data_dir().map_err(|e| Error::Other(e.to_string()))?;
    Ok(dir.join("kubeconfigs"))
}

fn load_settings(app: &AppHandle) -> Result<Settings> {
    match fs::read(settings_file(app)?) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| Error::Other(format!("settings: {e}"))),
        Err(_) => Ok(Settings { sync_paths: vec![home().join(".kube")] }),
    }
}

fn save_settings(app: &AppHandle, settings: &Settings) -> Result<()> {
    let path = settings_file(app)?;
    fs::create_dir_all(path.parent().unwrap()).map_err(io)?;
    let json = serde_json::to_vec_pretty(settings).map_err(|e| Error::Other(e.to_string()))?;
    fs::write(path, json).map_err(io)
}

fn io(e: std::io::Error) -> Error {
    Error::Other(e.to_string())
}

fn expand_tilde(p: &str) -> PathBuf {
    match p.strip_prefix("~/") {
        Some(rest) => home().join(rest),
        None if p == "~" => home(),
        None => PathBuf::from(p),
    }
}

/// Kubeconfig candidates inside a synced folder (non-recursive).
fn files_in(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = fs::read_dir(dir) else { return vec![] };
    let mut files: Vec<PathBuf> = rd
        .flatten()
        .filter(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            // Dotfiles and backups Bens writes next to edited kubeconfigs.
            !name.starts_with('.') && !name.ends_with(".bens-backup")
        })
        .filter(|e| e.metadata().map(|m| m.is_file() && m.len() <= MAX_KUBECONFIG_BYTES).unwrap_or(false))
        .map(|e| e.path())
        .collect();
    files.sort();
    files
}

fn contexts_of(file: &Path, kc: &Kubeconfig, pasted: bool) -> Vec<ContextInfo> {
    kc.contexts
        .iter()
        .map(|nc| {
            let ctx = nc.context.clone().unwrap_or_default();
            let server = kc
                .clusters
                .iter()
                .find(|c| c.name == ctx.cluster)
                .and_then(|c| c.cluster.as_ref())
                .and_then(|c| c.server.clone());
            ContextInfo {
                id: format!("{}#{}", file.display(), nc.name),
                name: nc.name.clone(),
                file: file.display().to_string(),
                cluster: ctx.cluster,
                user: ctx.user.unwrap_or_default(),
                namespace: ctx.namespace,
                server,
                pasted,
            }
        })
        .collect()
}

#[tauri::command]
pub fn list_contexts(app: AppHandle) -> Result<Catalog> {
    let settings = load_settings(&app)?;
    let pasted = pasted_dir(&app)?;

    let mut roots: Vec<(PathBuf, &'static str)> =
        settings.sync_paths.iter().map(|p| (p.clone(), "sync")).collect();
    if let Some(env) = std::env::var_os("KUBECONFIG") {
        roots.extend(std::env::split_paths(&env).map(|p| (p, "env")));
    }
    roots.push((pasted.clone(), "pasted"));

    let mut seen = BTreeSet::new();
    let mut sources = Vec::new();
    let mut contexts = Vec::new();
    for (root, kind) in roots {
        let exists = root.exists();
        let files = if root.is_dir() { files_in(&root) } else if exists { vec![root.clone()] } else { vec![] };
        let mut found = 0;
        let mut errors = Vec::new();
        for file in files {
            let file = file.canonicalize().unwrap_or(file);
            if !seen.insert(file.clone()) {
                continue;
            }
            match Kubeconfig::read_from(&file) {
                Ok(kc) => {
                    let ctxs = contexts_of(&file, &kc, kind == "pasted");
                    found += ctxs.len();
                    contexts.extend(ctxs);
                }
                // In a folder, non-kubeconfig files are expected; only report explicit files.
                Err(e) if !root.is_dir() => errors.push(e.to_string()),
                Err(_) => {}
            }
        }
        if kind == "pasted" && !exists {
            continue;
        }
        sources.push(SourceInfo { path: root.display().to_string(), kind, exists, contexts: found, errors });
    }

    let current = Kubeconfig::read_from(home().join(".kube/config")).ok().and_then(|kc| kc.current_context);
    Ok(Catalog { current, sources, contexts })
}

/// Saves a pasted kubeconfig into the app's own folder.
#[tauri::command]
pub fn add_kubeconfig_text(app: AppHandle, yaml: String) -> Result<usize> {
    let kc = Kubeconfig::from_yaml(&yaml)?;
    let Some(first) = kc.contexts.first() else {
        return Err(Error::Other("kubeconfig has no contexts".into()));
    };
    let stem: String = first
        .name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();

    let dir = pasted_dir(&app)?;
    fs::create_dir_all(&dir).map_err(io)?;
    let path = dir.join(format!("{stem}-{ts}.yaml"));
    fs::write(&path, yaml).map_err(io)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(kc.contexts.len())
}

/// Adds a kubeconfig file or a folder of kubeconfigs to sync.
#[tauri::command]
pub fn add_kubeconfig_path(app: AppHandle, path: String) -> Result<()> {
    let path = expand_tilde(path.trim());
    if !path.exists() {
        return Err(Error::Other(format!("{} does not exist", path.display())));
    }
    if path.is_file() {
        Kubeconfig::read_from(&path)?;
    }
    let mut settings = load_settings(&app)?;
    if !settings.sync_paths.contains(&path) {
        settings.sync_paths.push(path);
    }
    save_settings(&app, &settings)
}

/// Stops syncing a path, or deletes a pasted kubeconfig file.
#[tauri::command]
pub fn remove_kubeconfig_source(app: AppHandle, path: String) -> Result<()> {
    let path = PathBuf::from(path);
    let pasted = pasted_dir(&app)?;
    if path.parent() == Some(pasted.as_path()) {
        return fs::remove_file(&path).map_err(io);
    }
    let mut settings = load_settings(&app)?;
    settings.sync_paths.retain(|p| p != &path);
    save_settings(&app, &settings)
}
