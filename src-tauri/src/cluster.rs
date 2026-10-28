use std::time::Duration;

use kube::config::{KubeConfigOptions, Kubeconfig};
use futures::{stream, StreamExt};
use kube::core::GroupVersion;
use kube::discovery::{self, verbs, ApiCapabilities, ApiGroup, ApiResource, Discovery, Scope};
use kube::{Client, Config};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::error::{Error, Result};
use crate::state::{AppState, ClusterConn, ResourceType};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceInfo {
    key: String,
    group: String,
    version: String,
    kind: String,
    plural: String,
    namespaced: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    context: String,
    server_version: String,
    default_namespace: String,
    /// metrics.k8s.io is served (metrics-server installed).
    metrics: bool,
    resources: Vec<ResourceInfo>,
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

pub fn resource_key(group: &str, version: &str, plural: &str) -> String {
    format!("{group}/{version}/{plural}")
}

/// A group name and its resources at the preferred version.
type GroupResources = (String, Vec<(ApiResource, ApiCapabilities)>);

/// Parallel requests when a cluster has no aggregated discovery.
const DISCOVERY_CONCURRENCY: usize = 16;

/// All API groups. Uses aggregated discovery (2 requests, Kubernetes 1.26+); on
/// older clusters falls back to querying the preferred version of each group in
/// parallel. kube's `Discovery::run` asks group by group, one after another,
/// which takes seconds on clusters with many CRDs.
async fn discover(client: &Client) -> Result<Vec<GroupResources>> {
    let flatten = |g: &ApiGroup| (g.name().to_string(), g.recommended_resources());
    if let Ok(d) = Discovery::new(client.clone()).run_aggregated().await {
        if d.groups().next().is_some() {
            return Ok(d.groups().map(flatten).collect());
        }
    }

    let disc = |e: kube::Error| Error::Discovery(e.to_string());
    let (apis, core) = tokio::join!(client.list_api_groups(), discovery::group(client, ApiGroup::CORE_GROUP));
    let pinned: Vec<GroupVersion> = apis
        .map_err(disc)?
        .groups
        .into_iter()
        .filter_map(|g| {
            let version = g.preferred_version.or_else(|| g.versions.into_iter().next())?;
            Some(GroupVersion::gv(&g.name, &version.version))
        })
        .collect();
    let mut groups: Vec<GroupResources> = stream::iter(pinned)
        .map(|gv| async move { discovery::pinned_group(client, &gv).await })
        .buffer_unordered(DISCOVERY_CONCURRENCY)
        // A broken aggregated API (e.g. a dead metrics-server) must not block connecting.
        .filter_map(|r| async move { r.ok().map(|g| flatten(&g)) })
        .collect()
        .await;
    groups.push(flatten(&core.map_err(disc)?));
    Ok(groups)
}

#[tauri::command]
pub async fn connect(app: AppHandle, state: State<'_, AppState>, file: String, context: String) -> Result<Connection> {
    // Other clusters stay connected; reconnecting this one drops its old streams.
    let id = format!("{file}#{context}");
    state.disconnect(&id);
    let prefs = crate::prefs::cluster(&app, &id);

    let kubeconfig = Kubeconfig::read_from(&file)?;
    let opts = KubeConfigOptions { context: Some(context.clone()), ..Default::default() };
    let mut config = Config::from_custom_kubeconfig(kubeconfig, &opts).await?;
    config.connect_timeout = Some(CONNECT_TIMEOUT);
    let tunnel = match prefs.ssh_tunnel.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        Some(args) => {
            let tunnel = crate::tunnel::start(args, &config.cluster_url).await?;
            if let Some((url, name)) = &tunnel.server {
                config.cluster_url = url.parse().map_err(|e| Error::Other(format!("tunnel URL: {e}")))?;
                config.tls_server_name.get_or_insert_with(|| name.clone());
            }
            Some(tunnel)
        }
        None => None,
    };
    let app_prefs = crate::prefs::load(&app).app;
    let proxy = prefs.http_proxy.clone().filter(|p| !p.trim().is_empty()).unwrap_or(app_prefs.http_proxy);
    // Through a tunnel the server is local: no proxy reaches it.
    if tunnel.is_none() && !proxy.trim().is_empty() {
        config.proxy_url = Some(proxy.trim().parse().map_err(|e| Error::Other(format!("proxy URL: {e}")))?);
    }
    if app_prefs.allow_untrusted_ca {
        config.accept_invalid_certs = true;
    }
    let server = config.cluster_url.to_string();
    let default_namespace = config.default_namespace.clone();
    let client = Client::try_from(config)?;

    // Version and discovery go out together: on a remote cluster every round trip counts.
    let (version, groups) = tokio::join!(client.apiserver_version(), discover(&client));
    let version = version.map_err(|e| Error::Other(format!("cannot reach API server {server}: {e}")))?;
    let groups = groups?;

    let metrics = groups.iter().any(|(name, _)| name == "metrics.k8s.io");
    let mut types = Vec::new();
    let mut infos = Vec::new();
    for (_, resources) in groups {
        for (ar, caps) in resources {
            if !caps.supports_operation(verbs::LIST) || !caps.supports_operation(verbs::WATCH) {
                continue;
            }
            let namespaced = caps.scope == Scope::Namespaced;
            let key = resource_key(&ar.group, &ar.version, &ar.plural);
            infos.push(ResourceInfo {
                key: key.clone(),
                group: ar.group.clone(),
                version: ar.version.clone(),
                kind: ar.kind.clone(),
                plural: ar.plural.clone(),
                namespaced,
            });
            types.push((key, ResourceType { api: ar, namespaced }));
        }
    }
    infos.sort_by(|a, b| (&a.group, &a.kind).cmp(&(&b.group, &b.kind)));

    state.0.lock().unwrap().clusters.insert(
        id,
        ClusterConn {
            context: context.clone(),
            kubeconfig_file: file,
            prefs,
            client,
            resources: types.into_iter().collect(),
            prometheus: None,
            tunnel,
        },
    );

    Ok(Connection {
        context,
        server_version: version.git_version,
        default_namespace,
        metrics,
        resources: infos,
    })
}

#[tauri::command]
pub fn disconnect(state: State<'_, AppState>, cluster: String) {
    state.disconnect(&cluster);
}
