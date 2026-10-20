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

pub struct ExecSession {
    pub stdin: mpsc::UnboundedSender<Vec<u8>>,
    pub resize: mpsc::UnboundedSender<(u16, u16)>,
    pub task: AbortHandle,
}

pub struct Forward {
    pub info: ForwardInfo,
    pub task: AbortHandle,
}

#[derive(Default)]
pub struct Inner {
    pub context: Option<String>,
    /// Catalog id of the connected context (`<file>#<context>`).
    pub context_id: Option<String>,
    pub prefs: ClusterPrefs,
    pub kubeconfig_file: Option<String>,
    pub client: Option<Client>,
    pub resources: HashMap<String, ResourceType>,
    /// Background streams (watches, log followers) keyed by a frontend-chosen id.
    pub streams: HashMap<String, AbortHandle>,
    pub execs: HashMap<String, ExecSession>,
    pub ptys: HashMap<String, PtySession>,
    pub forwards: HashMap<String, Forward>,
    pub prometheus: Option<PromService>,
}

#[derive(Default)]
pub struct AppState(pub Mutex<Inner>);

impl AppState {
    pub fn client(&self) -> Result<Client> {
        self.0.lock().unwrap().client.clone().ok_or(Error::NotConnected)
    }

    pub fn resource(&self, key: &str) -> Result<ResourceType> {
        self.0
            .lock()
            .unwrap()
            .resources
            .get(key)
            .cloned()
            .ok_or_else(|| Error::UnknownResource(key.to_string()))
    }

    pub fn add_stream(&self, id: String, handle: AbortHandle) {
        if let Some(old) = self.0.lock().unwrap().streams.insert(id, handle) {
            old.abort();
        }
    }

    pub fn stop_stream(&self, id: &str) {
        if let Some(h) = self.0.lock().unwrap().streams.remove(id) {
            h.abort();
        }
    }

    /// Drops everything bound to the current cluster connection.
    pub fn reset(&self) {
        let mut inner = self.0.lock().unwrap();
        for (_, h) in inner.streams.drain() {
            h.abort();
        }
        for (_, s) in inner.execs.drain() {
            s.task.abort();
        }
        for (_, mut p) in inner.ptys.drain() {
            p.kill();
        }
        for (_, f) in inner.forwards.drain() {
            f.task.abort();
        }
        inner.resources.clear();
        inner.client = None;
        inner.context = None;
        inner.context_id = None;
        inner.prefs = ClusterPrefs::default();
        inner.kubeconfig_file = None;
        inner.prometheus = None;
    }
}
