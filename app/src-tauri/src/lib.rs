// The Rust side stays minimal on purpose: the UI reaches the Python engine
// through the shell plugin, limited by capabilities/default.json to the one
// bundled sidecar and its two fixed commands.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running Farewatch");
}
