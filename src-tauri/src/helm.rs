//! Helm releases. Reads decode Helm's own storage (Secrets of type
//! `helm.sh/release.v1`: base64 → gzip → JSON), so listing needs no helm binary.
//! Mutations shell out to `helm`.

use std::collections::HashMap;
use std::io::Read;

use base64::Engine;
use k8s_openapi::api::core::v1::Secret;
use kube::api::{Api, ListParams};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::error::{Error, Result};
use crate::state::AppState;
use crate::terminal::cluster_kubeconfig_env;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseSummary {
    name: String,
    namespace: String,
    revision: i64,
    status: String,
    chart: String,
    chart_version: String,
    app_version: String,
    updated: String,
    description: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseDetails {
    summary: ReleaseSummary,
    history: Vec<ReleaseSummary>,
    values: String,
    default_values: String,
    manifest: String,
    notes: String,
}

fn decode(secret: &Secret) -> Option<Value> {
    let raw = &secret.data.as_ref()?.get("release")?.0;
    let gz = base64::engine::general_purpose::STANDARD.decode(raw).ok()?;
    let mut json = Vec::new();
    if gz.starts_with(&[0x1f, 0x8b]) {
        flate2::read::GzDecoder::new(&gz[..]).read_to_end(&mut json).ok()?;
    } else {
        json = gz;
    }
    serde_json::from_slice(&json).ok()
}

fn s(v: &Value, ptr: &str) -> String {
    v.pointer(ptr).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn summary(v: &Value) -> ReleaseSummary {
    ReleaseSummary {
        name: s(v, "/name"),
        namespace: s(v, "/namespace"),
        revision: v.pointer("/version").and_then(Value::as_i64).unwrap_or_default(),
        status: s(v, "/info/status"),
        chart: s(v, "/chart/metadata/name"),
        chart_version: s(v, "/chart/metadata/version"),
        app_version: s(v, "/chart/metadata/appVersion"),
        updated: s(v, "/info/last_deployed"),
        description: s(v, "/info/description"),
    }
}

fn revision_label(secret: &Secret) -> i64 {
    secret
        .metadata
        .labels
        .as_ref()
        .and_then(|l| l.get("version"))
        .and_then(|v| v.parse().ok())
        .unwrap_or_default()
}

fn release_secrets(client: kube::Client, namespace: Option<&str>) -> Api<Secret> {
    match namespace {
        Some(ns) if !ns.is_empty() => Api::namespaced(client, ns),
        _ => Api::all(client),
    }
}

#[tauri::command]
pub async fn helm_list(state: State<'_, AppState>, namespace: Option<String>) -> Result<Vec<ReleaseSummary>> {
    let api = release_secrets(state.client()?, namespace.as_deref());
    let secrets = api.list(&ListParams::default().labels("owner=helm")).await?;

    // Only the newest revision of each release needs decoding.
    let mut latest: HashMap<(String, String), Secret> = HashMap::new();
    for sec in secrets.items {
        let ns = sec.metadata.namespace.clone().unwrap_or_default();
        let name = sec.metadata.labels.as_ref().and_then(|l| l.get("name")).cloned().unwrap_or_default();
        let key = (ns, name);
        if latest.get(&key).is_none_or(|cur| revision_label(cur) < revision_label(&sec)) {
            latest.insert(key, sec);
        }
    }
    let mut list: Vec<ReleaseSummary> = latest.values().filter_map(decode).map(|v| summary(&v)).collect();
    list.sort_by(|a, b| (&a.namespace, &a.name).cmp(&(&b.namespace, &b.name)));
    Ok(list)
}

fn to_yaml(v: Option<&Value>) -> Result<String> {
    match v {
        Some(v) if !v.is_null() && v.as_object().is_none_or(|o| !o.is_empty()) => Ok(serde_yaml_ng::to_string(v)?),
        _ => Ok(String::new()),
    }
}

#[tauri::command]
pub async fn helm_get(state: State<'_, AppState>, namespace: String, name: String) -> Result<ReleaseDetails> {
    let api: Api<Secret> = Api::namespaced(state.client()?, &namespace);
    let secrets = api.list(&ListParams::default().labels(&format!("owner=helm,name={name}"))).await?;
    let mut releases: Vec<Value> = secrets.items.iter().filter_map(decode).collect();
    releases.sort_by_key(|v| std::cmp::Reverse(v.pointer("/version").and_then(Value::as_i64).unwrap_or_default()));
    let latest = releases.first().ok_or_else(|| Error::Other(format!("release {name} not found")))?;

    Ok(ReleaseDetails {
        summary: summary(latest),
        values: to_yaml(latest.get("config"))?,
        default_values: to_yaml(latest.pointer("/chart/values"))?,
        manifest: s(latest, "/manifest"),
        notes: s(latest, "/info/notes"),
        history: releases.iter().map(summary).collect(),
    })
}

async fn run_helm(app: &AppHandle, state: &AppState, args: &[&str]) -> Result<String> {
    let kubeconfig = cluster_kubeconfig_env(app, state)?;
    let helm = crate::prefs::load(app).app.helm_path;
    let helm = if helm.trim().is_empty() { "helm".to_string() } else { helm };
    let out = tokio::process::Command::new(&helm)
        .args(args)
        .env("KUBECONFIG", kubeconfig)
        .output()
        .await
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => Error::Other(format!("{helm} not found (install helm or set its path in Preferences)")),
            _ => Error::Other(e.to_string()),
        })?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(Error::Other(String::from_utf8_lossy(&out.stderr).trim().to_string()))
    }
}

#[tauri::command]
pub async fn helm_rollback(
    app: AppHandle,
    state: State<'_, AppState>,
    namespace: String,
    name: String,
    revision: i64,
) -> Result<String> {
    run_helm(&app, &state, &["rollback", &name, &revision.to_string(), "--namespace", &namespace]).await
}

#[tauri::command]
pub async fn helm_uninstall(app: AppHandle, state: State<'_, AppState>, namespace: String, name: String) -> Result<String> {
    run_helm(&app, &state, &["uninstall", &name, "--namespace", &namespace]).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::ByteString;
    use std::io::Write;

    #[test]
    fn decodes_helm_storage_format() {
        let release = serde_json::json!({
            "name": "web", "namespace": "prod", "version": 3,
            "info": { "status": "deployed", "last_deployed": "2026-10-01T10:00:00Z", "notes": "hi" },
            "chart": { "metadata": { "name": "nginx", "version": "1.2.3", "appVersion": "1.27" }, "values": { "replicas": 1 } },
            "config": { "replicas": 2 },
            "manifest": "---\nkind: Service"
        });
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(release.to_string().as_bytes()).unwrap();
        let b64 = base64::engine::general_purpose::STANDARD.encode(gz.finish().unwrap());
        let secret = Secret {
            data: Some([("release".to_string(), ByteString(b64.into_bytes()))].into()),
            ..Default::default()
        };

        let v = decode(&secret).expect("decodes");
        let sum = summary(&v);
        assert_eq!((sum.name.as_str(), sum.revision, sum.chart.as_str()), ("web", 3, "nginx"));
        assert_eq!(sum.chart_version, "1.2.3");
        assert_eq!(to_yaml(v.get("config")).unwrap().trim(), "replicas: 2");
        assert_eq!(to_yaml(Some(&serde_json::json!({}))).unwrap(), "");
    }
}

// ---- Chart repositories and installs (helm CLI) ----

#[derive(Serialize, serde::Deserialize)]
pub struct HelmRepo {
    name: String,
    url: String,
}

#[derive(Serialize, serde::Deserialize)]
pub struct ChartHit {
    name: String,
    version: String,
    app_version: String,
    description: String,
}

#[tauri::command]
pub async fn helm_repo_list(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<HelmRepo>> {
    match run_helm(&app, &state, &["repo", "list", "-o", "json"]).await {
        Ok(out) => serde_json::from_str(&out).map_err(|e| Error::Other(e.to_string())),
        Err(Error::Other(msg)) if msg.contains("no repositories") => Ok(vec![]),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn helm_repo_add(app: AppHandle, state: State<'_, AppState>, name: String, url: String) -> Result<String> {
    run_helm(&app, &state, &["repo", "add", &name, &url]).await
}

#[tauri::command]
pub async fn helm_repo_update(app: AppHandle, state: State<'_, AppState>) -> Result<String> {
    run_helm(&app, &state, &["repo", "update"]).await
}

/// Searches added repos; with `versions`, lists every version of the exact chart.
#[tauri::command]
pub async fn helm_search(
    app: AppHandle,
    state: State<'_, AppState>,
    query: String,
    versions: bool,
) -> Result<Vec<ChartHit>> {
    let mut args = vec!["search", "repo", query.as_str(), "-o", "json"];
    if versions {
        args.push("--versions");
    }
    let out = run_helm(&app, &state, &args).await?;
    let mut hits: Vec<ChartHit> = serde_json::from_str(&out).map_err(|e| Error::Other(e.to_string()))?;
    if versions {
        hits.retain(|h| h.name == query);
    }
    Ok(hits)
}

#[tauri::command]
pub async fn helm_show_values(
    app: AppHandle,
    state: State<'_, AppState>,
    chart: String,
    version: String,
) -> Result<String> {
    run_helm(&app, &state, &["show", "values", &chart, "--version", &version]).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn helm_install(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    namespace: String,
    chart: String,
    version: String,
    values: String,
) -> Result<String> {
    let dir = std::env::temp_dir().join("bens-helm");
    std::fs::create_dir_all(&dir).map_err(|e| Error::Other(e.to_string()))?;
    let file = dir.join(format!("{name}-values.yaml"));
    std::fs::write(&file, values).map_err(|e| Error::Other(e.to_string()))?;
    let file_arg = file.to_string_lossy().to_string();
    let out = run_helm(
        &app,
        &state,
        &[
            "install", &name, &chart, "--version", &version, "--namespace", &namespace, "--create-namespace", "-f",
            &file_arg,
        ],
    )
    .await;
    let _ = std::fs::remove_file(&file);
    out
}
