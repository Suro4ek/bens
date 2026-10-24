use futures::StreamExt;
use kube::api::{Api, ApiResource, DeleteParams, DynamicObject, GroupVersionKind, ListParams, Patch, PatchParams, PostParams};
use kube::runtime::{watcher, WatchStreamExt};
use kube::Client;
use serde::Serialize;
use serde_json::json;
use tauri::ipc::Channel;
use tauri::State;

use crate::error::{Error, Result};
use crate::state::{AppState, ResourceType};

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WatchEvent {
    /// Full listing; replaces whatever the frontend had.
    Reset { items: Vec<DynamicObject> },
    Apply { object: DynamicObject },
    Delete { object: DynamicObject },
    Error { message: String },
}

fn api_for(client: Client, rt: &ResourceType, namespace: Option<&str>) -> Api<DynamicObject> {
    match namespace {
        Some(ns) if rt.namespaced && !ns.is_empty() => Api::namespaced_with(client, ns, &rt.api),
        _ => Api::all_with(client, &rt.api),
    }
}

/// Namespaced API for operations on a single object (get/replace/delete).
fn object_api(client: Client, rt: &ResourceType, namespace: Option<&str>) -> Api<DynamicObject> {
    match namespace {
        Some(ns) if rt.namespaced => Api::namespaced_with(client, ns, &rt.api),
        _ => Api::all_with(client, &rt.api),
    }
}

fn strip(mut obj: DynamicObject) -> DynamicObject {
    obj.metadata.managed_fields = None;
    obj
}

// Async so Tauri runs it on its Tokio runtime; `tokio::spawn` panics on the main thread.
#[tauri::command]
pub async fn watch_resources(
    state: State<'_, AppState>,
    cluster: String,
    watch_id: String,
    key: String,
    namespace: Option<String>,
    label_selector: Option<String>,
    field_selector: Option<String>,
    on_event: Channel<WatchEvent>,
) -> Result<()> {
    let client = state.client(&cluster)?;
    let rt = state.resource(&cluster, &key)?;
    let api = api_for(client, &rt, namespace.as_deref());
    let mut config = watcher::Config::default();
    if let Some(l) = label_selector.as_deref() {
        config = config.labels(l);
    }
    if let Some(f) = field_selector.as_deref() {
        config = config.fields(f);
    }

    let task = tokio::spawn(async move {
        let mut stream = watcher(api, config).default_backoff().boxed();
        let mut buffer: Vec<DynamicObject> = Vec::new();
        while let Some(ev) = stream.next().await {
            let msg = match ev {
                Ok(watcher::Event::Init) => {
                    buffer.clear();
                    continue;
                }
                Ok(watcher::Event::InitApply(o)) => {
                    buffer.push(strip(o));
                    continue;
                }
                Ok(watcher::Event::InitDone) => WatchEvent::Reset { items: std::mem::take(&mut buffer) },
                Ok(watcher::Event::Apply(o)) => WatchEvent::Apply { object: strip(o) },
                Ok(watcher::Event::Delete(o)) => WatchEvent::Delete { object: strip(o) },
                Err(e) => WatchEvent::Error { message: e.to_string() },
            };
            if on_event.send(msg).is_err() {
                break;
            }
        }
    });
    state.add_stream(&cluster, watch_id, task.abort_handle());
    Ok(())
}

#[tauri::command]
pub fn stop_stream(state: State<'_, AppState>, id: String) {
    state.stop_stream(&id);
}

#[tauri::command]
pub async fn get_yaml(
    state: State<'_, AppState>,
    cluster: String,
    key: String,
    namespace: Option<String>,
    name: String,
) -> Result<String> {
    let rt = state.resource(&cluster, &key)?;
    let api = object_api(state.client(&cluster)?, &rt, namespace.as_deref());
    let obj = strip(api.get(&name).await?);
    Ok(serde_yaml_ng::to_string(&obj)?)
}

#[tauri::command]
pub async fn apply_yaml(
    state: State<'_, AppState>,
    cluster: String,
    key: String,
    namespace: Option<String>,
    name: String,
    yaml: String,
) -> Result<String> {
    let rt = state.resource(&cluster, &key)?;
    let api = object_api(state.client(&cluster)?, &rt, namespace.as_deref());
    let obj: DynamicObject = serde_yaml_ng::from_str(&yaml)?;
    if obj.metadata.name.as_deref() != Some(name.as_str()) {
        return Err(Error::Other("metadata.name cannot be changed".into()));
    }
    let updated = strip(api.replace(&name, &PostParams::default(), &obj).await?);
    Ok(serde_yaml_ng::to_string(&updated)?)
}

#[tauri::command]
pub async fn delete_resource(
    state: State<'_, AppState>,
    cluster: String,
    key: String,
    namespace: Option<String>,
    name: String,
) -> Result<()> {
    let rt = state.resource(&cluster, &key)?;
    let api = object_api(state.client(&cluster)?, &rt, namespace.as_deref());
    api.delete(&name, &DeleteParams::background()).await?;
    Ok(())
}

#[tauri::command]
pub async fn scale_resource(
    state: State<'_, AppState>,
    cluster: String,
    key: String,
    namespace: Option<String>,
    name: String,
    replicas: i32,
) -> Result<()> {
    let rt = state.resource(&cluster, &key)?;
    let api = object_api(state.client(&cluster)?, &rt, namespace.as_deref());
    let patch = json!({ "spec": { "replicas": replicas } });
    api.patch(&name, &PatchParams::default(), &Patch::Merge(&patch)).await?;
    Ok(())
}

/// Equivalent of `kubectl rollout restart`: bumps a pod-template annotation.
#[tauri::command]
pub async fn restart_rollout(
    state: State<'_, AppState>,
    cluster: String,
    key: String,
    namespace: Option<String>,
    name: String,
) -> Result<()> {
    let rt = state.resource(&cluster, &key)?;
    let api = object_api(state.client(&cluster)?, &rt, namespace.as_deref());
    let now = k8s_openapi::jiff::Timestamp::now().to_string();
    let patch = json!({
        "spec": { "template": { "metadata": { "annotations": {
            "kubectl.kubernetes.io/restartedAt": now
        }}}}
    });
    api.patch(&name, &PatchParams::default(), &Patch::Merge(&patch)).await?;
    Ok(())
}

/// Current usage from metrics-server: `scope` is "pods" or "nodes".
#[tauri::command]
pub async fn get_metrics(
    state: State<'_, AppState>,
    cluster: String,
    scope: String,
    namespace: Option<String>,
) -> Result<Vec<DynamicObject>> {
    let kind = match scope.as_str() {
        "pods" => "PodMetrics",
        "nodes" => "NodeMetrics",
        _ => return Err(Error::Other(format!("unknown metrics scope {scope}"))),
    };
    let gvk = GroupVersionKind::gvk("metrics.k8s.io", "v1beta1", kind);
    let ar = ApiResource::from_gvk_with_plural(&gvk, &scope);
    let client = state.client(&cluster)?;
    let api: Api<DynamicObject> = match namespace.as_deref() {
        Some(ns) if scope == "pods" && !ns.is_empty() => Api::namespaced_with(client, ns, &ar),
        _ => Api::all_with(client, &ar),
    };
    Ok(api.list(&ListParams::default()).await?.items.into_iter().map(strip).collect())
}

/// Creates one object (`kubectl create`): unlike apply, fails if it already exists,
/// so a form can never overwrite an existing Secret by accident.
#[tauri::command]
pub async fn create_resource(
    state: State<'_, AppState>,
    cluster: String,
    key: String,
    namespace: Option<String>,
    object: serde_json::Value,
) -> Result<serde_json::Value> {
    let rt = state.resource(&cluster, &key)?;
    let api = object_api(state.client(&cluster)?, &rt, namespace.as_deref());
    let mut obj: DynamicObject = serde_json::from_value(object).map_err(|e| Error::Other(e.to_string()))?;
    obj.types = Some(kube::api::TypeMeta { api_version: rt.api.api_version.clone(), kind: rt.api.kind.clone() });
    if rt.namespaced {
        obj.metadata.namespace = namespace.or(obj.metadata.namespace);
    }
    let created = api.create(&kube::api::PostParams::default(), &obj).await.map_err(|e| match e {
        kube::Error::Api(s) if s.code == 409 => Error::Other(format!("{} {} already exists", rt.api.kind, obj.metadata.name.unwrap_or_default())),
        e => Error::Kube(e),
    })?;
    serde_json::to_value(strip(created)).map_err(|e| Error::Other(e.to_string()))
}

/// `kubectl apply --server-side` for one or more YAML documents.
#[tauri::command]
pub async fn apply_manifest(
    state: State<'_, AppState>,
    cluster: String,
    yaml: String,
    namespace: Option<String>,
) -> Result<Vec<String>> {
    use serde::Deserialize;

    let client = state.client(&cluster)?;
    let types: Vec<ResourceType> = state.with_cluster(&cluster, |c| c.resources.values().cloned().collect())?;
    let mut docs = Vec::new();
    for doc in serde_yaml_ng::Deserializer::from_str(&yaml) {
        let value = serde_json::Value::deserialize(doc)?;
        if !value.is_null() {
            docs.push(value);
        }
    }
    if docs.is_empty() {
        return Err(Error::Other("no YAML documents to apply".into()));
    }

    let mut applied = Vec::new();
    for value in docs {
        let obj: DynamicObject = serde_json::from_value(value).map_err(|e| Error::Other(e.to_string()))?;
        let tm = obj.types.clone().ok_or_else(|| Error::Other("apiVersion and kind are required".into()))?;
        let rt = types
            .iter()
            .find(|r| r.api.api_version == tm.api_version && r.api.kind == tm.kind)
            .ok_or_else(|| Error::Other(format!("unknown resource {} {}", tm.api_version, tm.kind)))?;
        let name = obj.metadata.name.clone().ok_or_else(|| Error::Other(format!("{}: metadata.name is required", tm.kind)))?;
        let ns = rt.namespaced.then(|| {
            obj.metadata.namespace.clone().or_else(|| namespace.clone()).unwrap_or_else(|| "default".into())
        });
        let api = object_api(client.clone(), rt, ns.as_deref());
        api.patch(&name, &PatchParams::apply("bens"), &Patch::Apply(&obj))
            .await
            .map_err(|e| Error::Other(format!("{}/{name}: {e}", tm.kind)))?;
        applied.push(format!("{}/{name}", tm.kind));
    }
    Ok(applied)
}

/// JSON merge patch on any object. Used for GitOps actions: Flux reconcile
/// (`reconcile.fluxcd.io/requestedAt`), suspend/resume (`spec.suspend`), and
/// Argo CD sync (`operation`) / refresh (`argocd.argoproj.io/refresh`).
#[tauri::command]
pub async fn patch_resource(
    state: State<'_, AppState>,
    cluster: String,
    key: String,
    namespace: Option<String>,
    name: String,
    patch: serde_json::Value,
) -> Result<()> {
    let rt = state.resource(&cluster, &key)?;
    let api = object_api(state.client(&cluster)?, &rt, namespace.as_deref());
    api.patch(&name, &PatchParams::default(), &Patch::Merge(&patch)).await?;
    Ok(())
}
