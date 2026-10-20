//! Cost backends (OpenCost, Kubecost) reached through the API server's
//! service proxy, like Prometheus. The frontend normalizes their answers.

use k8s_openapi::api::core::v1::Service;
use kube::api::{Api, ListParams};
use serde_json::Value;
use tauri::State;

use crate::error::{Error, Result};
use crate::state::AppState;

/// A namespace or service name: a DNS label. The address goes into the proxy
/// path, so nothing that could reshape the URL gets through.
fn dns_label(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 63
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !s.starts_with('-')
        && !s.ends_with('-')
}

/// Parses `namespace/service:port`.
fn parse_address(s: &str) -> Result<(String, String, u16)> {
    let bad = || Error::Other(format!("\"{s}\" is not a service address of the form namespace/service:port"));
    let (ns, rest) = s.trim().split_once('/').ok_or_else(bad)?;
    let (svc, port) = rest.rsplit_once(':').ok_or_else(bad)?;
    let port: u16 = port.parse().map_err(|_| bad())?;
    if !dns_label(ns) || !dns_label(svc) || port == 0 {
        return Err(bad());
    }
    Ok((ns.into(), svc.into(), port))
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// First service matching one of the label selectors, as `namespace/service:port`.
/// A service exposing `preferred_port` wins (Kubecost labels several services
/// the same way); otherwise the first port of the first match is used.
#[tauri::command]
pub async fn cost_find_service(
    state: State<'_, AppState>,
    selectors: Vec<String>,
    preferred_port: i32,
) -> Result<Option<String>> {
    let client = state.client()?;
    let api: Api<Service> = Api::all(client);
    let mut fallback = None;
    for sel in &selectors {
        let list = api.list(&ListParams::default().labels(sel)).await?;
        for svc in list.items {
            let ns = svc.metadata.namespace.unwrap_or_default();
            let name = svc.metadata.name.unwrap_or_default();
            let ports: Vec<i32> = svc.spec.and_then(|s| s.ports).unwrap_or_default().iter().map(|p| p.port).collect();
            if ports.contains(&preferred_port) {
                return Ok(Some(format!("{ns}/{name}:{preferred_port}")));
            }
            if let (Some(p), None) = (ports.first(), &fallback) {
                fallback = Some(format!("{ns}/{name}:{p}"));
            }
        }
    }
    Ok(fallback)
}

/// GET `path?query` on a service through the API server proxy, parsed as JSON.
#[tauri::command]
pub async fn service_proxy_get(
    state: State<'_, AppState>,
    address: String,
    path: String,
    query: Vec<(String, String)>,
) -> Result<Value> {
    let (ns, svc, port) = parse_address(&address)?;
    if !path.starts_with('/') || !path.bytes().all(|b| b.is_ascii_alphanumeric() || b"/-_.".contains(&b)) {
        return Err(Error::Other(format!("invalid API path {path:?}")));
    }
    let query = query.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v))).collect::<Vec<_>>().join("&");
    let url = format!("/api/v1/namespaces/{ns}/services/{svc}:{port}/proxy{path}?{query}");
    let client = state.client()?;
    let req = http::Request::get(url).body(Vec::new()).map_err(|e| Error::Other(e.to_string()))?;
    let text = client.request_text(req).await.map_err(|e| match &e {
        // The proxy answers 502-504 for a service with no ready endpoints: usually one installed a moment ago.
        kube::Error::Api(s) if matches!(s.code, 502..=504) => {
            Error::Other(format!("{address} is not answering yet (HTTP {}). If it was just installed, it may still be starting.", s.code))
        }
        _ => Error::Kube(e),
    })?;
    serde_json::from_str(&text).map_err(|e| Error::Other(format!("unexpected answer from {address}: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses() {
        assert_eq!(parse_address("opencost/opencost:9003").unwrap(), ("opencost".into(), "opencost".into(), 9003));
        assert!(parse_address("a/b").is_err());
        assert!(parse_address("a/b:0").is_err());
        assert!(parse_address("a/b/../c:80").is_err());
        assert!(parse_address("A/b:80").is_err());
        assert!(parse_address("a/b:80?x").is_err());
    }
}
