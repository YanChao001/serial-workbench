fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let path = args
        .next()
        .ok_or("Usage: verify-updater <verification-input.json>")?;
    #[cfg(windows)]
    if path == "--stage-windows-nsis" || path == "--switch-windows-nsis" {
        let request = args
            .next()
            .ok_or("Expected the Windows request JSON path")?;
        if args.next().is_some() {
            return Err("Unexpected Windows installer argument".into());
        }
        let request = std::path::Path::new(&request);
        return if path == "--stage-windows-nsis" {
            serial_workbench_lib::update_signature::stage_windows_release(request)
        } else {
            serial_workbench_lib::update_signature::switch_windows_release(request)
        };
    }
    serial_workbench_lib::update_signature::verify_manifest(std::path::Path::new(&path))
}
