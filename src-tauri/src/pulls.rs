//! How far a node has got with pulling images. The Kubernetes API doesn't say, containerd
//! does: each layer being downloaded sits in its content store's `ingest/` directory, and
//! the image manifest, stored first, lists all the layers with their sizes. A small Job
//! on the node reads them, without privileges, through a read-only mount of `/var/lib`.
//!
//! Reading needs the Job's pod running while the node is busy pulling, so it uses an image
//! the node already has and the node's own tools.

use std::collections::HashMap;

use k8s_openapi::api::batch::v1::Job;
use k8s_openapi::api::core::v1::{Event, Node, Pod};
use kube::api::{Api, AttachParams, DeleteParams, ListParams, PostParams};
use kube::Client;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;
use tokio::io::AsyncReadExt;

use crate::error::{Error, Result};
use crate::state::AppState;

const NAMESPACE: &str = "kube-system";
const LABEL: &str = "bens.dev/pull-progress";
/// The helper exits this long after the last reading, and Kubernetes deletes its Job.
const IDLE_SECONDS: u32 = 120;

/// containerd's content store (plain, k3s, RKE2), under the helper's `/host/var/lib`.
const CONTENT_ROOTS: [&str; 3] = [
    "/host/var/lib/containerd/io.containerd.content.v1.content",
    "/host/var/lib/rancher/k3s/agent/containerd/io.containerd.content.v1.content",
    "/host/var/lib/rancher/rke2/agent/containerd/io.containerd.content.v1.content",
];

/// Prints the downloads in progress (`I <ref> <bytes>`), the manifests that list them
/// (`M <digest>`, the JSON, `END`) and which of their blobs are stored (`H <digest> <size>`),
/// or `X` without a containerd content store.
const PROBE: &str = r#"touch /tmp/beat
for r in "$@"; do [ -d "$r/ingest" ] && cd "$r" && break; done
[ -d ingest ] || { echo X; exit 0; }
for d in ingest/*/; do
  [ -f "${d}ref" ] && echo "I $(cat "${d}ref") $(stat -c %s "${d}data" 2>/dev/null || echo 0)"
done
pats=$(cat ingest/*/ref 2>/dev/null | grep -o 'sha256:[0-9a-f]\{64\}' | sed 's/^sha256:/-e /' | tr '\n' ' ')
[ -n "$pats" ] || exit 0
find blobs/sha256 -type f -size -256k -exec grep -l $pats {} + 2>/dev/null | while read -r m; do
  grep -q -e 'manifest.v1+json' -e 'manifest.v2+json' "$m" || continue
  echo "M ${m##*/}"; cat "$m"; echo; echo END
  for h in $(grep -o 'sha256:[0-9a-f]\{64\}' "$m" | sort -u); do
    f="blobs/sha256/${h#sha256:}"
    [ -f "$f" ] && echo "H ${h#sha256:} $(stat -c %s "$f")"
  done
done
exit 0
"#;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImagePull {
    /// The image manifest's digest.
    manifest: String,
    /// Bytes of the image's layers on the node: the stored layers and the downloaded part of the others.
    done: u64,
    total: u64,
    layers: usize,
    layers_done: usize,
}

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullProgress {
    /// While the helper pod isn't running yet: what it is waiting for.
    starting: Option<String>,
    /// No containerd content store on the node (another runtime, or a custom root).
    unsupported: bool,
    /// Images being pulled on the node; which pod they are for is not known there.
    pulls: Vec<ImagePull>,
    /// Blobs being downloaded right now.
    downloading: usize,
}

fn digest_in(s: &str) -> Option<&str> {
    let hex = &s[s.find("sha256:")? + 7..];
    hex.get(..64).filter(|h| h.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn parse(out: &str) -> PullProgress {
    let mut progress = PullProgress::default();
    let mut active: HashMap<&str, u64> = HashMap::new();
    let mut stored: HashMap<&str, u64> = HashMap::new();
    let mut manifests: Vec<(&str, String)> = Vec::new();
    let mut lines = out.lines();
    while let Some(line) = lines.next() {
        let (tag, rest) = line.split_once(' ').unwrap_or((line, ""));
        match tag {
            "X" => progress.unsupported = true,
            "I" => {
                if let (Some((_, bytes)), Some(d)) = (rest.rsplit_once(' '), digest_in(rest)) {
                    active.insert(d, bytes.parse().unwrap_or(0));
                }
            }
            "M" => manifests.push((rest, lines.by_ref().take_while(|l| *l != "END").collect::<Vec<_>>().join("\n"))),
            "H" => {
                if let Some((d, size)) = rest.split_once(' ') {
                    stored.insert(d, size.parse().unwrap_or(0));
                }
            }
            _ => {}
        }
    }
    progress.downloading = active.len();

    for (digest, body) in manifests {
        let Ok(manifest) = serde_json::from_str::<Value>(&body) else { continue };
        let layers: Vec<(&str, u64)> = manifest["layers"]
            .as_array()
            .into_iter()
            .flatten()
            // Attestations (SBOMs, provenance) are not part of the image.
            .filter(|l| !l["mediaType"].as_str().unwrap_or("").contains("in-toto"))
            .filter_map(|l| Some((digest_in(l["digest"].as_str()?)?, l["size"].as_u64()?)))
            .collect();
        // Only images still downloading: other manifests can share a layer that is.
        if !layers.iter().any(|(d, _)| active.contains_key(d) && !stored.contains_key(d)) {
            continue;
        }
        let have = |d: &str| stored.contains_key(d);
        progress.pulls.push(ImagePull {
            manifest: format!("sha256:{digest}"),
            done: layers.iter().map(|&(d, size)| if have(d) { size } else { active.get(d).copied().unwrap_or(0).min(size) }).sum(),
            total: layers.iter().map(|(_, size)| size).sum(),
            layers: layers.len(),
            layers_done: layers.iter().filter(|(d, _)| have(d)).count(),
        });
    }
    progress
}

/// One helper per node, named by a hash of the node's name (names can be too long for a Job).
fn job_name(node: &str) -> String {
    let hash = node.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3));
    format!("bens-pull-progress-{:08x}", hash as u32)
}

/// An image the node already has, so the helper doesn't queue behind the very pull it reports
/// on (kubelets pull one image at a time by default): one of its running containers', preferably
/// a kube-system one, which needs no pull secret.
async fn present_image(client: Client, node: &str) -> Result<Option<String>> {
    let fields = format!("spec.nodeName={node},status.phase=Running");
    let pods = Api::<Pod>::all(client).list(&ListParams::default().fields(&fields)).await?;
    let mut images: Vec<(bool, bool, String)> = Vec::new();
    for pod in pods.items {
        let other_namespace = pod.metadata.namespace.as_deref() != Some("kube-system");
        let secrets = pod.spec.as_ref().is_some_and(|s| s.image_pull_secrets.as_ref().is_some_and(|v| !v.is_empty()));
        for c in pod.status.and_then(|s| s.container_statuses).unwrap_or_default() {
            if c.state.is_some_and(|s| s.running.is_some()) && !c.image.is_empty() && !c.image.starts_with("sha256:") {
                images.push((other_namespace, secrets, c.image));
            }
        }
    }
    images.sort();
    Ok(images.into_iter().next().map(|(_, _, image)| image))
}

/// The helper runs the node's own tools (`sh`, `find`, `grep`…), mounted read-only over the
/// image's: the image only has to be there. The dynamic loader is in /lib64 on x86-64 and in
/// /lib on arm64.
fn helper_job(name: &str, node: &str, image: &str, amd64: bool) -> Result<Job> {
    let idle = format!("touch /tmp/beat; while [ $(( $(date +%s) - $(stat -c %Y /tmp/beat) )) -lt {IDLE_SECONDS} ]; do sleep 5; done");
    let mut host = vec![("usr", "/usr", "Directory"), ("bin", "/bin", "Directory"), ("lib", "/lib", "Directory"), ("ld-cache", "/etc/ld.so.cache", "File")];
    if amd64 {
        host.push(("lib64", "/lib64", "Directory"));
    }
    let mut mounts: Vec<Value> = host.iter().map(|(n, path, _)| json!({ "name": n, "mountPath": path, "readOnly": true })).collect();
    let mut volumes: Vec<Value> = host.iter().map(|(n, path, kind)| json!({ "name": n, "hostPath": { "path": path, "type": kind } })).collect();
    mounts.push(json!({ "name": "var-lib", "mountPath": "/host/var/lib", "readOnly": true }));
    volumes.push(json!({ "name": "var-lib", "hostPath": { "path": "/var/lib", "type": "Directory" } }));
    mounts.push(json!({ "name": "tmp", "mountPath": "/tmp" }));
    volumes.push(json!({ "name": "tmp", "emptyDir": {} }));

    serde_json::from_value(json!({
        "metadata": { "name": name, "namespace": NAMESPACE, "labels": { "app.kubernetes.io/managed-by": "bens" } },
        "spec": {
            "backoffLimit": 0,
            "ttlSecondsAfterFinished": 0,
            "activeDeadlineSeconds": 6 * 3600,
            "template": {
                "metadata": { "labels": { "app.kubernetes.io/managed-by": "bens", LABEL: name } },
                "spec": {
                    "nodeName": node,
                    "restartPolicy": "Never",
                    "terminationGracePeriodSeconds": 0,
                    "tolerations": [{ "operator": "Exists" }],
                    "automountServiceAccountToken": false,
                    "securityContext": { "runAsUser": 0, "runAsGroup": 0 },
                    "containers": [{
                        "name": "probe",
                        "image": image,
                        "imagePullPolicy": "IfNotPresent",
                        "command": ["/bin/sh", "-c", idle],
                        "workingDir": "/",
                        "env": [{ "name": "PATH", "value": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" }],
                        "volumeMounts": mounts
                    }],
                    "volumes": volumes
                }
            }
        }
    }))
    .map_err(|e| Error::Other(e.to_string()))
}

/// The newest warning about an object (a refused pod, a mount that failed).
async fn last_warning(client: Client, kind: &str, name: &str) -> Result<Option<String>> {
    let fields = format!("involvedObject.kind={kind},involvedObject.name={name},type=Warning");
    let mut events = Api::<Event>::namespaced(client, NAMESPACE).list(&ListParams::default().fields(&fields)).await?.items;
    events.sort_by_key(|e| e.last_timestamp.as_ref().map(|t| t.0));
    Ok(events.pop().map(|e| format!("{}: {}", e.reason.unwrap_or_default(), e.message.unwrap_or_default())))
}

/// The running helper pod of the node, or what it is waiting for (it is created when missing).
async fn helper_pod(client: Client, node: &str) -> Result<std::result::Result<String, String>> {
    let jobs: Api<Job> = Api::namespaced(client.clone(), NAMESPACE);
    let pods: Api<Pod> = Api::namespaced(client.clone(), NAMESPACE);
    let name = job_name(node);
    if jobs.get_opt(&name).await?.is_none() {
        let info = Api::<Node>::all(client.clone()).get(node).await?.status.and_then(|s| s.node_info);
        if info.as_ref().is_some_and(|i| i.operating_system != "linux") {
            return Err(Error::Other(format!("{node} isn't a Linux node")));
        }
        let Some(image) = present_image(client.clone(), node).await? else {
            return Err(Error::Other(format!("No running containers on {node} to borrow an image from")));
        };
        let amd64 = info.is_none_or(|i| i.architecture == "amd64");
        match jobs.create(&PostParams::default(), &helper_job(&name, node, &image, amd64)?).await {
            Ok(_) => {}
            Err(kube::Error::Api(e)) if e.code == 409 => {}
            Err(e) => return Err(e.into()),
        }
        return Ok(Err(format!("Starting a helper pod on {node}")));
    }
    let list = pods.list(&ListParams::default().labels(&format!("{LABEL}={name}"))).await?;
    let Some(pod) = list.items.into_iter().find(|p| p.metadata.deletion_timestamp.is_none()) else {
        // The Job can't create its pod when admission refuses it (Pod Security, quotas).
        if let Some(refused) = last_warning(client, "Job", &name).await? {
            stop(&jobs, &name).await;
            return Err(Error::Other(format!("The helper pod can't start: {refused}")));
        }
        return Ok(Err(format!("Starting a helper pod on {node}")));
    };
    let pod_name = pod.metadata.name.unwrap_or_default();
    let status = pod.status.unwrap_or_default();
    let state = status.container_statuses.unwrap_or_default().into_iter().next().and_then(|c| c.state).unwrap_or_default();
    if state.running.is_some() {
        return Ok(Ok(pod_name));
    }
    if let Some(t) = state.terminated.filter(|t| t.exit_code != 0) {
        // Its tools didn't run: the node's layout isn't the expected one.
        stop(&jobs, &name).await;
        let why = t.message.or(t.reason).unwrap_or_default();
        return Err(Error::Other(format!("The helper pod on {node} failed (exit code {}): {why}", t.exit_code)));
    }
    if matches!(status.phase.as_deref(), Some("Succeeded" | "Failed")) {
        // Idle too long, or past its deadline: start over on the next reading.
        stop(&jobs, &name).await;
        return Ok(Err(format!("Restarting the helper pod on {node}")));
    }
    let waiting = state.waiting.map(|w| format!("{}{}", w.reason.unwrap_or_default(), w.message.map(|m| format!(": {m}")).unwrap_or_default()));
    let warning = last_warning(client, "Pod", &pod_name).await?;
    Ok(Err(match (waiting, warning) {
        (_, Some(warning)) => format!("The helper pod on {node} is waiting: {warning}"),
        (Some(waiting), None) => format!("The helper pod on {node} is waiting: {waiting}"),
        (None, None) => format!("Starting a helper pod on {node}"),
    }))
}

async fn stop(jobs: &Api<Job>, name: &str) {
    let _ = jobs.delete(name, &DeleteParams::background()).await;
}

async fn probe(pods: &Api<Pod>, pod: &str) -> Result<String> {
    let mut command = vec!["sh".to_string(), "-c".into(), PROBE.into(), "sh".into()];
    command.extend(CONTENT_ROOTS.iter().map(|r| r.to_string()));
    let read = async {
        let mut process = pods.exec(pod, command, &AttachParams::default().stderr(false)).await?;
        let mut out = String::new();
        if let Some(mut stdout) = process.stdout() {
            stdout.read_to_string(&mut out).await.map_err(|e| Error::Other(e.to_string()))?;
        }
        process.join().await.map_err(|e| Error::Other(e.to_string()))?;
        Ok::<_, Error>(out)
    };
    tokio::time::timeout(std::time::Duration::from_secs(20), read)
        .await
        .map_err(|_| Error::Other("reading the node's downloads timed out".into()))?
}

async fn read_progress(client: Client, node: &str) -> Result<PullProgress> {
    match helper_pod(client.clone(), node).await? {
        Err(starting) => Ok(PullProgress { starting: Some(starting), ..Default::default() }),
        Ok(pod) => Ok(parse(&probe(&Api::namespaced(client, NAMESPACE), &pod).await?)),
    }
}

/// What the node is downloading. The first calls start a helper Job on the node and say so
/// in `starting`; it goes away by itself two minutes after the last call.
#[tauri::command]
pub async fn image_pull_progress(state: State<'_, AppState>, cluster: String, node: String) -> Result<PullProgress> {
    read_progress(state.client(&cluster)?, &node).await
}

/// Removes the node's helper right away.
#[tauri::command]
pub async fn image_pull_progress_stop(state: State<'_, AppState>, cluster: String, node: String) -> Result<()> {
    stop(&Api::namespaced(state.client(&cluster)?, NAMESPACE), &job_name(&node)).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "6e771e15690e2fabf2332d3a3b744495411d6e0b00b2aea64419b58b0066cf81";
    const B: &str = "63214d4c52deb7cd72dfb7b8ee63339ab9ba46086f6c52f3fc22c42a4cc6354c";
    const C: &str = "7fd1c532d4bfc13624585c1d7d362bd1c5a7fae473cac98c7e93678de08ba318";
    const M: &str = "8eed1d324a486196374b67025fe0a8a724245c42d0c3687fa8d6fc953228b9e3";

    fn manifest() -> String {
        format!(
            r#"{{
  "schemaVersion": 2,
  "mediaType": "application/vnd.oci.image.manifest.v1+json",
  "config": {{ "digest": "sha256:4b3c705bafc50e801b1c69e6a17a3ac51bec2391ec1201498e963cb929f3ffd0", "size": 2547 }},
  "layers": [
    {{ "digest": "sha256:{A}", "size": 3993029 }},
    {{ "digest": "sha256:{B}", "size": 59101227 }},
    {{ "digest": "sha256:{C}", "size": 244367129 }}
  ]
}}"#
        )
    }

    #[test]
    fn reads_a_pull_in_progress() {
        // Captured from containerd while it pulled rust:1.85-alpine (trimmed).
        let out = format!(
            "I k8s.io/1/layer-sha256:{C} 100663296\nM {M}\n{}\nEND\nH {A} 3993029\nH {B} 59101227\n",
            manifest()
        );
        assert_eq!(
            parse(&out),
            PullProgress {
                pulls: vec![ImagePull {
                    manifest: format!("sha256:{M}"),
                    done: 3993029 + 59101227 + 100663296,
                    total: 3993029 + 59101227 + 244367129,
                    layers: 3,
                    layers_done: 2,
                }],
                downloading: 1,
                ..Default::default()
            }
        );
    }

    #[test]
    fn skips_finished_images_and_other_documents() {
        // An image index and a manifest whose layers are all stored, though one is in ingest again.
        let index = format!(r#"{{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{{"digest":"sha256:{M}","size":1}}]}}"#);
        let out = format!(
            "I k8s.io/2/manifest-sha256:{M} 0\nI k8s.io/2/layer-sha256:{A} 10\nM aaaa\n{index}\nEND\nM {M}\n{}\nEND\nH {A} 3993029\nH {B} 59101227\nH {C} 244367129\n",
            manifest()
        );
        let progress = parse(&out);
        assert_eq!(progress.pulls, vec![]);
        assert_eq!(progress.downloading, 2);
    }

    #[test]
    fn skips_attestations() {
        let attestation = format!(
            r#"{{"mediaType":"application/vnd.oci.image.manifest.v1+json","layers":[{{"mediaType":"application/vnd.in-toto+json","digest":"sha256:{A}","size":2700000}}]}}"#
        );
        assert_eq!(parse(&format!("I moby/1/attestation-sha256:{A} 0\nM {B}\n{attestation}\nEND\n")).pulls, vec![]);
    }

    #[test]
    fn says_when_there_is_no_containerd() {
        assert!(parse("X\n").unsupported);
    }

    #[test]
    fn helper_uses_the_nodes_tools() {
        let mounts = |amd64| {
            let job = helper_job("bens-pull-progress-1", "node-1", "registry.k8s.io/kube-proxy:v1.33.2", amd64).unwrap();
            let pod = job.spec.unwrap().template.spec.unwrap();
            pod.containers[0].volume_mounts.iter().flatten().map(|m| m.mount_path.clone()).collect::<Vec<_>>()
        };
        assert_eq!(mounts(false), ["/usr", "/bin", "/lib", "/etc/ld.so.cache", "/host/var/lib", "/tmp"]);
        assert!(mounts(true).contains(&"/lib64".to_string()));
    }

    /// `KUBECONFIG=… BENS_NODE=… cargo test live_cluster -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_cluster() {
        let client = Client::try_default().await.unwrap();
        let node = std::env::var("BENS_NODE").unwrap();
        for _ in 0..std::env::var("BENS_READS").ok().and_then(|n| n.parse().ok()).unwrap_or(30) {
            println!("{:?}", read_progress(client.clone(), &node).await);
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        stop(&Api::namespaced(client, NAMESPACE), &job_name(&node)).await;
    }

    #[test]
    fn job_names_are_short_and_stable() {
        let name = job_name("cl1abcdefghijklmnopq-ywuc.ru-central1.internal-with-a-very-long-suffix-for-tests");
        assert_eq!(name, job_name("cl1abcdefghijklmnopq-ywuc.ru-central1.internal-with-a-very-long-suffix-for-tests"));
        assert!(name.len() <= 63);
    }
}
