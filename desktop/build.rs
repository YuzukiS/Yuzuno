fn main() {
    // Declaring every command makes explicit capabilities apply to them.
    // Undeclared application commands are otherwise allowed by default.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "connection_info",
            "connect_core",
            "start_core",
            "set_appearance",
            "desktop_update_status",
            "desktop_update_check",
            "desktop_update_install",
            "desktop_notifications",
            "desktop_notify",
        ]),
    ))
    .expect("Unable to build desktop capabilities");
}
