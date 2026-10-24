//! User preferences: app-wide "Preferences" and per-cluster "Settings".
//! Stored as one JSON file in the app config dir; per-cluster entries are keyed
//! by context id (`<kubeconfig file>#<context>`).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use kube::config::Kubeconfig;
use serde::{Deserialize, Serialize};
use serde_yaml_ng::Value as Yaml;
use tauri::{AppHandle, Manager, State};

use crate::error::{Error, Result};
use crate::state::AppState;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct AppPrefs {
    /// "dark" | "light" | "system"
    pub theme: String,
    /// Reopen the last cluster on start.
    pub reconnect_last: bool,
    /// Shell for the cluster terminal; empty = `$SHELL`.
    pub shell: String,
    pub terminal_font_size: u16,
    pub terminal_font_family: String,
    pub terminal_copy_on_select: bool,
    pub editor_font_size: u16,
    pub editor_tab_size: u16,
    pub editor_line_wrap: bool,
    /// Lines of history loaded when opening logs.
    pub log_tail_lines: u32,
    /// helm binary; empty = found in PATH.
    pub helm_path: String,
    /// Default proxy for API server connections (a cluster's own proxy wins).
    pub http_proxy: String,
    /// Skip TLS verification of API servers.
    pub allow_untrusted_ca: bool,
}

impl Default for AppPrefs {
    fn default() -> Self {
        Self {
            theme: "dark".into(),
            reconnect_last: true,
            shell: String::new(),
            terminal_font_size: 13,
            terminal_font_family: String::new(),
            terminal_copy_on_select: false,
            editor_font_size: 12,
            editor_tab_size: 2,
            editor_line_wrap: false,
            log_tail_lines: 1000,
            helm_path: String::new(),
            http_proxy: String::new(),
            allow_untrusted_ca: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ClusterPrefs {
    /// Display name in the catalog and hotbar.
    pub name: Option<String>,
    /// Icon background color (CSS color).
    pub color: Option<String>,
    /// Icon text (1-3 characters).
    pub icon: Option<String>,
    /// Icon picture as a `data:` URL (shown instead of the text).
    pub icon_image: Option<String>,
    pub hide_from_hotbar: bool,
    /// HTTP or SOCKS5 proxy for the API server connection.
    pub http_proxy: Option<String>,
    /// Namespace the cluster terminal (kubectl, helm) starts in.
    pub terminal_namespace: Option<String>,
    pub terminal_cwd: Option<String>,
    /// Namespaces to offer when listing namespaces is forbidden.
    pub accessible_namespaces: Vec<String>,
    /// "auto" | "manual" | "off"
    pub prometheus_mode: Option<String>,
    /// `<namespace>/<service>:<port>`
    pub prometheus_service: Option<String>,
    /// Path prefix in front of `/api/v1/...` (e.g. `/prometheus`).
    pub prometheus_prefix: Option<String>,
    /// Hidden chart groups: "cluster", "node", "pod".
    pub hidden_metrics: Vec<String>,
    pub node_shell_image: Option<String>,
    pub node_shell_pull_secret: Option<String>,
    /// Cost source: "auto" | "kubecost" | "opencost" | "estimated" | "off".
    pub cost_source: Option<String>,
    /// `<namespace>/<service>:<port>` of the chosen cost backend, when detection can't find it.
    pub cost_address: Option<String>,
    /// Estimate rates: price of a core-hour and a GiB-hour, in `cost_currency`.
    pub cost_cpu_rate: Option<f64>,
    pub cost_ram_rate: Option<f64>,
    /// Discount of spot / preemptible nodes, 0..1.
    pub cost_spot_discount: Option<f64>,
    /// ISO currency code of the estimate rates (USD by default).
    pub cost_currency: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    pub app: AppPrefs,
    pub clusters: BTreeMap<String, ClusterPrefs>,
}

fn other(e: impl std::fmt::Display) -> Error {
    Error::Other(e.to_string())
}

fn prefs_file(app: &AppHandle) -> Result<PathBuf> {
    Ok(app.path().app_config_dir().map_err(other)?.join("preferences.json"))
}

pub fn load(app: &AppHandle) -> Prefs {
    prefs_file(app)
        .ok()
        .and_then(|p| fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn store(app: &AppHandle, prefs: &Prefs) -> Result<()> {
    let path = prefs_file(app)?;
    fs::create_dir_all(path.parent().unwrap()).map_err(other)?;
    fs::write(path, serde_json::to_vec_pretty(prefs).map_err(other)?).map_err(other)
}

pub fn cluster(app: &AppHandle, id: &str) -> ClusterPrefs {
    load(app).clusters.remove(id).unwrap_or_default()
}

#[tauri::command]
pub fn get_prefs(app: AppHandle) -> Prefs {
    load(&app)
}

#[tauri::command]
pub fn save_app_prefs(app: AppHandle, prefs: AppPrefs) -> Result<()> {
    if !prefs.http_proxy.trim().is_empty() {
        prefs.http_proxy.trim().parse::<http::Uri>().map_err(|e| Error::Other(format!("proxy URL: {e}")))?;
    }
    let mut all = load(&app);
    all.app = prefs;
    store(&app, &all)
}

#[tauri::command]
pub fn save_cluster_prefs(app: AppHandle, state: State<'_, AppState>, id: String, prefs: ClusterPrefs) -> Result<()> {
    if let Some(proxy) = prefs.http_proxy.as_deref().filter(|p| !p.is_empty()) {
        proxy.parse::<http::Uri>().map_err(|e| Error::Other(format!("proxy URL: {e}")))?;
    }
    if prefs.prometheus_mode.as_deref() == Some("manual") {
        parse_service(prefs.prometheus_service.as_deref().unwrap_or_default())?;
    }
    let mut all = load(&app);
    all.clusters.insert(id.clone(), prefs.clone());
    store(&app, &all)?;

    // Apply to the live connection where it doesn't require reconnecting.
    let _ = state.with_cluster(&id, |c| {
        c.prefs = prefs;
        c.prometheus = None;
    });
    Ok(())
}

const MAX_ICON_BYTES: u64 = 512 * 1024;

/// Reads a picture for a cluster icon and returns it as a `data:` URL.
#[tauri::command]
pub fn load_icon_image(path: String) -> Result<String> {
    use base64::Engine;
    let ext = Path::new(&path).extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => return Err(Error::Other("pick a PNG, JPEG, GIF, WebP or SVG image".into())),
    };
    if fs::metadata(&path).map_err(other)?.len() > MAX_ICON_BYTES {
        return Err(Error::Other("image is larger than 512 KB".into()));
    }
    let bytes = fs::read(&path).map_err(other)?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Writes an export (CSV) to the file the user picked in the save dialog.
#[tauri::command]
pub fn save_text_file(path: String, contents: String) -> Result<()> {
    fs::write(&path, contents).map_err(|e| Error::Other(format!("{path}: {e}")))
}

/// Parses `<namespace>/<service>:<port>`.
pub fn parse_service(s: &str) -> Result<(String, String, i32)> {
    let bad = || Error::Other(format!("Prometheus service must look like <namespace>/<service>:<port>, got {s:?}"));
    let (ns, rest) = s.trim().split_once('/').ok_or_else(bad)?;
    let (svc, port) = rest.rsplit_once(':').ok_or_else(bad)?;
    let port = port.parse().map_err(|_| bad())?;
    if ns.is_empty() || svc.is_empty() {
        return Err(bad());
    }
    Ok((ns.into(), svc.into(), port))
}

// --- kubeconfig editing -----------------------------------------------------

/// Only files that currently provide a cluster in the catalog may be edited.
fn ensure_known(app: &AppHandle, file: &str) -> Result<()> {
    let catalog = crate::kubeconfigs::list_contexts(app.clone())?;
    if catalog.has_file(file) {
        Ok(())
    } else {
        Err(Error::Other(format!("{file} is not a kubeconfig known to Bens")))
    }
}

fn backup(path: &Path) -> Result<()> {
    let mut bak = path.as_os_str().to_owned();
    bak.push(".bens-backup");
    fs::copy(path, PathBuf::from(bak)).map(|_| ()).map_err(other)
}

#[tauri::command]
pub fn read_kubeconfig(app: AppHandle, file: String) -> Result<String> {
    ensure_known(&app, &file)?;
    fs::read_to_string(&file).map_err(other)
}

/// Overwrites a kubeconfig after validating it; the previous version is kept
/// next to it as `<file>.bens-backup`.
#[tauri::command]
pub fn write_kubeconfig(app: AppHandle, file: String, yaml: String) -> Result<()> {
    ensure_known(&app, &file)?;
    Kubeconfig::from_yaml(&yaml)?;
    let path = PathBuf::from(&file);
    backup(&path)?;
    fs::write(&path, yaml).map_err(other)
}

/// Removes a context from its kubeconfig, plus its cluster and user entries if
/// no other context uses them (like `kubectl config delete-context` followed by
/// cleanup). A pasted kubeconfig left without contexts is deleted.
#[tauri::command]
pub fn delete_context(app: AppHandle, file: String, context: String) -> Result<()> {
    ensure_known(&app, &file)?;
    let path = PathBuf::from(&file);
    let mut doc: Yaml = serde_yaml_ng::from_str(&fs::read_to_string(&path).map_err(other)?)?;
    let removed = remove_context(&mut doc, &context)?;
    if !removed {
        return Err(Error::Other(format!("context {context} not found in {file}")));
    }

    let empty = doc.get("contexts").and_then(Yaml::as_sequence).is_none_or(|s| s.is_empty());
    if empty && path.parent() == Some(crate::kubeconfigs::pasted_dir(&app)?.as_path()) {
        fs::remove_file(&path).map_err(other)?;
    } else {
        backup(&path)?;
        fs::write(&path, serde_yaml_ng::to_string(&doc)?).map_err(other)?;
    }
    let mut all = load(&app);
    if all.clusters.remove(&format!("{file}#{context}")).is_some() {
        store(&app, &all)?;
    }
    Ok(())
}

fn named<'a>(doc: &'a mut Yaml, key: &str) -> Option<&'a mut Vec<Yaml>> {
    doc.get_mut(key).and_then(Yaml::as_sequence_mut)
}

fn remove_context(doc: &mut Yaml, context: &str) -> Result<bool> {
    let Some(contexts) = named(doc, "contexts") else { return Ok(false) };
    let Some(idx) = contexts.iter().position(|c| c.get("name").and_then(Yaml::as_str) == Some(context)) else {
        return Ok(false);
    };
    let entry = contexts.remove(idx);
    let field = |f: &str| entry.get("context").and_then(|c| c.get(f)).and_then(Yaml::as_str).map(String::from);
    let (cluster, user) = (field("cluster"), field("user"));
    let still_used = |doc: &Yaml, f: &str, v: &str| {
        doc.get("contexts")
            .and_then(Yaml::as_sequence)
            .into_iter()
            .flatten()
            .any(|c| c.get("context").and_then(|c| c.get(f)).and_then(Yaml::as_str) == Some(v))
    };
    for (list, f, value) in [("clusters", "cluster", cluster), ("users", "user", user)] {
        let Some(value) = value else { continue };
        if still_used(doc, f, &value) {
            continue;
        }
        if let Some(items) = named(doc, list) {
            items.retain(|i| i.get("name").and_then(Yaml::as_str) != Some(value.as_str()));
        }
    }
    if doc.get("current-context").and_then(Yaml::as_str) == Some(context) {
        if let Some(map) = doc.as_mapping_mut() {
            map.insert("current-context".into(), Yaml::String(String::new()));
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_context_and_unused_entries() {
        let mut doc: Yaml = serde_yaml_ng::from_str(
            r#"
apiVersion: v1
kind: Config
current-context: a
clusters: [{name: c1, cluster: {server: "https://1"}}, {name: c2, cluster: {server: "https://2"}}]
users: [{name: u1, user: {}}, {name: u2, user: {}}]
contexts:
- {name: a, context: {cluster: c1, user: u1}}
- {name: b, context: {cluster: c2, user: u1}}
"#,
        )
        .unwrap();
        assert!(remove_context(&mut doc, "a").unwrap());
        let names = |k: &str| -> Vec<String> {
            doc[k].as_sequence().unwrap().iter().map(|i| i["name"].as_str().unwrap().to_string()).collect()
        };
        assert_eq!(names("contexts"), ["b"]);
        assert_eq!(names("clusters"), ["c2"]);
        assert_eq!(names("users"), ["u1", "u2"]); // u1 still used by b; u2 untouched
        assert_eq!(doc["current-context"].as_str(), Some(""));
        assert_eq!(parse_service("monitoring/prom:9090").unwrap().2, 9090);
    }
}
