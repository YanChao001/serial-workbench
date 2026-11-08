fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = std::env::args_os().skip(1);
    let path = arguments
        .next()
        .ok_or("Usage: export-bindings <output.ts> [client-defaults.json]")?;
    serial_workbench_lib::bindings::export(std::path::Path::new(&path))?;
    if let Some(defaults) = arguments.next() {
        serial_workbench_lib::bindings::export_client_defaults(std::path::Path::new(&defaults))?;
    }
    Ok(())
}
