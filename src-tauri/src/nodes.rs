use k8s_openapi::api::core::v1::{Node, Pod};
use kube::api::{Api, EvictParams, ListParams, Patch, PatchParams};
use serde::Serialize;
use serde_json::json;
use tauri::State;

use crate::error::Result;
use crate::state::AppState;

#[tauri::command]
pub async fn node_cordon(state: State<'_, AppState>, name: String, unschedulable: bool) -> Result<()> {
    let nodes: Api<Node> = Api::all(state.client()?);
    let patch = json!({ "spec": { "unschedulable": unschedulable } });
    nodes.patch(&name, &PatchParams::default(), &Patch::Merge(&patch)).await?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainResult {
    evicted: Vec<String>,
    skipped: Vec<String>,
    failed: Vec<String>,
}

/// Like `kubectl drain --ignore-daemonsets --delete-emptydir-data`: cordons the
/// node and evicts its pods, respecting PodDisruptionBudgets.
#[tauri::command]
pub async fn node_drain(state: State<'_, AppState>, name: String) -> Result<DrainResult> {
    node_cordon(state.clone(), name.clone(), true).await?;
    let client = state.client()?;
    let pods = Api::<Pod>::all(client.clone())
        .list(&ListParams::default().fields(&format!("spec.nodeName={name}")))
        .await?;

    let mut result = DrainResult { evicted: vec![], skipped: vec![], failed: vec![] };
    for pod in pods.items {
        let ns = pod.metadata.namespace.clone().unwrap_or_default();
        let pname = pod.metadata.name.clone().unwrap_or_default();
        let id = format!("{ns}/{pname}");
        let daemon = pod.metadata.owner_references.iter().flatten().any(|o| o.kind == "DaemonSet");
        let mirror = pod.metadata.annotations.as_ref().is_some_and(|a| a.contains_key("kubernetes.io/config.mirror"));
        let done = matches!(pod.status.as_ref().and_then(|s| s.phase.as_deref()), Some("Succeeded" | "Failed"));
        if daemon || mirror || done {
            result.skipped.push(id);
            continue;
        }
        match Api::<Pod>::namespaced(client.clone(), &ns).evict(&pname, &EvictParams::default()).await {
            Ok(_) => result.evicted.push(id),
            Err(e) => result.failed.push(format!("{id}: {e}")),
        }
    }
    Ok(result)
}

const NODE_SHELL_IMAGE: &str = "docker.io/alpine:3.19";
const NODE_SHELL: &str = "((clear && bash) || (clear && ash) || (clear && sh))";

/// Shell on the node itself: a privileged pod in
/// kube-system that `nsenter`s the host's namespaces. The pod is deleted when
/// the session ends.
#[tauri::command]
pub async fn node_shell_start(
    state: State<'_, AppState>,
    session_id: String,
    node: String,
    cols: u16,
    rows: u16,
    on_event: tauri::ipc::Channel<crate::pods::ExecEvent>,
) -> Result<()> {
    use kube::api::PostParams;
    use kube::runtime::wait::{await_condition, conditions::is_pod_running};

    let client = state.client()?;
    let (image, pull_secret) = {
        let inner = state.0.lock().unwrap();
        let p = &inner.prefs;
        let nonempty = |s: &Option<String>| s.clone().filter(|s| !s.trim().is_empty());
        (nonempty(&p.node_shell_image).unwrap_or_else(|| NODE_SHELL_IMAGE.into()), nonempty(&p.node_shell_pull_secret))
    };
    let pods: Api<Pod> = Api::namespaced(client, "kube-system");
    let suffix = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
    let name = format!("node-shell-{suffix}");
    let pod: Pod = serde_json::from_value(json!({
        "metadata": { "name": name, "namespace": "kube-system", "labels": { "app.kubernetes.io/managed-by": "bens" } },
        "spec": {
            "nodeName": node,
            "restartPolicy": "Never",
            "terminationGracePeriodSeconds": 0,
            "hostPID": true,
            "hostIPC": true,
            "hostNetwork": true,
            "tolerations": [{ "operator": "Exists" }],
            "priorityClassName": "system-node-critical",
            "containers": [{
                "name": "shell",
                "image": image,
                "securityContext": { "privileged": true },
                "command": ["nsenter"],
                "args": ["-t", "1", "-m", "-u", "-i", "-n", "sleep", "14000"]
            }],
            "imagePullSecrets": pull_secret.map(|name| vec![json!({ "name": name })]).unwrap_or_default()
        }
    }))
    .map_err(|e| crate::error::Error::Other(e.to_string()))?;

    pods.create(&PostParams::default(), &pod).await?;
    let cleanup = crate::pods::PodCleanup { pods: pods.clone(), name: name.clone() };

    let running = tokio::time::timeout(
        std::time::Duration::from_secs(90),
        await_condition(pods.clone(), &name, is_pod_running()),
    )
    .await;
    if !matches!(running, Ok(Ok(_))) {
        drop(cleanup);
        return Err(crate::error::Error::Other(format!("node shell pod {name} did not start within 90s")));
    }
    crate::pods::start_exec(&state, session_id, pods, &name, None, NODE_SHELL, (cols, rows), on_event, Some(cleanup)).await
}
