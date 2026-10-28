use std::collections::HashMap;
use std::sync::Mutex;

use kube::discovery::ApiResource;
use kube::Client;
use tokio::sync::mpsc;
use tokio::task::AbortHandle;

use crate::error::{Error, Result};
use crate::portforward::ForwardInfo;
use crate::prefs::ClusterPrefs;
use crate::prometheus::PromService;
use crate::terminal::PtySession;

/// A resource type the connected cluster can list and watch.
#[derive(Clone)]
pub struct ResourceType {
    pub api: ApiResource,
    pub namespaced: bool,
}

/// One connected cluster. Several can be connected at once; every command
/// names the cluster it is for by its catalog id (`<file>#<context>`).
pub struct ClusterConn {
    pub context: String,
    pub kubeconfig_file: String,
    pub prefs: ClusterPrefs,
    pub client: Client,
    pub resources: HashMap<String, ResourceType>,
    pub prometheus: Option<PromService>,
    /// The SSH tunnel the cluster is reached through; dropping it stops ssh.
    pub tunnel: Option<crate::tunnel::Tunnel>,
}

pub struct ExecSession {
    pub cluster: String,
    pub stdin: mpsc::UnboundedSender<Vec<u8>>,
    pub resize: mpsc::UnboundedSender<(u16, u16)>,
    pub task: AbortHandle,
}

pub struct Forward {
    pub cluster: String,
    pub info: ForwardInfo,
    pub task: AbortHandle,
}

pub struct Stream {
    pub cluster: String,
    pub task: AbortHandle,
}

#[derive(Default)]
pub struct Inner {
    pub clusters: HashMap<String, ClusterConn>,
    /// Background streams (watches, log followers) keyed by a frontend-chosen id.
    pub streams: HashMap<String, Stream>,
    pub execs: HashMap<String, ExecSession>,
    /// Local terminals, with the cluster they were opened for.
    pub ptys: HashMap<String, (String, PtySession)>,
    pub forwards: HashMap<String, Forward>,
}

#[derive(Default)]
pub struct AppState(pub Mutex<Inner>);

impl AppState {
    /// Reads something off a connected cluster.
    pub fn with_cluster<T>(&self, cluster: &str, f: impl FnOnce(&mut ClusterConn) -> T) -> Result<T> {
        let mut inner = self.0.lock().unwrap();
        inner.clusters.get_mut(cluster).map(f).ok_or(Error::NotConnected)
    }

    pub fn client(&self, cluster: &str) -> Result<Client> {
        self.with_cluster(cluster, |c| c.client.clone())
    }

    pub fn prefs(&self, cluster: &str) -> Result<ClusterPrefs> {
        self.with_cluster(cluster, |c| c.prefs.clone())
    }

    pub fn resource(&self, cluster: &str, key: &str) -> Result<ResourceType> {
        self.with_cluster(cluster, |c| c.resources.get(key).cloned())?
            .ok_or_else(|| Error::UnknownResource(key.to_string()))
    }

    pub fn add_stream(&self, cluster: &str, id: String, task: AbortHandle) {
        let stream = Stream { cluster: cluster.to_string(), task };
        if let Some(old) = self.0.lock().unwrap().streams.insert(id, stream) {
            old.task.abort();
        }
    }

    pub fn stop_stream(&self, id: &str) {
        if let Some(s) = self.0.lock().unwrap().streams.remove(id) {
            s.task.abort();
        }
    }

    /// Drops a cluster's connection and everything running against it; other clusters are untouched.
    pub fn disconnect_all(&self) {
        let ids: Vec<String> = self.0.lock().unwrap().clusters.keys().cloned().collect();
        for id in ids {
            self.disconnect(&id);
        }
    }

    pub fn disconnect(&self, cluster: &str) {
        let mut inner = self.0.lock().unwrap();
        inner.clusters.remove(cluster);
        inner.streams.retain(|_, s| s.cluster != cluster || {
            s.task.abort();
            false
        });
        inner.execs.retain(|_, s| s.cluster != cluster || {
            s.task.abort();
            false
        });
        inner.ptys.retain(|_, (c, p)| c != cluster || {
            p.kill();
            false
        });
        inner.forwards.retain(|_, f| f.cluster != cluster || {
            f.task.abort();
            false
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn disconnect_only_stops_that_clusters_streams() {
        let state = AppState::default();
        let a = tokio::spawn(std::future::pending::<()>()).abort_handle();
        let b = tokio::spawn(std::future::pending::<()>()).abort_handle();
        state.add_stream("cluster-a", "watch-1".into(), a.clone());
        state.add_stream("cluster-b", "watch-2".into(), b.clone());

        state.disconnect("cluster-a");
        tokio::task::yield_now().await;

        assert!(a.is_finished());
        assert!(!b.is_finished());
        let inner = state.0.lock().unwrap();
        assert!(!inner.streams.contains_key("watch-1"));
        assert!(inner.streams.contains_key("watch-2"));
    }
}
