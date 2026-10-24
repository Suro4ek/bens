//! A kubeconfig for a service account, like Lens' "Kubeconfig" menu item: the
//! connected cluster's server and CA, and the account's token.

use base64::Engine;
use k8s_openapi::api::authentication::v1::{TokenRequest, TokenRequestSpec};
use k8s_openapi::api::core::v1::{Secret, ServiceAccount};
use kube::api::{Api, ListParams, PostParams};
use kube::config::Kubeconfig;
use serde::Serialize;
use serde_json::json;
use tauri::State;

use crate::error::{Error, Result};
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceAccountKubeconfig {
    kubeconfig: String,
    /// "secret" (a long-lived token Secret) or "token-request" (a token that expires).
    token_source: String,
    expires: Option<String>,
}

/// Server, CA (base64) and the insecure flag of the context's cluster.
fn cluster_entry(file: &str, context: &str) -> Result<(String, Option<String>, bool)> {
    let kc = Kubeconfig::read_from(file)?;
    let ctx = kc
        .contexts
        .iter()
        .find(|c| c.name == context)
        .and_then(|c| c.context.as_ref())
        .ok_or_else(|| Error::Other(format!("context {context} not found in {file}")))?;
    let cluster = kc
        .clusters
        .iter()
        .find(|c| c.name == ctx.cluster)
        .and_then(|c| c.cluster.as_ref())
        .ok_or_else(|| Error::Other(format!("cluster {} not found in {file}", ctx.cluster)))?;
    let ca = match (&cluster.certificate_authority_data, &cluster.certificate_authority) {
        (Some(data), _) => Some(data.clone()),
        (None, Some(path)) => Some(
            base64::engine::general_purpose::STANDARD
                .encode(std::fs::read(path).map_err(|e| Error::Other(format!("{path}: {e}")))?),
        ),
        _ => None,
    };
    let server = cluster.server.clone().ok_or_else(|| Error::Other("the cluster has no server address".into()))?;
    Ok((server, ca, cluster.insecure_skip_tls_verify.unwrap_or(false)))
}

/// The kubeconfig YAML for a token.
fn render(cluster_name: &str, server: &str, ca: Option<&str>, insecure: bool, namespace: &str, name: &str, token: &str) -> Result<String> {
    let mut cluster = json!({ "server": server });
    if let Some(ca) = ca {
        cluster["certificate-authority-data"] = json!(ca);
    }
    if insecure {
        cluster["insecure-skip-tls-verify"] = json!(true);
    }
    let context = format!("{cluster_name}-{name}");
    let config = json!({
        "apiVersion": "v1",
        "kind": "Config",
        "clusters": [{ "name": cluster_name, "cluster": cluster }],
        "users": [{ "name": name, "user": { "token": token } }],
        "contexts": [{ "name": context, "context": { "cluster": cluster_name, "user": name, "namespace": namespace } }],
        "current-context": context,
    });
    Ok(serde_yaml_ng::to_string(&config)?)
}

#[tauri::command]
pub async fn service_account_kubeconfig(
    state: State<'_, AppState>,
    cluster: String,
    namespace: String,
    name: String,
    hours: Option<i64>,
) -> Result<ServiceAccountKubeconfig> {
    let client = state.client(&cluster)?;
    let (context, file) = state.with_cluster(&cluster, |c| (c.context.clone(), c.kubeconfig_file.clone()))?;
    let (server, ca, insecure) = cluster_entry(&file, &context)?;

    // A long-lived token Secret if the account has one (clusters before 1.24 create them)…
    let secrets: Api<Secret> = Api::namespaced(client.clone(), &namespace);
    let listed = secrets.list(&ListParams::default().fields("type=kubernetes.io/service-account-token")).await?;
    let from_secret = listed.items.into_iter().find_map(|s| {
        let owner = s.metadata.annotations.as_ref()?.get("kubernetes.io/service-account.name")?;
        (owner == &name).then(|| s.data?.get("token").map(|t| String::from_utf8_lossy(&t.0).into_owned()))?
    });
    let (token, token_source, expires) = match from_secret {
        Some(token) => (token, "secret", None),
        // …otherwise a token from the TokenRequest API, valid for the requested time (the server may cap it).
        None => {
            let accounts: Api<ServiceAccount> = Api::namespaced(client, &namespace);
            let request = TokenRequest {
                spec: Some(TokenRequestSpec { expiration_seconds: Some(hours.unwrap_or(24 * 365) * 3600), ..Default::default() }),
                ..Default::default()
            };
            let status = accounts.create_token_request(&name, &PostParams::default(), &request).await?.status;
            let status = status.ok_or_else(|| Error::Other("the API server returned no token".into()))?;
            let token = status.token.ok_or_else(|| Error::Other("the API server returned no token".into()))?;
            (token, "token-request", status.expiration_timestamp.map(|t| t.0.to_string()))
        }
    };
    Ok(ServiceAccountKubeconfig {
        kubeconfig: render(&context, &server, ca.as_deref(), insecure, &namespace, &name, &token)?,
        token_source: token_source.into(),
        expires,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_a_kubeconfig() {
        let yaml = render("prod", "https://10.0.0.1:6443", Some("Q0E="), false, "ci", "deployer", "tkn").unwrap();
        let v: serde_json::Value = serde_yaml_ng::from_str(&yaml).unwrap();
        assert_eq!(v["current-context"], "prod-deployer");
        assert_eq!(v["clusters"][0]["cluster"]["server"], "https://10.0.0.1:6443");
        assert_eq!(v["clusters"][0]["cluster"]["certificate-authority-data"], "Q0E=");
        assert_eq!(v["users"][0]["user"]["token"], "tkn");
        assert_eq!(v["contexts"][0]["context"]["namespace"], "ci");
    }
}
