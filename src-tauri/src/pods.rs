use std::time::Duration;

use base64::Engine;
use futures::{AsyncBufReadExt, StreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, AttachParams, LogParams, TerminalSize};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::error::{Error, Result};
use crate::state::{AppState, ExecSession};

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LogEvent {
    Lines { lines: Vec<String> },
    End,
    Error { message: String },
}

const LOG_BATCH: usize = 500;
const LOG_FLUSH: Duration = Duration::from_millis(80);

// Async so Tauri runs it on its Tokio runtime; `tokio::spawn` panics on the main thread.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn stream_logs(
    state: State<'_, AppState>,
    cluster: String,
    stream_id: String,
    namespace: String,
    pod: String,
    container: Option<String>,
    tail_lines: Option<i64>,
    previous: bool,
    timestamps: bool,
    on_event: Channel<LogEvent>,
) -> Result<()> {
    let pods: Api<Pod> = Api::namespaced(state.client(&cluster)?, &namespace);
    let params = LogParams {
        container,
        follow: !previous,
        previous,
        tail_lines,
        timestamps,
        ..Default::default()
    };

    let task = tokio::spawn(async move {
        let reader = match pods.log_stream(&pod, &params).await {
            Ok(r) => r,
            Err(e) => {
                let _ = on_event.send(LogEvent::Error { message: e.to_string() });
                return;
            }
        };
        let mut lines = reader.lines();
        let mut batch = Vec::new();
        loop {
            // Batch lines so a large tail doesn't become thousands of IPC messages.
            match tokio::time::timeout(LOG_FLUSH, lines.next()).await {
                Ok(Some(Ok(line))) => {
                    batch.push(line);
                    if batch.len() < LOG_BATCH {
                        continue;
                    }
                }
                Ok(Some(Err(e))) => {
                    let _ = on_event.send(LogEvent::Error { message: e.to_string() });
                    break;
                }
                Ok(None) => break,
                Err(_) => {} // flush on idle
            }
            if !batch.is_empty() && on_event.send(LogEvent::Lines { lines: std::mem::take(&mut batch) }).is_err() {
                return;
            }
        }
        if !batch.is_empty() {
            let _ = on_event.send(LogEvent::Lines { lines: batch });
        }
        let _ = on_event.send(LogEvent::End);
    });
    state.add_stream(&cluster, stream_id, task.abort_handle());
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ExecEvent {
    /// Base64-encoded terminal output.
    Data { data: String },
    Exit { message: Option<String> },
}

const SHELL: &str = "command -v bash >/dev/null && exec bash || exec sh";

#[tauri::command]
pub async fn exec_start(
    state: State<'_, AppState>,
    cluster: String,
    session_id: String,
    namespace: String,
    pod: String,
    container: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<ExecEvent>,
) -> Result<()> {
    let pods: Api<Pod> = Api::namespaced(state.client(&cluster)?, &namespace);
    start_exec(&state, &cluster, session_id, pods, &pod, container, SHELL, (cols, rows), on_event, None).await
}

/// Deletes a helper pod when its session ends, including when the task is aborted.
pub struct PodCleanup {
    pub pods: Api<Pod>,
    pub name: String,
}

impl Drop for PodCleanup {
    fn drop(&mut self) {
        let (pods, name) = (self.pods.clone(), self.name.clone());
        tokio::spawn(async move {
            let _ = pods.delete(&name, &kube::api::DeleteParams::default()).await;
        });
    }
}

/// Runs an interactive TTY exec and registers it as a terminal session.
#[allow(clippy::too_many_arguments)]
pub async fn start_exec(
    state: &AppState,
    cluster: &str,
    session_id: String,
    pods: Api<Pod>,
    pod: &str,
    container: Option<String>,
    script: &str,
    (cols, rows): (u16, u16),
    on_event: Channel<ExecEvent>,
    cleanup: Option<PodCleanup>,
) -> Result<()> {
    let mut params = AttachParams::interactive_tty();
    if let Some(c) = container {
        params = params.container(c);
    }
    let mut proc = pods.exec(pod, vec!["sh", "-c", script], &params).await?;

    let mut stdin = proc.stdin().ok_or_else(|| Error::Other("no stdin".into()))?;
    let mut stdout = proc.stdout().ok_or_else(|| Error::Other("no stdout".into()))?;
    let mut size = proc.terminal_size().ok_or_else(|| Error::Other("no tty".into()))?;
    let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (resize_tx, mut resize_rx) = mpsc::unbounded_channel::<(u16, u16)>();
    let _ = resize_tx.send((cols, rows));

    let task = tokio::spawn(async move {
        use futures::SinkExt;
        let _cleanup = cleanup;
        let b64 = base64::engine::general_purpose::STANDARD;
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            tokio::select! {
                n = stdout.read(&mut buf) => match n {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if on_event.send(ExecEvent::Data { data: b64.encode(&buf[..n]) }).is_err() {
                            break;
                        }
                    }
                },
                Some(bytes) = stdin_rx.recv() => {
                    if stdin.write_all(&bytes).await.is_err() { break; }
                }
                Some((width, height)) = resize_rx.recv() => {
                    let _ = size.send(TerminalSize { width, height }).await;
                }
            }
        }
        drop(proc);
        let _ = on_event.send(ExecEvent::Exit { message: None });
    });

    state.0.lock().unwrap().execs.insert(
        session_id,
        ExecSession { cluster: cluster.to_string(), stdin: stdin_tx, resize: resize_tx, task: task.abort_handle() },
    );
    Ok(())
}

// Input/resize/stop serve both pod exec sessions and local terminals.

#[tauri::command]
pub fn exec_input(state: State<'_, AppState>, session_id: String, data: String) {
    let mut inner = state.0.lock().unwrap();
    if let Some(s) = inner.execs.get(&session_id) {
        let _ = s.stdin.send(data.into_bytes());
    } else if let Some((_, p)) = inner.ptys.get_mut(&session_id) {
        p.write(data.as_bytes());
    }
}

#[tauri::command]
pub fn exec_resize(state: State<'_, AppState>, session_id: String, cols: u16, rows: u16) {
    let inner = state.0.lock().unwrap();
    if let Some(s) = inner.execs.get(&session_id) {
        let _ = s.resize.send((cols, rows));
    } else if let Some((_, p)) = inner.ptys.get(&session_id) {
        p.resize(cols, rows);
    }
}

#[tauri::command]
pub fn exec_stop(state: State<'_, AppState>, session_id: String) {
    let mut inner = state.0.lock().unwrap();
    if let Some(s) = inner.execs.remove(&session_id) {
        s.task.abort();
    }
    if let Some((_, mut p)) = inner.ptys.remove(&session_id) {
        p.kill();
    }
}
