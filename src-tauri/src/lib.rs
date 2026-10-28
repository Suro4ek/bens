mod cluster;
mod cost;
mod error;
mod helm;
mod kubeconfigs;
mod nodes;
mod pods;
mod portforward;
mod prefs;
mod prometheus;
mod pulls;
mod resources;
mod serviceaccount;
mod shell_env;
mod state;
mod terminal;
mod tunnel;
#[cfg(target_os = "macos")]
mod titlebar;

pub fn run() {
    shell_env::sync_path_from_login_shell();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state::AppState::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            if let Some(w) = tauri::Manager::get_webview_window(app, "main") {
                let window = w.as_ref().window();
                titlebar::place_traffic_lights(&window);
                // AppKit lays the title bar out again once the window is shown; re-apply after that.
                std::thread::spawn(move || {
                    for ms in [50, 200, 600, 1500] {
                        std::thread::sleep(std::time::Duration::from_millis(ms));
                        let w = window.clone();
                        let _ = window.run_on_main_thread(move || titlebar::place_traffic_lights(&w));
                    }
                });
            }
            let _ = app;
            Ok(())
        })
        .on_window_event(|_window, event| {
            // AppKit puts the buttons back on resize, fullscreen and focus changes.
            #[cfg(target_os = "macos")]
            if matches!(
                event,
                tauri::WindowEvent::Resized(_)
                    | tauri::WindowEvent::Moved(_)
                    | tauri::WindowEvent::Focused(_)
                    | tauri::WindowEvent::ScaleFactorChanged { .. }
                    | tauri::WindowEvent::ThemeChanged(_)
            ) {
                titlebar::place_traffic_lights(_window);
            }
            let _ = event;
        })
        .invoke_handler(tauri::generate_handler![
            kubeconfigs::list_contexts,
            kubeconfigs::add_kubeconfig_text,
            kubeconfigs::add_kubeconfig_path,
            kubeconfigs::remove_kubeconfig_source,
            prefs::get_prefs,
            prefs::save_app_prefs,
            prefs::save_cluster_prefs,
            prefs::load_icon_image,
            prefs::save_text_file,
            prefs::read_file_base64,
            prefs::read_kubeconfig,
            prefs::write_kubeconfig,
            prefs::delete_context,
            cluster::connect,
            cluster::disconnect,
            resources::watch_resources,
            resources::stop_stream,
            resources::get_yaml,
            resources::get_object,
            pulls::image_pull_progress,
            pulls::image_pull_progress_stop,
            resources::apply_yaml,
            resources::delete_resource,
            resources::scale_resource,
            resources::restart_rollout,
            resources::get_metrics,
            resources::apply_manifest,
            resources::create_resource,
            resources::put_resource,
            serviceaccount::service_account_kubeconfig,
            nodes::node_cordon,
            nodes::node_drain,
            nodes::node_shell_start,
            resources::patch_resource,
            prometheus::prometheus_detect,
            cost::cost_find_service,
            cost::service_proxy_get,
            prometheus::prometheus_query_range,
            helm::helm_list,
            helm::helm_get,
            helm::helm_rollback,
            helm::helm_uninstall,
            helm::helm_repo_list,
            helm::helm_repo_add,
            helm::helm_repo_update,
            helm::helm_search,
            helm::helm_show_values,
            helm::helm_install,
            portforward::port_forward_start,
            portforward::port_forward_list,
            portforward::port_forward_stop,
            terminal::local_terminal_start,
            pods::stream_logs,
            pods::exec_start,
            pods::exec_input,
            pods::exec_resize,
            pods::exec_stop,
        ])
        .build(tauri::generate_context!())
        .expect("error while running Bens")
        .run(|app, event| {
            // SSH tunnels are processes of their own: stop them with the app.
            if let tauri::RunEvent::Exit = event {
                tauri::Manager::state::<state::AppState>(app).disconnect_all();
            }
        });
}
