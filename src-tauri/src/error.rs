use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("not connected to a cluster")]
    NotConnected,
    #[error("unknown resource type: {0}")]
    UnknownResource(String),
    #[error("{0}")]
    Kube(#[from] kube::Error),
    #[error("kubeconfig: {0}")]
    Kubeconfig(#[from] kube::config::KubeconfigError),
    #[error("kubeconfig: {0}")]
    InferConfig(#[from] kube::config::InferConfigError),
    #[error("discovery: {0}")]
    Discovery(String),
    #[error("yaml: {0}")]
    Yaml(#[from] serde_yaml_ng::Error),
    #[error("{0}")]
    Other(String),
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
