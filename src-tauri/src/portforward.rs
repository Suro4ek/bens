use k8s_openapi::api::core::v1::{Pod, Service};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::api::{Api, ListParams};
use kube::Client;
use serde::Serialize;
use tauri::State;
use tokio::net::TcpListener;
use tokio::task::JoinSet;

use crate::error::{Error, Result};
use crate::state::{AppState, Forward};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInfo {
    id: String,
    /// Catalog id of the cluster it forwards into.
    cluster: String,
    kind: String,
    namespace: String,
    name: String,
    remote_port: u16,
    local_port: u16,
    /// "http" or "https": how the forwarded port is opened in a browser.
    protocol: String,
}

fn is_ready(pod: &Pod) -> bool {
    let status = pod.status.as_ref();
    status.and_then(|s| s.phase.as_deref()) == Some("Running")
        && status
            .and_then(|s| s.conditions.as_ref())
            .is_some_and(|cs| cs.iter().any(|c| c.type_ == "Ready" && c.status == "True"))
}

fn container_port(pod: &Pod, name: &str) -> Option<u16> {
    pod.spec.as_ref()?.containers.iter().find_map(|c| {
        c.ports.as_ref()?.iter().find(|p| p.name.as_deref() == Some(name)).map(|p| p.container_port as u16)
    })
}

/// Finds the pod and container port a connection should go to. Services are
/// re-resolved per connection so forwards survive pod restarts.
async fn resolve(client: &Client, kind: &str, ns: &str, name: &str, port: u16) -> Result<(String, u16)> {
    if kind == "pod" {
        return Ok((name.to_string(), port));
    }
    let svc = Api::<Service>::namespaced(client.clone(), ns).get(name).await?;
    let spec = svc.spec.unwrap_or_default();
    let target = spec
        .ports
        .unwrap_or_default()
        .into_iter()
        .find(|p| p.port as u16 == port)
        .and_then(|p| p.target_port)
        .unwrap_or(IntOrString::Int(port as i32));
    let selector = spec
        .selector
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::Other(format!("service {name} has no selector")))?
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join(",");
    let pods = Api::<Pod>::namespaced(client.clone(), ns).list(&ListParams::default().labels(&selector)).await?;
    let pod = pods
        .items
        .into_iter()
        .find(is_ready)
        .ok_or_else(|| Error::Other(format!("no ready pods behind service {name}")))?;
    let target_port = match target {
        IntOrString::Int(p) => p as u16,
        IntOrString::String(n) => container_port(&pod, &n)
            .ok_or_else(|| Error::Other(format!("port {n} not found in pod")))?,
    };
    Ok((pod.metadata.name.unwrap_or_default(), target_port))
}

async fn pipe(client: Client, kind: String, ns: String, name: String, port: u16, mut socket: tokio::net::TcpStream) -> Result<()> {
    let (pod, pod_port) = resolve(&client, &kind, &ns, &name, port).await?;
    let mut pf = Api::<Pod>::namespaced(client, &ns).portforward(&pod, &[pod_port]).await?;
    let mut upstream = pf.take_stream(pod_port).ok_or_else(|| Error::Other("no port-forward stream".into()))?;
    let _ = tokio::io::copy_bidirectional(&mut socket, &mut upstream).await;
    drop(upstream);
    let _ = pf.join().await;
    Ok(())
}

#[tauri::command]
pub async fn port_forward_start(
    state: State<'_, AppState>,
    cluster: String,
    kind: String,
    namespace: String,
    name: String,
    remote_port: u16,
    local_port: Option<u16>,
    protocol: Option<String>,
) -> Result<ForwardInfo> {
    let id = format!("{cluster}|{kind}/{namespace}/{name}:{remote_port}");
    if let Some(f) = state.0.lock().unwrap().forwards.get(&id) {
        return Ok(f.info.clone());
    }
    let client = state.client(&cluster)?;
    // Fail fast on an unresolvable target instead of on the first connection.
    resolve(&client, &kind, &namespace, &name, remote_port).await?;

    let listener = TcpListener::bind(("127.0.0.1", local_port.unwrap_or(0)))
        .await
        .map_err(|e| Error::Other(format!("cannot listen on local port: {e}")))?;
    let local = listener.local_addr().map_err(|e| Error::Other(e.to_string()))?.port();
    let info = ForwardInfo {
        id: id.clone(),
        cluster: cluster.clone(),
        kind: kind.clone(),
        namespace: namespace.clone(),
        name: name.clone(),
        remote_port,
        local_port: local,
        protocol: protocol.filter(|p| p == "https").unwrap_or_else(|| "http".into()),
    };

    let task = tokio::spawn(async move {
        // Dropping the set (when the forward is stopped) aborts open connections.
        let mut conns = JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let Ok((socket, _)) = accepted else { continue };
                    conns.spawn(pipe(client.clone(), kind.clone(), namespace.clone(), name.clone(), remote_port, socket));
                }
                Some(_) = conns.join_next(), if !conns.is_empty() => {}
            }
        }
    });

    state.0.lock().unwrap().forwards.insert(id, Forward { cluster, info: info.clone(), task: task.abort_handle() });
    Ok(info)
}

#[tauri::command]
pub fn port_forward_list(state: State<'_, AppState>) -> Vec<ForwardInfo> {
    let mut list: Vec<_> = state.0.lock().unwrap().forwards.values().map(|f| f.info.clone()).collect();
    list.sort_by(|a, b| a.id.cmp(&b.id));
    list
}

#[tauri::command]
pub fn port_forward_stop(state: State<'_, AppState>, id: String) {
    if let Some(f) = state.0.lock().unwrap().forwards.remove(&id) {
        f.task.abort();
    }
}
