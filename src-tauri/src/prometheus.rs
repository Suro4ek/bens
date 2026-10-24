//! Prometheus metrics through the API server's service proxy, so no
//! port-forward is needed. Detection covers the common installations.

use k8s_openapi::api::core::v1::Service;
use kube::api::{Api, ListParams};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::error::{Error, Result};
use crate::prefs::parse_service;
use crate::state::AppState;

/// Label selectors tried in order: Prometheus Operator, Helm chart (old and
/// new labels), VictoriaMetrics single.
const SELECTORS: &[&str] = &[
    "operated-prometheus=true",
    "app=prometheus,component=server",
    "app.kubernetes.io/name=prometheus,app.kubernetes.io/component=server",
    "app.kubernetes.io/name=prometheus",
    "app.kubernetes.io/name=victoria-metrics-single",
    "app.kubernetes.io/name=vmsingle",
];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PromService {
    namespace: String,
    service: String,
    port: i32,
    /// Path prefix of the Prometheus HTTP API, e.g. `/prometheus`.
    prefix: String,
}

#[derive(Serialize)]
pub struct Series {
    metric: Value,
    /// `[unix seconds, value]`
    values: Vec<(f64, f64)>,
}

async fn detect(client: &kube::Client) -> Result<Option<PromService>> {
    let api: Api<Service> = Api::all(client.clone());
    for sel in SELECTORS {
        let list = api.list(&ListParams::default().labels(sel)).await?;
        for svc in list.items {
            let port = svc.spec.as_ref().and_then(|s| s.ports.as_ref()).and_then(|p| p.first()).map(|p| p.port);
            if let Some(port) = port {
                return Ok(Some(PromService {
                    namespace: svc.metadata.namespace.unwrap_or_default(),
                    service: svc.metadata.name.unwrap_or_default(),
                    port,
                    prefix: String::new(),
                }));
            }
        }
    }
    Ok(None)
}

/// Prometheus service per the cluster settings: auto-detected, set manually, or off.
async fn resolve(state: &AppState, cluster: &str, client: &kube::Client) -> Result<Option<PromService>> {
    let prefs = state.prefs(cluster)?;
    let prefix = prefs.prometheus_prefix.unwrap_or_default().trim().trim_end_matches('/').to_string();
    let prefix = if prefix.is_empty() || prefix.starts_with('/') { prefix } else { format!("/{prefix}") };
    let found = match prefs.prometheus_mode.as_deref() {
        Some("off") => None,
        Some("manual") => {
            let (namespace, service, port) = parse_service(prefs.prometheus_service.as_deref().unwrap_or_default())?;
            Some(PromService { namespace, service, port, prefix: String::new() })
        }
        _ => detect(client).await?,
    };
    let found = found.map(|s| PromService { prefix: prefix.clone(), ..s });
    state.with_cluster(cluster, |c| c.prometheus = found.clone())?;
    Ok(found)
}

#[tauri::command]
pub async fn prometheus_detect(state: State<'_, AppState>, cluster: String) -> Result<Option<PromService>> {
    let client = state.client(&cluster)?;
    resolve(&state, &cluster, &client).await
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[tauri::command]
pub async fn prometheus_query_range(
    state: State<'_, AppState>,
    cluster: String,
    query: String,
    start: f64,
    end: f64,
    step: f64,
) -> Result<Vec<Series>> {
    let client = state.client(&cluster)?;
    let svc = state.with_cluster(&cluster, |c| c.prometheus.clone())?;
    let svc = match svc {
        Some(s) => s,
        None => resolve(&state, &cluster, &client).await?.ok_or_else(|| Error::Other("Prometheus not found".into()))?,
    };
    let path = format!(
        "/api/v1/namespaces/{}/services/{}:{}/proxy{}/api/v1/query_range?query={}&start={start}&end={end}&step={step}",
        svc.namespace,
        svc.service,
        svc.port,
        svc.prefix,
        enc(&query)
    );
    let req = http::Request::get(path).body(Vec::new()).map_err(|e| Error::Other(e.to_string()))?;
    let body: Value = serde_json::from_str(&client.request_text(req).await?).map_err(|e| Error::Other(e.to_string()))?;
    if body["status"] != "success" {
        return Err(Error::Other(body["error"].as_str().unwrap_or("query failed").to_string()));
    }
    let series = body["data"]["result"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|r| Series {
                    metric: r["metric"].clone(),
                    values: r["values"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|p| {
                            let t = p.get(0)?.as_f64()?;
                            let v = p.get(1)?.as_str()?.parse::<f64>().ok()?;
                            v.is_finite().then_some((t, v))
                        })
                        .collect(),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(series)
}
