fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let path = args
        .next()
        .ok_or("Usage: verify-updater <verification-input.json>")?;
    #[cfg(windows)]
    if path == "--stage-windows-nsis" {
        let request = args.next().ok_or("Expected the stage request JSON path")?;
        if args.next().is_some() {
            return Err("Unexpected stage argument".into());
        }
        return serial_workbench_lib::update_signature::stage_windows_release(
            std::path::Path::new(&request),
        );
    }
    serial_workbench_lib::update_signature::verify_manifest(std::path::Path::new(&path))
}
