fn main() {
    // Declaring every command makes explicit capabilities apply to them.
    // Undeclared application commands are otherwise allowed by default.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["saved_core", "connect_core"]),
    ))
    .expect("Unable to build iOS capabilities");
}
