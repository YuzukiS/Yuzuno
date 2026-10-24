// The iOS app links the library (`tauri::mobile_entry_point`); this runs the
// same app on a Mac, which is where its tests build.
fn main() {
    yuzuno_ios_lib::run();
}
