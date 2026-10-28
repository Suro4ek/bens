//! SSH tunnels to API servers that are only reachable through a bastion. While the cluster
//! is connected, `ssh -N` runs with the user's arguments (`-L 6443:10.2.9.152:6443 me@bastion`,
//! or just `me@bastion`), and Bens, and kubectl and helm in its terminal, talk to the local end.
//!
//! When the kubeconfig names the remote address, the connection goes to the forwarded local
//! port instead, still checking the certificate against the remote name (`tls-server-name`).

use std::net::{SocketAddr, TcpListener};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::task::AbortHandle;

use crate::error::{Error, Result};

/// ssh options that take an argument, so `-p 22` is not read as two flags.
const WITH_ARGUMENT: &str = "BbcDEeFIiJLlmOoPpQRSWw";
const READY_TIMEOUT: Duration = Duration::from_secs(30);

/// Splits a command line like a POSIX shell: quotes and backslashes group, nothing expands.
pub fn split_args(line: &str) -> Result<Vec<String>> {
    let mut args = Vec::new();
    let mut current: Option<String> = None;
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match c {
            ' ' | '\t' | '\n' => args.extend(current.take()),
            '\'' => {
                let word = current.get_or_insert_with(String::new);
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(c) => word.push(c),
                        None => return Err(Error::Other("ssh arguments: unclosed '".into())),
                    }
                }
            }
            '"' => {
                let word = current.get_or_insert_with(String::new);
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') => word.extend(chars.next()),
                        Some(c) => word.push(c),
                        None => return Err(Error::Other("ssh arguments: unclosed \"".into())),
                    }
                }
            }
            '\\' => current.get_or_insert_with(String::new).extend(chars.next()),
            c => current.get_or_insert_with(String::new).push(c),
        }
    }
    args.extend(current);
    Ok(args)
}

/// A local forward: `[bind:]port:host:hostport`.
#[derive(Debug, PartialEq)]
pub struct Forward {
    bind: Option<String>,
    port: u16,
    host: String,
    host_port: u16,
}

/// `host:port` pieces, with IPv6 addresses in brackets.
fn colon_parts(spec: &str) -> Vec<String> {
    let mut parts = vec![String::new()];
    let mut bracket = false;
    for c in spec.chars() {
        match c {
            '[' => bracket = true,
            ']' => bracket = false,
            ':' if !bracket => parts.push(String::new()),
            c => parts.last_mut().unwrap().push(c),
        }
    }
    parts
}

fn parse_forward(spec: &str) -> Option<Forward> {
    let parts = colon_parts(spec);
    let (bind, rest) = match parts.len() {
        3 => (None, &parts[..]),
        4 => (Some(parts[0].clone()), &parts[1..]),
        _ => return None,
    };
    Some(Forward { bind, port: rest[0].parse().ok()?, host: rest[1].clone(), host_port: rest[2].parse().ok()? })
}

/// The user's arguments, ready for ssh: a leading `ssh` and `-f` (going to the background)
/// dropped, and the local forwards they ask for.
pub fn parse_args(line: &str) -> Result<(Vec<String>, Vec<Forward>)> {
    let mut words = split_args(line)?;
    if words.first().is_some_and(|w| w == "ssh") {
        words.remove(0);
    }
    let mut args = Vec::new();
    let mut forwards = Vec::new();
    let mut destination = false;
    let mut it = words.into_iter();
    while let Some(word) = it.next() {
        if destination || !word.starts_with('-') || word == "-" {
            destination = true;
            args.push(word);
            continue;
        }
        if word == "--" {
            args.push(word);
            destination = true;
            continue;
        }
        // A group of flags, like `-fNL 6443:host:6443`; the first one that takes an argument
        // takes the rest of the word, or the next word.
        let mut flags = String::from("-");
        let mut chars = word[1..].chars();
        while let Some(f) = chars.next() {
            if f == 'f' {
                continue;
            }
            flags.push(f);
            if WITH_ARGUMENT.contains(f) {
                let rest: String = chars.collect();
                let value = if rest.is_empty() { it.next().ok_or_else(|| Error::Other(format!("ssh arguments: -{f} needs a value")))? } else { rest };
                if f == 'L' {
                    forwards.extend(parse_forward(&value));
                }
                args.push(flags);
                args.push(value);
                flags = String::new();
                break;
            }
        }
        if flags.len() > 1 {
            args.push(flags);
        }
    }
    if !destination {
        return Err(Error::Other("ssh arguments: no host to connect to (like user@bastion)".into()));
    }
    Ok((args, forwards))
}

fn is_local(host: &str) -> bool {
    matches!(host.to_ascii_lowercase().as_str(), "localhost" | "127.0.0.1" | "::1")
}

/// What to do with a kubeconfig's server: the local address to connect to (when it changes)
/// and the forward to add (when none of the user's leads to it).
#[derive(Debug, PartialEq)]
pub struct Plan {
    pub connect: Option<SocketAddr>,
    pub add: Option<Forward>,
}

pub fn plan(forwards: &[Forward], host: &str, port: u16, free_port: impl FnOnce() -> Result<u16>) -> Result<Plan> {
    if is_local(host) {
        // The kubeconfig already points at the local end of a tunnel.
        return Ok(Plan { connect: None, add: None });
    }
    let local = |bind: Option<&str>, port: u16| -> SocketAddr {
        let ip = bind.and_then(|b| b.parse().ok()).filter(|ip: &std::net::IpAddr| !ip.is_unspecified());
        SocketAddr::new(ip.unwrap_or([127, 0, 0, 1].into()), port)
    };
    if let Some(f) = forwards.iter().find(|f| f.host.eq_ignore_ascii_case(host) && f.host_port == port) {
        return Ok(Plan { connect: Some(local(f.bind.as_deref(), f.port)), add: None });
    }
    let free = free_port()?;
    Ok(Plan {
        connect: Some(local(None, free)),
        add: Some(Forward { bind: Some("127.0.0.1".into()), port: free, host: host.to_string(), host_port: port }),
    })
}

fn free_port() -> Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| Error::Other(e.to_string()))?;
    Ok(listener.local_addr().map_err(|e| Error::Other(e.to_string()))?.port())
}

fn ssh_command(args: &[String], add: Option<&Forward>) -> Command {
    let mut cmd = Command::new("ssh");
    cmd.args(["-N", "-o", "ExitOnForwardFailure=yes", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"]);
    if !args.iter().any(|a| a.contains("StrictHostKeyChecking")) {
        // Trust a bastion the first time, like answering "yes"; a changed key still fails.
        cmd.args(["-o", "StrictHostKeyChecking=accept-new"]);
    }
    if let Some(f) = add {
        cmd.args(["-L", &format!("{}:{}:{}:{}", f.bind.as_deref().unwrap_or("127.0.0.1"), f.port, f.host, f.host_port)]);
    }
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).kill_on_drop(true);
    cmd
}

/// A running tunnel; dropping it stops ssh. ssh is started again when it exits (the network
/// dropped, the bastion restarted) until then.
pub struct Tunnel {
    child: Arc<Mutex<Option<Child>>>,
    supervisor: AbortHandle,
    /// The server URL to use instead of the kubeconfig's, and the name its certificate is for.
    pub server: Option<(String, String)>,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.supervisor.abort();
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.start_kill();
        }
    }
}

/// What ssh has said on stderr so far (all of it once it has exited).
async fn stderr_text(child: &mut Child) -> String {
    let mut text = Vec::new();
    if let Some(err) = child.stderr.as_mut() {
        let mut buf = [0u8; 4096];
        while let Ok(Ok(n)) = tokio::time::timeout(Duration::from_millis(300), err.read(&mut buf)).await {
            if n == 0 {
                break;
            }
            text.extend_from_slice(&buf[..n]);
        }
    }
    String::from_utf8_lossy(&text).trim().replace("\r\n", "\n")
}

async fn wait_ready(child: &mut Child, local: SocketAddr) -> Result<()> {
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|e| Error::Other(e.to_string()))? {
            let why = stderr_text(child).await;
            let why = if why.is_empty() { format!("exited with {status}") } else { why };
            let hint = if why.contains("Permission denied") { " (Bens can't type passwords: use a key, loaded into ssh-agent if it has a passphrase)" } else { "" };
            return Err(Error::Other(format!("SSH tunnel: {why}{hint}")));
        }
        if let Ok(mut stream) = tokio::net::TcpStream::connect(local).await {
            // ssh accepts first and asks the bastion after: when the bastion refuses
            // (forwarding disabled, nothing at the address), the connection closes at once.
            // An API server instead waits for the TLS hello.
            let mut byte = [0u8; 1];
            return match tokio::time::timeout(Duration::from_millis(1500), stream.read(&mut byte)).await {
                Ok(Ok(0)) | Ok(Err(_)) => {
                    let why = stderr_text(child).await;
                    Err(Error::Other(format!("SSH tunnel: the bastion didn't forward the connection: {why}")))
                }
                _ => Ok(()),
            };
        }
        if started.elapsed() > READY_TIMEOUT {
            return Err(Error::Other(format!("SSH tunnel: nothing listens on {local} after {}s", READY_TIMEOUT.as_secs())));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Starts the tunnel for a cluster whose kubeconfig server is `server`, and waits until it forwards.
pub async fn start(line: &str, server: &http::Uri) -> Result<Tunnel> {
    let (args, forwards) = parse_args(line)?;
    let host = server.host().unwrap_or_default().trim_matches(['[', ']']).to_string();
    let port = server.port_u16().unwrap_or(if server.scheme_str() == Some("http") { 80 } else { 443 });
    let plan = plan(&forwards, &host, port, free_port)?;

    let local = plan.connect.unwrap_or_else(|| SocketAddr::new([127, 0, 0, 1].into(), port));
    if plan.add.is_none() && std::net::TcpListener::bind(local).is_err() {
        return Err(Error::Other(format!("SSH tunnel: local port {} is already in use (another tunnel?)", local.port())));
    }
    let mut child = ssh_command(&args, plan.add.as_ref())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::Other(format!("SSH tunnel: can't run ssh: {e}")))?;
    wait_ready(&mut child, local).await?;
    if let Some(mut err) = child.stderr.take() {
        // Keep reading so ssh never blocks on a full pipe.
        tokio::spawn(async move { while err.read(&mut [0u8; 4096]).await.is_ok_and(|n| n > 0) {} });
    }

    let child = Arc::new(Mutex::new(Some(child)));
    let watched = child.clone();
    let add = plan.add;
    let supervisor = tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let mut slot = watched.lock().unwrap();
            let exited = match slot.as_mut() {
                Some(c) => !matches!(c.try_wait(), Ok(None)),
                None => return,
            };
            if exited {
                *slot = ssh_command(&args, add.as_ref()).stderr(Stdio::null()).spawn().ok();
            }
        }
    })
    .abort_handle();

    let path = server.path_and_query().map(|p| p.as_str()).filter(|p| *p != "/").unwrap_or("");
    let scheme = server.scheme_str().unwrap_or("https");
    Ok(Tunnel { child, supervisor, server: plan.connect.map(|addr| (format!("{scheme}://{addr}{path}"), host)) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fwd(bind: Option<&str>, port: u16, host: &str, host_port: u16) -> Forward {
        Forward { bind: bind.map(Into::into), port, host: host.into(), host_port }
    }

    #[test]
    fn splits_like_a_shell() {
        assert_eq!(split_args(r#"-i "~/my key" -o 'ProxyCommand=a b' x\ y"#).unwrap(), ["-i", "~/my key", "-o", "ProxyCommand=a b", "x y"]);
        assert!(split_args("-o 'open").is_err());
    }

    #[test]
    fn reads_forwards_and_drops_going_to_the_background() {
        let (args, forwards) = parse_args("ssh -fNL 6443:10.2.9.152:6443 -p 2222 -L127.0.0.1:8080:web:80 me@bastion").unwrap();
        assert_eq!(args, ["-NL", "6443:10.2.9.152:6443", "-p", "2222", "-L", "127.0.0.1:8080:web:80", "me@bastion"]);
        assert_eq!(forwards, [fwd(None, 6443, "10.2.9.152", 6443), fwd(Some("127.0.0.1"), 8080, "web", 80)]);
        assert!(parse_args("-L 6443:10.2.9.152:6443").is_err());
        assert_eq!(parse_forward("[::1]:6443:[fd00::5]:6443"), Some(fwd(Some("::1"), 6443, "fd00::5", 6443)));
    }

    /// `KUBECONFIG=… BENS_TUNNEL='-p 2222 me@bastion' cargo test tunnel::tests::live -- --ignored --nocapture`:
    /// connects through the tunnel, then runs kubectl through the terminal's overlay.
    #[tokio::test]
    #[ignore]
    async fn live() {
        use kube::config::{KubeConfigOptions, Kubeconfig};
        let file = std::env::var("KUBECONFIG").unwrap();
        let kubeconfig = Kubeconfig::read_from(&file).unwrap();
        let context = kubeconfig.current_context.clone().unwrap();
        let mut config = kube::Config::from_custom_kubeconfig(kubeconfig, &KubeConfigOptions::default()).await.unwrap();
        let tunnel = start(&std::env::var("BENS_TUNNEL").unwrap(), &config.cluster_url).await.unwrap();
        println!("tunnel: {:?}", tunnel.server);
        if let Some((url, name)) = &tunnel.server {
            config.cluster_url = url.parse().unwrap();
            config.tls_server_name.get_or_insert_with(|| name.clone());
        }
        let client = kube::Client::try_from(config).unwrap();
        println!("server version: {}", client.apiserver_version().await.unwrap().git_version);

        let overlay = std::env::temp_dir().join("bens-tunnel-overlay.yaml");
        std::fs::write(&overlay, crate::terminal::overlay_yaml(&context, &file, Some("kube-system"), tunnel.server.as_ref()).unwrap()).unwrap();
        let out = std::process::Command::new("kubectl")
            .args(["get", "pods", "-o", "name"])
            .env("KUBECONFIG", std::env::join_paths([overlay.clone(), file.into()]).unwrap())
            .output()
            .unwrap();
        println!("kubectl: {}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        std::fs::remove_file(overlay).unwrap();

        // ssh dies (network drop): the tunnel starts it again.
        let pid = tunnel.child.lock().unwrap().as_ref().and_then(|c| c.id()).unwrap();
        std::process::Command::new("kill").arg(pid.to_string()).status().unwrap();
        tokio::time::sleep(Duration::from_secs(5)).await;
        let again = tunnel.child.lock().unwrap().as_ref().and_then(|c| c.id()).unwrap();
        println!("restarted: {pid} -> {again}, server version: {}", client.apiserver_version().await.unwrap().git_version);
        drop(tunnel);
        tokio::time::sleep(Duration::from_millis(300)).await;
        let alive = std::process::Command::new("kill").args(["-0", &again.to_string()]).status().unwrap().success();
        println!("ssh still running after drop: {alive}");
    }

    #[test]
    fn connects_through_the_forward_to_the_server() {
        let forwards = [fwd(None, 6443, "10.2.9.152", 6443)];
        let none = || -> Result<u16> { panic!("no port needed") };
        assert_eq!(plan(&forwards, "10.2.9.152", 6443, none).unwrap(), Plan { connect: Some("127.0.0.1:6443".parse().unwrap()), add: None });
        // A kubeconfig already pointed at the tunnel stays as it is.
        assert_eq!(plan(&forwards, "127.0.0.1", 6443, none).unwrap(), Plan { connect: None, add: None });
        // Without a forward to the server, one is added on a free port.
        assert_eq!(
            plan(&[], "api.internal", 443, || Ok(50123)).unwrap(),
            Plan { connect: Some("127.0.0.1:50123".parse().unwrap()), add: Some(fwd(Some("127.0.0.1"), 50123, "api.internal", 443)) }
        );
    }
}
