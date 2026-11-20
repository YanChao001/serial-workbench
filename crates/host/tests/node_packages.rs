#[path = "node_packages/actions.rs"]
mod actions;
#[path = "node_packages/host_actions.rs"]
mod host_actions;
mod support;
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{Value, json};
use serial_workbench_core::{Id, NODE_PACKAGE_SIGNATURE_PREFIX};
use serial_workbench_host::node_packages::{
    NodePackageInstaller, NodePackageLimits, NodePackageSource, NodePackageSources,
    verify_node_package,
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::atomic::AtomicBool};
use zip::CompressionMethod;

use support::{
    PUBLISH_MARKER_JS, node_owner_exit,
    node_package::{archive, archive_with_compression, manifest, payloads, with_metadata},
};

fn verify_local(
    files: &BTreeMap<String, Vec<u8>>,
) -> serial_workbench_core::HostResult<serial_workbench_host::node_packages::VerifiedNodePackage> {
    verify_node_package(
        archive(files),
        NodePackageSource::Local,
        &NodePackageLimits::default(),
        &AtomicBool::new(false),
    )
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_registers_a_formal_package_and_disposes_it_before_actual_exit() {
    use serial_workbench_host::{
        node_backend::{NodeBackend, NodeBackendLimits},
        node_runtime::{NodeRuntimeLimits, verify_node_runtime},
    };
    use std::sync::Arc;
    let profile = support::Profile::isolated("node-backend-lifecycle-");
    let store = serial_workbench_host::storage::Store::open(profile.path()).unwrap();
    let installer = NodePackageInstaller::new(store, profile.path()).unwrap();
    let marker = profile.path().join("实际注册与清理.txt");
    let marker_json = serde_json::to_string(&marker).unwrap();
    let code = format!(
        "import {{writeFileSync}} from 'node:fs';\nexport async function register(context) {{\n writeFileSync({marker_json}, 'registered');\n context.contributions.register({{actions:[],queries:[],transports:[],parsers:[],views:[],themes:[],configuration:[]}});\n return async () => writeFileSync({marker_json}, 'disposed');\n}}"
    );
    let mut files = payloads();
    files.insert("dist/main.mjs".into(), code.into_bytes());
    let package = verify_local(&with_metadata(files, false)).unwrap();
    let installed = installer
        .install(
            package,
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let id = installed.package.manifest.id.clone();
    let digest = installed.package.archive_sha256.clone();
    let trusted = installer
        .confirm_execution_trust(&id, installed.revision, &digest)
        .unwrap();
    let enabled = installer
        .set_enabled(&id, true, trusted.revision, &digest)
        .unwrap();
    let proof = installer
        .verify_installed(
            &id,
            enabled.revision,
            &digest,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(
        !marker.exists(),
        "Preparation must not execute package code"
    );
    let root = std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT")
        .expect("Explicit native runtime fixture is required");
    let runtime = verify_node_runtime(
        std::path::Path::new(&root),
        &NodeRuntimeLimits::default(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let backend = NodeBackend::start(
        runtime,
        NodeBackendLimits::default(),
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap();
    let registered = backend.activate(proof, || Ok(())).unwrap();
    assert_eq!(registered.id, id);
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "registered");
    backend.dispose(id.clone(), || Ok(())).unwrap();
    backend.dispose(id, || Ok(())).unwrap();
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "disposed");
    let exit = backend.shutdown();
    assert!(exit.process_id > 0);
    assert!(
        exit.reaped,
        "Actual Node exit must precede owner completion"
    );
    assert!(
        exit.error.is_none(),
        "Normal shutdown must clean up: {exit:?}"
    );
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_worker_failure_does_not_crash_shared_node_or_prevent_disposal() {
    use serial_workbench_host::{
        node_backend::{NodeBackend, NodeBackendLimits},
        node_runtime::{NodeRuntimeLimits, verify_node_runtime},
    };
    use std::sync::Arc;
    let profile = support::Profile::isolated("node-backend-worker-");
    let store = serial_workbench_host::storage::Store::open(profile.path()).unwrap();
    let installer = NodePackageInstaller::new(store, profile.path()).unwrap();
    let mut files = payloads();
    files.insert(
        "dist/main.mjs".into(),
        br#"export async function register(context) {
        const worker = context.workers.start('dist/failure.mjs');
        const stopped = await worker.finished;
        if (stopped.exitCode !== 1) throw new Error('Expected real worker crash');
        return async () => {};
    }"#
        .to_vec(),
    );
    files.insert(
        "dist/failure.mjs".into(),
        b"throw new Error('isolated worker failure');".to_vec(),
    );
    let installed = installer
        .install(
            verify_local(&with_metadata(files, false)).unwrap(),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let id = installed.package.manifest.id.clone();
    let digest = installed.package.archive_sha256.clone();
    let trusted = installer
        .confirm_execution_trust(&id, installed.revision, &digest)
        .unwrap();
    let enabled = installer
        .set_enabled(&id, true, trusted.revision, &digest)
        .unwrap();
    let proof = installer
        .verify_installed(
            &id,
            enabled.revision,
            &digest,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let root = std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT")
        .expect("Explicit native runtime fixture is required");
    let runtime = verify_node_runtime(
        std::path::Path::new(&root),
        &NodeRuntimeLimits::default(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let backend = NodeBackend::start(
        runtime,
        NodeBackendLimits::default(),
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap();
    assert_eq!(backend.activate(proof, || Ok(())).unwrap().id, id);
    backend.dispose(id, || Ok(())).unwrap();
    let exit = backend.shutdown();
    assert!(exit.reaped);
    assert!(
        exit.error.is_none(),
        "Worker failure must leave shared control usable: {exit:?}"
    );
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_executes_a_declared_query_and_preserves_original_context() {
    use serial_workbench_core::*;
    use serial_workbench_host::{
        node_backend::{NodeBackend, NodeBackendLimits},
        node_runtime::{NodeRuntimeLimits, verify_node_runtime},
    };
    use std::sync::Arc;
    for dialect in [
        "http://json-schema.org/draft-07/schema#",
        "https://json-schema.org/draft/2020-12/schema",
    ] {
        let profile = support::Profile::isolated("node-backend-query-");
        let store = serial_workbench_host::storage::Store::open(profile.path()).unwrap();
        let installer = NodePackageInstaller::new(store, profile.path()).unwrap();
        let mut spec = BuiltinAction::HostMetrics.spec().clone();
        spec.action_id = Id::try_from("example.terminal.echo").unwrap();
        spec.permissions.clear();
        spec.state_scopes.clear();
        spec.event_types.clear();
        let definitions = if dialect.contains("2020-12") {
            "$defs"
        } else {
            "definitions"
        };
        let mut input = json!({
            "$schema":dialect, "type":"object",
            "properties":{"value":{"$ref":format!("#/{definitions}/argument")},"text":{"type":"string","pattern":r"(?<=ab)c"}},
            "required":["value"], "additionalProperties":false
        });
        input[definitions] = json!({"argument":{"type":"integer"}});
        spec.input_schema = serde_json::from_value(input).unwrap();
        spec.output_schema = serde_json::from_value(json!({
        "$schema":dialect, "type":"object",
        "properties":{"echo":{"type":"integer"},"calls":{"type":"integer"},"requestId":{"type":"string"},"epoch":{"const":"9007199254740993"}},
        "required":["echo","calls","requestId","epoch"], "additionalProperties":false
    })).unwrap();
        let mut metadata = manifest();
        metadata["contributes"]["queries"] = json!([spec]);
        let mut files = payloads();
        files.insert(
            "manifest.json".into(),
            serde_json::to_vec(&metadata).unwrap(),
        );
        files.insert("dist/main.mjs".into(), b"export function register(context) {let calls=0;context.queries.register('example.terminal.echo', async query => {calls++;if(query.params.value===17)throw new Error('fixture-private-query-error');return {echo:query.params.value===13?'invalid':query.params.value,calls,requestId:query.requestId,epoch:query.instanceEpoch};});return () => {}; }".to_vec());
        let installed = installer
            .install(
                verify_local(&with_metadata(files, false)).unwrap(),
                0.into(),
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap();
        let id = installed.package.manifest.id;
        let digest = installed.package.archive_sha256;
        let trusted = installer
            .confirm_execution_trust(&id, installed.revision, &digest)
            .unwrap();
        let enabled = installer
            .set_enabled(&id, true, trusted.revision, &digest)
            .unwrap();
        let proof = installer
            .verify_installed(
                &id,
                enabled.revision,
                &digest,
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap();
        let runtime = verify_node_runtime(
            std::path::Path::new(&std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT").unwrap()),
            &NodeRuntimeLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
        let backend = NodeBackend::start(
            runtime,
            NodeBackendLimits {
                schema_regex_backtrack_limit: 1,
                ..NodeBackendLimits::default()
            },
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        let registration = backend.activate(proof, || Ok(())).unwrap();
        assert_eq!(
            registration.contributes.queries,
            vec![spec.action_id.clone()]
        );
        let host_id = Id::try_from("query-host").unwrap();
        let query = Query {
            protocol_version: ProtocolVersion::V0_1,
            host_id: host_id.clone(),
            instance_epoch: 9_007_199_254_740_993u64.into(),
            actor_id: Id::try_from("query-reader").unwrap(),
            request_id: RequestId::try_from("11111111-2222-4333-8444-555555555555").unwrap(),
            action_id: spec.action_id,
            target: Target {
                host_id: host_id.clone(),
                kind: ResourceKind::try_from("host").unwrap(),
                id: host_id,
                session_id: None,
                session_epoch: None,
            },
            params: serde_json::from_value(json!({"value":7})).unwrap(),
            reveal_target: spec.reveal_target,
        };
        let value = backend.query(id.clone(), query.clone(), || Ok(())).unwrap();
        assert_eq!(
            value,
            json!({"echo":7,"calls":1,"requestId":"11111111-2222-4333-8444-555555555555","epoch":"9007199254740993"})
        );
        let mut limited = query.clone();
        limited.params = serde_json::from_value(json!({"value":7,"text":"abc"})).unwrap();
        assert_eq!(
            backend
                .query(id.clone(), limited, || Ok(()))
                .unwrap_err()
                .code,
            "LIMIT_EXCEEDED",
            "A regex work limit must not be misreported as an invalid user value"
        );
        let mut invalid = query.clone();
        invalid.params = serde_json::from_value(json!({"value":"not an integer"})).unwrap();
        assert_eq!(
            backend
                .query(id.clone(), invalid, || Ok(()))
                .unwrap_err()
                .code,
            "INVALID_ARGUMENT"
        );
        let second = backend.query(id.clone(), query.clone(), || Ok(())).unwrap();
        assert_eq!(
            second["calls"], 2,
            "Rejected inputs must never run the actual handler"
        );
        let mut bad_output = query.clone();
        bad_output.params = serde_json::from_value(json!({"value":13})).unwrap();
        assert_eq!(
            backend
                .query(id.clone(), bad_output, || Ok(()))
                .unwrap_err()
                .code,
            "NODE_QUERY_FAILED"
        );
        let mut thrown = query.clone();
        thrown.params = serde_json::from_value(json!({"value":17})).unwrap();
        let error = backend.query(id.clone(), thrown, || Ok(())).unwrap_err();
        assert_eq!(error.code, "NODE_QUERY_FAILED");
        assert!(
            !serde_json::to_string(&error)
                .unwrap()
                .contains("fixture-private-query-error")
        );
        assert_eq!(
            backend.query(id.clone(), query.clone(), || Ok(())).unwrap()["calls"],
            5,
            "Business failures must leave the shared backend usable"
        );
        std::thread::scope(|scope| {
            let (entered, waiting) = std::sync::mpsc::sync_channel(1);
            let (release, resume) = std::sync::mpsc::sync_channel(1);
            let resume = std::sync::Mutex::new(resume);
            let checks = std::sync::atomic::AtomicUsize::new(0);
            let backend_ref = &backend;
            let package = id.clone();
            let call = scope.spawn(move || {
                backend_ref.query(package, query, move || {
                    if checks.fetch_add(1, std::sync::atomic::Ordering::AcqRel) == 1 {
                        entered.send(()).unwrap();
                        resume
                            .lock()
                            .unwrap()
                            .recv_timeout(std::time::Duration::from_secs(10))
                            .map_err(|_| {
                                HostError::new("HOST_BUSY", "Native caller gate timed out")
                            })?;
                    }
                    Ok(())
                })
            });
            waiting
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            let (closed, receipt) = std::sync::mpsc::sync_channel(1);
            let backend_ref = &backend;
            let stopped_id = id.clone();
            scope.spawn(move || {
                let _ = closed.send(backend_ref.dispose(stopped_id, || Ok(())));
            });
            let disposed = receipt.recv_timeout(NodeBackendLimits::default().heartbeat_timeout);
            let replacement = installer
                .verify_installed(
                    &id,
                    enabled.revision,
                    &digest,
                    &NodePackageLimits::default(),
                    &AtomicBool::new(false),
                )
                .and_then(|proof| backend.activate(proof, || Ok(())));
            release.send(()).unwrap();
            assert!(
                disposed.is_ok(),
                "Waiting caller authorization must not block the Node supervisor or actual package disposal"
            );
            disposed.unwrap().unwrap();
            replacement.unwrap();
            assert_eq!(
                call.join().unwrap().unwrap_err().code,
                "CATALOG_CHANGED",
                "A query waiting outside admission must not run a replacement registration with an old definition"
            );
        });
        backend.dispose(id, || Ok(())).unwrap();
        let exit = backend.shutdown();
        assert!(
            exit.reaped && exit.error.is_none(),
            "Query resources must end before actual owner completion: {exit:?}"
        );
        assert!(String::from_utf8_lossy(&exit.stderr).contains("fixture-private-query-error"));
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_rejects_a_different_runtime_before_importing_package_code() {
    use serial_workbench_host::{
        node_backend::{NodeBackend, NodeBackendLimits},
        node_runtime::{NodeRuntimeLimits, verify_node_runtime},
    };
    use std::sync::Arc;
    let profile = support::Profile::isolated("node-backend-runtime-mismatch-");
    let store = serial_workbench_host::storage::Store::open(profile.path()).unwrap();
    let installer = NodePackageInstaller::new(store, profile.path()).unwrap();
    let marker = profile.path().join("mismatched-runtime-imported.txt");
    let mut declared = manifest();
    declared["runtimeRef"] = json!("node-999");
    let mut files = payloads();
    files.insert(
        "manifest.json".into(),
        serde_json::to_vec(&declared).unwrap(),
    );
    files.insert("dist/main.mjs".into(), format!("import {{writeFileSync}} from 'node:fs'; writeFileSync({}, 'imported'); export function register() {{ return () => {{}}; }}", serde_json::to_string(&marker).unwrap()).into_bytes());
    let installed = installer
        .install(
            verify_local(&with_metadata(files, false)).unwrap(),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let id = installed.package.manifest.id.clone();
    let digest = installed.package.archive_sha256.clone();
    let trusted = installer
        .confirm_execution_trust(&id, installed.revision, &digest)
        .unwrap();
    let enabled = installer
        .set_enabled(&id, true, trusted.revision, &digest)
        .unwrap();
    let proof = installer
        .verify_installed(
            &id,
            enabled.revision,
            &digest,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let root = std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT")
        .expect("Explicit native runtime fixture is required");
    let runtime = verify_node_runtime(
        std::path::Path::new(&root),
        &NodeRuntimeLimits::default(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let backend = NodeBackend::start(
        runtime,
        NodeBackendLimits::default(),
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap();
    let result = backend.activate(proof, || Ok(()));
    assert!(
        !marker.exists(),
        "Runtime mismatch must be rejected before any module import"
    );
    assert_eq!(result.unwrap_err().code, "NODE_RUNTIME_INCOMPATIBLE");
    let exit = backend.shutdown();
    assert!(exit.reaped);
    assert!(
        exit.error.is_none(),
        "Pre-dispatch rejection must leave Node usable: {exit:?}"
    );
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_never_resolves_esm_commonjs_or_worker_dependencies_from_profile_ancestors() {
    use serial_workbench_host::{
        node_backend::{NodeBackend, NodeBackendLimits},
        node_runtime::{NodeRuntimeLimits, verify_node_runtime},
    };
    use std::sync::Arc;
    for mode in [
        "esm",
        "commonjs",
        "worker",
        "packaged",
        "packaged-commonjs",
        "packaged-worker",
    ] {
        let profile = support::Profile::isolated("node-backend-ambient-module-");
        let store = serial_workbench_host::storage::Store::open(profile.path()).unwrap();
        let installer = NodePackageInstaller::new(store, profile.path()).unwrap();
        let marker = profile.path().join("unverified-dependency-ran.txt");
        let ambient = profile.path().join("node_modules/ambient-probe");
        std::fs::create_dir_all(&ambient).unwrap();
        std::fs::write(
            ambient.join("package.json"),
            br#"{"name":"ambient-probe","version":"1.0.0","main":"index.cjs"}"#,
        )
        .unwrap();
        std::fs::write(
            ambient.join("index.cjs"),
            format!(
                "require('node:fs').writeFileSync({}, 'unverified');",
                serde_json::to_string(&marker).unwrap()
            ),
        )
        .unwrap();
        let mut files = payloads();
        let code = match mode {
            "esm" => "import 'ambient-probe'; export function register() { return () => {}; }",
            "commonjs" => {
                "import {createRequire} from 'node:module'; createRequire(import.meta.url)('ambient-probe'); export function register() { return () => {}; }"
            }
            "packaged" => {
                "import probe from 'ambient-probe'; if (probe !== 'bundled') throw new Error('Expected bundled dependency'); export function register() { return () => {}; }"
            }
            "packaged-commonjs" => {
                "import {createRequire} from 'node:module'; if (createRequire(import.meta.url)('ambient-probe') !== 'bundled') throw new Error('Expected bundled dependency'); export function register() { return () => {}; }"
            }
            "packaged-worker" => {
                "export async function register(context) { const task = context.workers.start('dist/ambient.mjs'); const result = await task.finished; if (result.exitCode !== 0) throw new Error('Expected bundled worker dependency'); return () => {}; }"
            }
            _ => {
                "export async function register(context) { const task = context.workers.start('dist/ambient.mjs'); const result = await task.finished; if (result.exitCode !== 1) throw new Error('Expected dependency rejection in worker'); return () => {}; }"
            }
        };
        files.insert("dist/main.mjs".into(), code.as_bytes().to_vec());
        files.insert(
            "dist/ambient.mjs".into(),
            b"import 'ambient-probe';".to_vec(),
        );
        if mode.starts_with("packaged") {
            let mut declared = manifest();
            declared["dependencies"] = json!([{"name":"ambient-probe","version":"1.0.0","path":"node_modules/ambient-probe","license":"MIT"}]);
            files.insert(
                "manifest.json".into(),
                serde_json::to_vec(&declared).unwrap(),
            );
            files.insert(
                "node_modules/ambient-probe/package.json".into(),
                br#"{"name":"ambient-probe","version":"1.0.0","main":"index.cjs"}"#.to_vec(),
            );
            files.insert(
                "node_modules/ambient-probe/index.cjs".into(),
                b"module.exports='bundled';".to_vec(),
            );
        }
        let installed = installer
            .install(
                verify_local(&with_metadata(files, false)).unwrap(),
                0.into(),
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap();
        let id = installed.package.manifest.id.clone();
        let digest = installed.package.archive_sha256.clone();
        let trusted = installer
            .confirm_execution_trust(&id, installed.revision, &digest)
            .unwrap();
        let enabled = installer
            .set_enabled(&id, true, trusted.revision, &digest)
            .unwrap();
        let proof = installer
            .verify_installed(
                &id,
                enabled.revision,
                &digest,
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap();
        let root = std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT")
            .expect("Explicit native runtime fixture is required");
        let runtime = verify_node_runtime(
            std::path::Path::new(&root),
            &NodeRuntimeLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
        let backend = NodeBackend::start(
            runtime,
            NodeBackendLimits::default(),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        let result = backend.activate(proof, || Ok(()));
        assert!(
            !marker.exists(),
            "{mode} must not execute any dependency outside the proved package"
        );
        if mode == "worker" || mode.starts_with("packaged") {
            assert!(
                result.is_ok(),
                "Rejected worker import must leave shared Node usable: {result:?}"
            );
        } else {
            assert_eq!(result.unwrap_err().code, "NODE_REGISTRATION_FAILED");
        }
        let exit = backend.shutdown();
        assert!(exit.reaped);
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_disposal_terminates_busy_workers_before_awaiting_plugin_cleanup() {
    use serial_workbench_host::{
        node_backend::{NodeBackend, NodeBackendLimits},
        node_runtime::{NodeRuntimeLimits, verify_node_runtime},
    };
    use std::{
        sync::Arc,
        time::{Duration, Instant},
    };
    let profile = support::Profile::isolated("node-backend-worker-disposal-");
    let store = serial_workbench_host::storage::Store::open(profile.path()).unwrap();
    let installer = NodePackageInstaller::new(store, profile.path()).unwrap();
    let marker = profile.path().join("busy-worker-state.txt");
    let marker_json = serde_json::to_string(&marker).unwrap();
    let mut files = payloads();
    files.insert("dist/main.mjs".into(), format!("import {{writeFileSync}} from 'node:fs'; export function register(context) {{ const worker = context.workers.start('dist/busy.mjs'); return async () => {{ const result = await worker.finished; writeFileSync({marker_json}, 'exited:'+result.exitCode); }}; }}").into_bytes());
    files.insert("dist/busy.mjs".into(), format!("import {{renameSync,writeFileSync}} from 'node:fs';{PUBLISH_MARKER_JS}publishMarker({marker_json}, 'busy'); while (true) {{}} ").into_bytes());
    let installed = installer
        .install(
            verify_local(&with_metadata(files, false)).unwrap(),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let id = installed.package.manifest.id.clone();
    let digest = installed.package.archive_sha256.clone();
    let trusted = installer
        .confirm_execution_trust(&id, installed.revision, &digest)
        .unwrap();
    let enabled = installer
        .set_enabled(&id, true, trusted.revision, &digest)
        .unwrap();
    let proof = installer
        .verify_installed(
            &id,
            enabled.revision,
            &digest,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let root = std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT")
        .expect("Explicit native runtime fixture is required");
    let runtime = verify_node_runtime(
        std::path::Path::new(&root),
        &NodeRuntimeLimits::default(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let backend = NodeBackend::start(
        runtime,
        NodeBackendLimits::default(),
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap();
    backend.activate(proof, || Ok(())).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !marker.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        std::fs::read_to_string(&marker).unwrap(),
        "busy",
        "Worker must enter real CPU work before disposal"
    );
    backend.dispose(id, || Ok(())).unwrap();
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "exited:1");
    let exit = backend.shutdown();
    assert!(exit.reaped);
    assert!(
        exit.error.is_none(),
        "Shared Node must remain responsive after terminating its worker: {exit:?}"
    );
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_reclaims_finished_worker_capacity_across_140_background_tasks() {
    use serial_workbench_host::{
        node_backend::{NodeBackend, NodeBackendLimits},
        node_runtime::{NodeRuntimeLimits, verify_node_runtime},
    };
    use std::{
        sync::Arc,
        time::{Duration, Instant},
    };
    let profile = support::Profile::isolated("node-backend-worker-reuse-");
    let store = serial_workbench_host::storage::Store::open(profile.path()).unwrap();
    let installer = NodePackageInstaller::new(store, profile.path()).unwrap();
    let marker = profile.path().join("completed-workers.txt");
    let marker_json = serde_json::to_string(&marker).unwrap();
    let mut files = payloads();
    files.insert("dist/main.mjs".into(), format!("import {{renameSync,writeFileSync}} from 'node:fs';{PUBLISH_MARKER_JS}export function register(context) {{ const work = (async () => {{ for (let count=0; count<140; count++) {{ const result = await context.workers.start('dist/empty.mjs').finished; if (result.exitCode !== 0) throw new Error('Worker failed'); }} publishMarker({marker_json}, '140'); }})(); const settled = work.catch(() => publishMarker({marker_json}, 'failed')); context.onDispose(() => settled); return () => {{}}; }}").into_bytes());
    files.insert(
        "dist/empty.mjs".into(),
        b"export const completed = true;".to_vec(),
    );
    let installed = installer
        .install(
            verify_local(&with_metadata(files, false)).unwrap(),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let id = installed.package.manifest.id.clone();
    let digest = installed.package.archive_sha256.clone();
    let trusted = installer
        .confirm_execution_trust(&id, installed.revision, &digest)
        .unwrap();
    let enabled = installer
        .set_enabled(&id, true, trusted.revision, &digest)
        .unwrap();
    let proof = installer
        .verify_installed(
            &id,
            enabled.revision,
            &digest,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let root = std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT")
        .expect("Explicit native runtime fixture is required");
    let runtime = verify_node_runtime(
        std::path::Path::new(&root),
        &NodeRuntimeLimits::default(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let backend = NodeBackend::start(
        runtime,
        NodeBackendLimits::default(),
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap();
    backend.activate(proof, || Ok(())).unwrap();
    // 后台批次有独立总时长，接纳/清理仍保留默认五秒命令预算。
    let deadline = Instant::now() + Duration::from_secs(30);
    while !marker.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        std::fs::read_to_string(&marker).unwrap(),
        "140",
        "Completed workers must return capacity instead of filling a historical cleanup list"
    );
    backend.dispose(id, || Ok(())).unwrap();
    let exit = backend.shutdown();
    assert!(exit.reaped);
    assert!(
        exit.error.is_none(),
        "Background worker reuse must leave shared Node usable: {exit:?}"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_enable_disable_reports_actual_runtime_and_disposes_code() {
    use serial_workbench_core::*;
    use serial_workbench_host::node_runtime::{NodeRuntimeLimits, verify_node_runtime};
    let root = std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT")
        .expect("Explicit native runtime fixture is required");
    let runtime = tokio::task::spawn_blocking(move || {
        verify_node_runtime(
            std::path::Path::new(&root),
            &NodeRuntimeLimits::default(),
            &AtomicBool::new(false),
        )
    })
    .await
    .unwrap()
    .unwrap();
    let h = support::Harness::with_node_runtime(runtime).await;
    let target = Target {
        host_id: h.host_id.clone(),
        id: h.host_id.clone(),
        kind: ResourceKind::try_from("host").unwrap(),
        session_id: None,
        session_epoch: None,
    };
    let operator = h
        .auth
        .authenticate_user_control(
            &support::id("operator"),
            &ContextToken::try_from("test-user-control").unwrap(),
        )
        .unwrap();
    h.auth
        .authorize(
            &operator,
            AuthorizeParams {
                client_id: support::id("client"),
                permissions: vec!["plugins.manage".into()],
                targets: vec![target.clone()],
                expires_at: None,
            },
        )
        .unwrap();
    let marker = h.dir.path().join("host-managed-node.txt");
    let marker_json = serde_json::to_string(&marker).unwrap();
    let mut files = payloads();
    files.insert("dist/main.mjs".into(), format!("import {{writeFileSync}} from 'node:fs'; export function register() {{ writeFileSync({marker_json}, 'registered'); return () => writeFileSync({marker_json}, 'disposed'); }}").into_bytes());
    let store = h.store.clone();
    let profile = h.dir.path().to_path_buf();
    let (id, digest) = tokio::task::spawn_blocking(move || {
        let installer = NodePackageInstaller::new(store, &profile).unwrap();
        let installed = installer
            .install(
                verify_local(&with_metadata(files, false)).unwrap(),
                0.into(),
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap();
        installer
            .confirm_execution_trust(
                &installed.package.manifest.id,
                installed.revision,
                &installed.package.archive_sha256,
            )
            .unwrap();
        (
            installed.package.manifest.id,
            installed.package.archive_sha256,
        )
    })
    .await
    .unwrap();
    assert!(!marker.exists());
    let mut enable = h.call(
        &target,
        "node.packages.setEnabled",
        json!({"id":id,"archiveSha256":digest,"enabled":true}),
    );
    enable.expected_revision = Some(2.into());
    let accepted = h.host.invoke(&h.actor, enable).await.unwrap();
    let enabled = h.wait(&accepted.operation_id).await;
    assert_eq!(enabled.state, OperationState::Succeeded, "{enabled:?}");
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "registered");
    let q = h.call(&target, "node.packages.runtime", json!({"id":id}));
    let status = h
        .host
        .query(
            &h.actor,
            Query {
                protocol_version: q.protocol_version,
                host_id: q.host_id,
                instance_epoch: q.instance_epoch,
                actor_id: q.actor_id,
                request_id: q.request_id,
                action_id: q.action_id,
                target: q.target,
                params: q.params,
                reveal_target: q.reveal_target,
            },
        )
        .await
        .unwrap();
    let status = serde_json::to_value(status).unwrap();
    assert_eq!(status["value"]["phase"], "active");
    let mut disable = h.call(
        &target,
        "node.packages.setEnabled",
        json!({"id":id,"archiveSha256":digest,"enabled":false}),
    );
    disable.expected_revision = Some(3.into());
    let accepted = h.host.invoke(&h.actor, disable).await.unwrap();
    let disabled = h.wait(&accepted.operation_id).await;
    assert_eq!(disabled.state, OperationState::Succeeded, "{disabled:?}");
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "disposed");
    let listed = serde_json::to_value(disabled.result.unwrap()).unwrap();
    assert_eq!(listed["value"]["package"]["enabled"], false);
    h.host.shutdown().await.unwrap();
}

struct ManagedNodeFixture {
    h: support::Harness,
    target: serial_workbench_core::Target,
    id: serial_workbench_core::NodePackageId,
    digest: serial_workbench_core::Digest,
    marker: std::path::PathBuf,
}
impl ManagedNodeFixture {
    async fn new(failing_register: bool) -> Self {
        Self::build(failing_register, false).await
    }
    async fn build(failing_register: bool, queries: bool) -> Self {
        use serial_workbench_core::*;
        use serial_workbench_host::node_runtime::{NodeRuntimeLimits, verify_node_runtime};
        let root = std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT")
            .expect("Explicit native runtime fixture is required");
        let runtime = tokio::task::spawn_blocking(move || {
            verify_node_runtime(
                std::path::Path::new(&root),
                &NodeRuntimeLimits::default(),
                &AtomicBool::new(false),
            )
        })
        .await
        .unwrap()
        .unwrap();
        let h = support::Harness::with_node_runtime(runtime).await;
        let target = Target {
            host_id: h.host_id.clone(),
            id: h.host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            session_id: None,
            session_epoch: None,
        };
        let operator = h
            .auth
            .authenticate_user_control(
                &support::id("operator"),
                &ContextToken::try_from("test-user-control").unwrap(),
            )
            .unwrap();
        h.auth
            .authorize(
                &operator,
                AuthorizeParams {
                    client_id: support::id("client"),
                    permissions: vec!["plugins.manage".into()],
                    targets: vec![target.clone()],
                    expires_at: None,
                },
            )
            .unwrap();
        let marker = h.dir.path().join("managed-node-state.txt");
        let marker_json = serde_json::to_string(&marker).unwrap();
        let script = if failing_register {
            format!(
                "import {{writeFileSync}} from 'node:fs'; export function register(context) {{ context.onDispose(() => writeFileSync({marker_json}, 'partial-cleaned')); throw new Error('registration refused'); }}"
            )
        } else if queries {
            format!(
                "import {{writeFileSync}} from 'node:fs'; export function register(context) {{ writeFileSync({marker_json}, 'registered'); context.queries.register('example.terminal.echo', query => {{ writeFileSync({marker_json}, 'queried'); return {{echo:query.params.value,measurement:{{ratio:1.5}},actorId:query.actorId,requestId:query.requestId,epoch:query.instanceEpoch}}; }}); return () => writeFileSync({marker_json}, 'disposed'); }}"
            )
        } else {
            format!(
                "import {{writeFileSync}} from 'node:fs'; export function register() {{ writeFileSync({marker_json}, 'registered'); return () => writeFileSync({marker_json}, 'disposed'); }}"
            )
        };
        let mut files = payloads();
        files.insert("dist/main.mjs".into(), script.into_bytes());
        if queries {
            let mut metadata = manifest();
            let mut spec = BuiltinAction::HostMetrics.spec().clone();
            spec.action_id = support::id("example.terminal.echo");
            spec.reveal_target = serde_json::from_value(json!({"pageId":"workbench"})).unwrap();
            spec.permissions = vec!["content.read".into()];
            spec.state_scopes.clear();
            spec.event_types.clear();
            spec.input_schema = serde_json::from_value(json!({"type":"object","properties":{"value":{"type":"integer"}},"required":["value"],"additionalProperties":false})).unwrap();
            spec.output_schema = serde_json::from_value(json!({"type":"object","properties":{"echo":{"type":"integer"},"measurement":{"type":"object","properties":{"ratio":{"type":"number"}},"required":["ratio"]},"actorId":{"type":"string"},"requestId":{"type":"string"},"epoch":{"type":"string"}},"required":["echo","measurement","actorId","requestId","epoch"],"additionalProperties":false})).unwrap();
            let mut hidden = spec.clone();
            hidden.action_id = support::id("example.terminal.hidden");
            metadata["contributes"]["queries"] = json!([spec, hidden]);
            metadata["permissions"]["hostApi"] =
                json!([{"permissions":["content.read"],"targetKinds":["host"]}]);
            files.insert(
                "manifest.json".into(),
                serde_json::to_vec(&metadata).unwrap(),
            );
        }
        let store = h.store.clone();
        let profile = h.dir.path().to_path_buf();
        let (id, digest) = tokio::task::spawn_blocking(move || {
            let installer = NodePackageInstaller::new(store, &profile).unwrap();
            let installed = installer
                .install(
                    verify_local(&with_metadata(files, false)).unwrap(),
                    0.into(),
                    &NodePackageLimits::default(),
                    &AtomicBool::new(false),
                )
                .unwrap();
            installer
                .confirm_execution_trust(
                    &installed.package.manifest.id,
                    installed.revision,
                    &installed.package.archive_sha256,
                )
                .unwrap();
            (
                installed.package.manifest.id,
                installed.package.archive_sha256,
            )
        })
        .await
        .unwrap();
        Self {
            h,
            target,
            id,
            digest,
            marker,
        }
    }
    async fn enabled(&self, enabled: bool, revision: u64) -> serial_workbench_core::Operation {
        let mut call = self.h.call(
            &self.target,
            "node.packages.setEnabled",
            json!({"id":self.id,"archiveSha256":self.digest,"enabled":enabled}),
        );
        call.expected_revision = Some(revision.into());
        let accepted = self.h.host.invoke(&self.h.actor, call).await.unwrap();
        self.h.wait(&accepted.operation_id).await
    }
    async fn status(&self) -> serial_workbench_core::NodePackageRuntimeStatus {
        use serial_workbench_core::*;
        let q = self
            .h
            .call(&self.target, "node.packages.runtime", json!({"id":self.id}));
        let result = self
            .h
            .host
            .query(
                &self.h.actor,
                Query {
                    protocol_version: q.protocol_version,
                    host_id: q.host_id,
                    instance_epoch: q.instance_epoch,
                    actor_id: q.actor_id,
                    request_id: q.request_id,
                    action_id: q.action_id,
                    target: q.target,
                    params: q.params,
                    reveal_target: q.reveal_target,
                },
            )
            .await
            .unwrap();
        let QueryResult::NodePackageRuntime(status) = result else {
            panic!("Expected runtime status")
        };
        status
    }
    async fn query(
        &self,
        actor: &serial_workbench_host::auth::AuthenticatedActor,
        action: &str,
        params: Value,
    ) -> serial_workbench_core::HostResult<serial_workbench_core::QueryResult> {
        let call = self.h.call_as(actor, &self.target, action, params);
        self.h
            .host
            .query(
                actor,
                serial_workbench_core::Query {
                    protocol_version: call.protocol_version,
                    host_id: call.host_id,
                    instance_epoch: call.instance_epoch,
                    actor_id: call.actor_id,
                    request_id: call.request_id,
                    action_id: call.action_id,
                    target: call.target,
                    params: call.params,
                    reveal_target: call.reveal_target,
                },
            )
            .await
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_catalog_and_query_follow_actual_registration_and_authority() {
    use serial_workbench_core::*;
    let f = ManagedNodeFixture::build(false, true).await;
    let operator =
        f.h.auth
            .authenticate_user_control(
                &support::id("catalog-operator"),
                &ContextToken::try_from("test-user-control").unwrap(),
            )
            .unwrap();
    let reader =
        f.h.auth
            .authenticate(&support::id("query-reader"), None)
            .unwrap()
            .actor;
    let QueryResult::Catalog(before) = f
        .query(&reader, "catalog.list", json!({"pageSize":"1"}))
        .await
        .unwrap()
    else {
        panic!("Expected catalog")
    };
    assert_eq!(f.enabled(true, 2).await.state, OperationState::Succeeded);
    assert_eq!(f.status().await.phase, NodePackageRuntimePhase::Active);
    let QueryResult::Catalog(filtered) = f
        .query(&reader, "catalog.list", json!({"pageSize":"100"}))
        .await
        .unwrap()
    else {
        panic!("Expected catalog")
    };
    assert!(
        !filtered
            .items
            .iter()
            .any(|spec| spec.action_id.as_str() == "example.terminal.echo")
    );
    assert_eq!(
        f.query(&reader, "example.terminal.echo", json!({"value":7}))
            .await
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    let checked = f
        .query(
            &reader,
            "action.check",
            json!({"actionId":"example.terminal.echo","params":{"value":7}}),
        )
        .await
        .unwrap();
    let QueryResult::ActionCheck(checked) = checked else {
        panic!("Expected permission check")
    };
    assert!(!checked.allowed);
    assert_eq!(std::fs::read_to_string(&f.marker).unwrap(), "registered");
    f.h.auth
        .authorize(
            &operator,
            AuthorizeParams {
                client_id: support::id("query-reader"),
                permissions: vec!["content.read".into()],
                targets: vec![f.target.clone()],
                expires_at: None,
            },
        )
        .unwrap();
    let QueryResult::Catalog(active) = f
        .query(&reader, "catalog.list", json!({"pageSize":"100"}))
        .await
        .unwrap()
    else {
        panic!("Expected catalog")
    };
    assert!(
        active
            .items
            .iter()
            .any(|spec| spec.action_id.as_str() == "example.terminal.echo"),
        "Only a real, active registration may become publicly callable"
    );
    assert!(
        !active
            .items
            .iter()
            .any(|spec| spec.action_id.as_str() == "example.terminal.hidden")
    );
    assert!(active.catalog_version > before.catalog_version);
    assert_eq!(f.query(&reader, "catalog.list", json!({"pageSize":"1","pageToken":before.next_page_token.unwrap(),"catalogVersion":before.catalog_version})).await.unwrap_err().code, "CATALOG_CHANGED");
    let checked = f
        .query(
            &reader,
            "action.check",
            json!({"actionId":"example.terminal.echo","params":{"value":7}}),
        )
        .await
        .unwrap();
    let QueryResult::ActionCheck(checked) = checked else {
        panic!("Expected permission check")
    };
    assert!(checked.allowed);
    assert_eq!(
        std::fs::read_to_string(&f.marker).unwrap(),
        "registered",
        "Permission checking must not run the real query handler"
    );
    let output = f
        .query(&reader, "example.terminal.echo", json!({"value":7}))
        .await
        .unwrap();
    let output = serde_json::to_value(output).unwrap();
    assert_eq!(output["value"]["measurement"]["ratio"], 1.5);
    assert_eq!(output["kind"], "extension");
    assert_eq!(output["value"]["echo"], 7);
    assert_eq!(output["value"]["actorId"], reader.id().as_str());
    assert_eq!(
        output["value"]["epoch"],
        f.h.store.identity().unwrap().instance_epoch.to_string()
    );
    assert_eq!(
        f.query(&reader, "example.terminal.echo", json!({"value":"invalid"}))
            .await
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
    f.h.auth
        .revoke(
            &operator,
            RevokeParams {
                actor_id: reader.id().clone(),
                permissions: vec!["content.read".into()],
                targets: vec![f.target.clone()],
            },
        )
        .unwrap();
    let QueryResult::Catalog(revoked) = f
        .query(&reader, "catalog.list", json!({"pageSize":"100"}))
        .await
        .unwrap()
    else {
        panic!("Expected catalog")
    };
    assert_eq!(
        revoked.catalog_version, active.catalog_version,
        "Caller permission filtering must not create a global business catalog version"
    );
    assert!(
        !revoked
            .items
            .iter()
            .any(|spec| spec.action_id.as_str() == "example.terminal.echo")
    );
    assert_eq!(
        f.query(&reader, "example.terminal.echo", json!({"value":7}))
            .await
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    assert_eq!(f.status().await.phase, NodePackageRuntimePhase::Active);
    assert_eq!(f.enabled(false, 3).await.state, OperationState::Succeeded);
    let QueryResult::Catalog(stopped) = f
        .query(&reader, "catalog.list", json!({"pageSize":"100"}))
        .await
        .unwrap()
    else {
        panic!("Expected catalog")
    };
    assert!(stopped.catalog_version > active.catalog_version);
    assert!(
        !stopped
            .items
            .iter()
            .any(|spec| spec.action_id.as_str() == "example.terminal.echo")
    );
    assert_eq!(
        f.query(&reader, "example.terminal.echo", json!({"value":7}))
            .await
            .unwrap_err()
            .code,
        "UNSUPPORTED_CAPABILITY"
    );
    f.h.host.shutdown().await.unwrap();
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_registration_failure_preserves_saved_intent_and_actual_cleanup() {
    use serial_workbench_core::*;
    let f = ManagedNodeFixture::new(true).await;
    let failed = f.enabled(true, 2).await;
    assert_eq!(failed.state, OperationState::Failed, "{failed:?}");
    assert_eq!(failed.error.unwrap().code, "NODE_REGISTRATION_FAILED");
    let Some(ActionResult::NodePackageChanged(saved)) = failed.result else {
        panic!("Committed intent must survive activation failure")
    };
    assert_eq!(saved.revision, 3.into());
    assert!(saved.package.enabled);
    assert_eq!(
        std::fs::read_to_string(&f.marker).unwrap(),
        "partial-cleaned"
    );
    let status = f.status().await;
    assert_eq!(status.phase, NodePackageRuntimePhase::Failed);
    assert_eq!(status.error.unwrap().code, "NODE_REGISTRATION_FAILED");
    f.h.host.shutdown().await.unwrap();
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_upgrade_stops_old_registration_before_new_installation_commits() {
    use serial_workbench_core::*;
    let f = ManagedNodeFixture::new(false).await;
    assert_eq!(f.enabled(true, 2).await.state, OperationState::Succeeded);
    let mut next = payloads();
    let mut declared = manifest();
    declared["version"] = json!("2.0.0");
    next.insert(
        "manifest.json".into(),
        serde_json::to_vec(&declared).unwrap(),
    );
    let bytes = archive(&with_metadata(next, false));
    let path = f.h.dir.path().join("upgrade.zip");
    std::fs::write(&path, bytes).unwrap();
    let operator =
        f.h.auth
            .authenticate_user_control(
                &support::id("operator"),
                &ContextToken::try_from("test-user-control").unwrap(),
            )
            .unwrap();
    let files = f.h.host.files().clone();
    let reference = tokio::task::spawn_blocking(move || {
        files.register(
            RegisterFileParams {
                path: path.to_str().unwrap().into(),
                purpose: FilePurpose::ReadFile,
            },
            &operator,
        )
    })
    .await
    .unwrap()
    .unwrap();
    let mut call = f.h.call(
        &f.target,
        "node.packages.install",
        json!({"archiveRef":reference,"source":{"kind":"local"}}),
    );
    call.expected_revision = Some(3.into());
    let accepted = f.h.host.invoke(&f.h.actor, call).await.unwrap();
    let installed = f.h.wait(&accepted.operation_id).await;
    assert_eq!(installed.state, OperationState::Succeeded, "{installed:?}");
    assert_eq!(
        std::fs::read_to_string(&f.marker).unwrap(),
        "disposed",
        "Installation must settle the old owner before exposing a new local untrusted version"
    );
    assert_eq!(f.status().await.phase, NodePackageRuntimePhase::Inactive);
    let Some(ActionResult::NodePackageInstalled(installed)) = installed.result else {
        panic!("Expected install receipt")
    };
    assert!(!installed.package.enabled);
    assert!(!installed.package.execution_approved);
    f.h.host.shutdown().await.unwrap();
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_rechecks_active_authority_while_another_package_waits_in_register() {
    use serial_workbench_core::HostError;
    use serial_workbench_host::{
        node_backend::{NodeBackend, NodeBackendLimits},
        node_runtime::{NodeRuntimeLimits, verify_node_runtime},
    };
    use std::{
        sync::{Arc, atomic::Ordering},
        time::{Duration, Instant},
    };
    let profile = support::Profile::isolated("node-backend-cross-authority-");
    let store = serial_workbench_host::storage::Store::open(profile.path()).unwrap();
    let installer = NodePackageInstaller::new(store, profile.path()).unwrap();
    let ready = profile.path().join("second-register-waiting.txt");
    let counter = profile.path().join("first-still-running.txt");
    let scripts = [
        (
            "example.terminal",
            format!(
                "import {{writeFileSync}} from 'node:fs'; export function register() {{ let count=0; const timer=setInterval(() => writeFileSync({},String(++count)),20); return () => clearInterval(timer); }}",
                serde_json::to_string(&counter).unwrap()
            ),
        ),
        (
            "example.waiter",
            format!(
                "import {{writeFileSync}} from 'node:fs'; export async function register(context) {{ writeFileSync({},'waiting'); await new Promise(() => {{}}); return () => {{}}; }}",
                serde_json::to_string(&ready).unwrap()
            ),
        ),
    ];
    let mut installed = Vec::new();
    let mut revision = 0.into();
    for (id, script) in scripts {
        let mut declared = manifest();
        declared["id"] = json!(id);
        let mut files = payloads();
        files.insert(
            "manifest.json".into(),
            serde_json::to_vec(&declared).unwrap(),
        );
        files.insert("dist/main.mjs".into(), script.into_bytes());
        let receipt = installer
            .install(
                verify_local(&with_metadata(files, false)).unwrap(),
                revision,
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap();
        let id = receipt.package.manifest.id;
        let digest = receipt.package.archive_sha256;
        let trust = installer
            .confirm_execution_trust(&id, receipt.revision, &digest)
            .unwrap();
        revision = installer
            .set_enabled(&id, true, trust.revision, &digest)
            .unwrap()
            .revision;
        installed.push((id, digest));
    }
    let mut proofs = installed
        .iter()
        .map(|(id, digest)| {
            installer
                .verify_installed(
                    id,
                    revision,
                    digest,
                    &NodePackageLimits::default(),
                    &AtomicBool::new(false),
                )
                .unwrap()
        })
        .collect::<Vec<_>>();
    let second = proofs.pop().unwrap();
    let first = proofs.pop().unwrap();
    let root = std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT").unwrap();
    let runtime = verify_node_runtime(
        std::path::Path::new(&root),
        &NodeRuntimeLimits::default(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let backend = NodeBackend::start(
        runtime,
        NodeBackendLimits::default(),
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap();
    let allowed = Arc::new(AtomicBool::new(true));
    let authority = allowed.clone();
    backend
        .activate(first, move || {
            if authority.load(Ordering::Acquire) {
                Ok(())
            } else {
                Err(HostError::new(
                    "PERMISSION_DENIED",
                    "Execution authority revoked",
                ))
            }
        })
        .unwrap();
    let result = std::thread::scope(|scope| {
        let running = &backend;
        let registration = scope.spawn(move || running.activate(second, || Ok(())));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            ready.exists(),
            "Second register must actually begin waiting"
        );
        allowed.store(false, Ordering::Release);
        registration.join().unwrap()
    });
    assert_eq!(
        result.unwrap_err().code,
        "NODE_BACKEND_INTERRUPTED",
        "An already active owner's revoked authority must be checked before the other registration deadline"
    );
    let exit = backend.shutdown();
    assert!(exit.reaped);
}

#[test]
#[ignore = "Internal child entry: only the native parent-exit test supplies its fixture directory"]
fn node_backend_parent_exit_fixture() {
    use serial_workbench_host::{
        node_backend::{NodeBackend, NodeBackendLimits},
        node_runtime::{NodeRuntimeLimits, verify_node_runtime},
    };
    use std::sync::Arc;
    let directory = std::path::PathBuf::from(
        std::env::var_os("SWB_NODE_PARENT_EXIT_PROFILE")
            .expect("Native parent test must provide the owned directory"),
    );
    let mode = std::env::var("SWB_NODE_PARENT_EXIT_MODE").unwrap();
    let marker = serde_json::to_string(&directory.join("node.pid")).unwrap();
    let child_marker = serde_json::to_string(&directory.join("child.pid")).unwrap();
    let supervisor_marker = serde_json::to_string(&directory.join("supervisor.pid")).unwrap();
    let observer_marker = serde_json::to_string(&directory.join("observer.pid")).unwrap();
    let publish_node = format!(
        "import {{renameSync,writeFileSync}} from 'node:fs';{PUBLISH_MARKER_JS}
         const publishNode = () => publishMarker({marker}, String(process.pid));"
    );
    let mut files = payloads();
    let script = match mode.as_str() {
        "main" => format!(
            "{publish_node}export function register() {{publishNode(); while(true) {{}} }}"
        ),
        "await" => format!(
            "{publish_node}export async function register() {{publishNode(); await new Promise(() => {{}}); return () => {{}}; }}"
        ),
        "worker" => {
            files.insert("dist/busy.mjs".into(),format!("{publish_node}publishNode(); while(true) {{}}").into_bytes());
            "export function register(context) {context.workers.start('dist/busy.mjs'); return () => {}; }".into()
        }
        "guardian-busy" => format!(
            "{publish_node}import {{spawn,spawnSync}} from 'node:child_process';
             export function register() {{
               process.on('SIGHUP', () => {{}});
               const child = spawn('/bin/sleep', ['300'], {{stdio:'ignore'}});
               writeFileSync({child_marker},String(child.pid));
               writeFileSync({supervisor_marker},String(process.ppid));
               const group = spawnSync('/bin/ps', ['-p',String(process.ppid),'-o','pgid='], {{encoding:'utf8'}});
               if(group.status !== 0) throw new Error('Native monitor group lookup failed');
               writeFileSync({observer_marker},group.stdout.trim());
               publishNode();
               while(true) {{}}
             }}"
        ),
        "child-main" | "child-await" => {
            let waiting = if mode == "child-main" {
                "while(true) {}"
            } else {
                "await new Promise(() => {});"
            };
            format!(
                "{publish_node}import {{spawn}} from 'node:child_process';
                export async function register() {{
                  const child = process.platform === 'win32'
                    ? spawn(process.execPath, ['--eval', 'setInterval(() => {{}}, 1000)'], {{stdio:'ignore',windowsHide:true}})
                    : spawn('/bin/sleep', ['300'], {{stdio:'ignore'}});
                  await new Promise((resolve,reject) => {{child.once('spawn',resolve);child.once('error',reject);}});
                  writeFileSync({child_marker},String(child.pid));
                  publishNode();
                  {waiting}
                }}"
            )
        }
        _ => panic!("Unknown native parent fixture mode"),
    };
    files.insert("dist/main.mjs".into(), script.into_bytes());
    let store = serial_workbench_host::storage::Store::open(&directory).unwrap();
    let installer = NodePackageInstaller::new(store, &directory).unwrap();
    let receipt = installer
        .install(
            verify_local(&with_metadata(files, false)).unwrap(),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let id = receipt.package.manifest.id;
    let digest = receipt.package.archive_sha256;
    let trust = installer
        .confirm_execution_trust(&id, receipt.revision, &digest)
        .unwrap();
    let enabled = installer
        .set_enabled(&id, true, trust.revision, &digest)
        .unwrap();
    let proof = installer
        .verify_installed(
            &id,
            enabled.revision,
            &digest,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let root = std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT").unwrap();
    let runtime = verify_node_runtime(
        std::path::Path::new(&root),
        &NodeRuntimeLimits::default(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let backend = NodeBackend::start(
        runtime,
        NodeBackendLimits::default(),
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap();
    let result = backend.activate(proof, || Ok(()));
    if mode == "guardian-busy" {
        assert_eq!(result.unwrap_err().code, "NODE_BACKEND_INTERRUPTED");
        let exit = backend.shutdown();
        std::fs::write(directory.join("closed.tmp"), serde_json::to_vec(&json!({
            "processId":exit.process_id,"reaped":exit.reaped,"error":exit.error.map(|error|error.code)
        })).unwrap()).unwrap();
        std::fs::rename(directory.join("closed.tmp"), directory.join("closed.json")).unwrap();
    } else {
        result.unwrap();
    }
    loop {
        std::thread::park();
    }
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "Requires the prepared native macOS distribution and its compiled image binding"]
fn verified_backend_native_owner_loss_stops_busy_node_and_child() {
    use std::os::unix::process::CommandExt;
    use std::{
        process::{Child, Command, Stdio},
        time::{Duration, Instant},
    };
    struct Parent(Child);
    impl Drop for Parent {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    for failure in ["supervisor", "host-group", "native-group", "observer"] {
        let profile = support::Profile::isolated("node-backend-supervisor-loss-");
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.process_group(0);
        let mut parent = Parent(
            command
                .args([
                    "--ignored",
                    "--exact",
                    "node_backend_parent_exit_fixture",
                    "--nocapture",
                ])
                .env("SWB_NODE_PARENT_EXIT_PROFILE", profile.path())
                .env("SWB_NODE_PARENT_EXIT_MODE", "guardian-busy")
                .stdin(Stdio::null())
                .stdout(std::fs::File::create_new(profile.path().join("host.stdout")).unwrap())
                .stderr(std::fs::File::create_new(profile.path().join("host.stderr")).unwrap())
                .spawn()
                .unwrap(),
        );
        let marker = profile.path().join("node.pid");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !marker.exists() && Instant::now() < deadline {
            assert!(
                parent.0.try_wait().unwrap().is_none(),
                "Fixture exited before the actual native owner marker"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        let pid = |name| {
            std::fs::read_to_string(profile.path().join(name))
                .unwrap()
                .parse::<u32>()
                .unwrap()
        };
        let node_pid = pid("node.pid");
        let owner_pid = pid("supervisor.pid");
        let mut node = node_owner_exit::ProcessExit::new(node_pid);
        let mut child = node_owner_exit::ProcessExit::new(pid("child.pid"));
        let mut owner = node_owner_exit::ProcessExit::new(owner_pid);
        let observer_pid = pid("observer.pid");
        let mut observer = node_owner_exit::ProcessExit::new(observer_pid);
        assert!(!node.exited() && !child.exited() && !owner.exited() && !observer.exited());
        let stopped = match failure {
            "host-group" => -(parent.0.id() as libc::pid_t),
            "native-group" => -(observer_pid as libc::pid_t),
            "observer" => observer_pid as libc::pid_t,
            _ => owner_pid.try_into().unwrap(),
        };
        assert_eq!(unsafe { libc::kill(stopped, libc::SIGKILL) }, 0);
        if failure == "host-group" {
            parent.0.wait().unwrap();
            assert!(
                node.wait() && child.wait() && owner.wait() && observer.wait(),
                "Busy Node and ordinary child must exit after the whole private Host group is terminated"
            );
            continue;
        }
        let receipt = profile.path().join("closed.json");
        let deadline = Instant::now() + Duration::from_secs(5);
        while !receipt.exists() && Instant::now() < deadline {
            assert!(
                parent.0.try_wait().unwrap().is_none(),
                "Fixture failed before public cleanup returned; inspect host.stderr"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        let closed: Value = serde_json::from_slice(&std::fs::read(receipt).unwrap()).unwrap();
        assert_eq!(closed["processId"].as_u64(), Some(u64::from(node_pid)));
        assert_eq!(
            closed["reaped"], true,
            "Missing raw status must not discard actual cleanup responsibility"
        );
        assert!(!closed["error"].is_null());
        assert!(
            node.exited() && child.exited() && owner.exited() && observer.exited(),
            "Node, ordinary child and both native processes must all be gone before public completion ({failure})"
        );
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_parent_process_death_stops_node_workers_and_spawned_children() {
    use std::{
        process::{Child, Command, Stdio},
        time::{Duration, Instant},
    };
    struct OwnedParent(Child);
    impl Drop for OwnedParent {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let _reaper = node_owner_exit::ParentReaper::install();
    for mode in ["main", "await", "worker", "child-main", "child-await"] {
        let profile = support::Profile::isolated("node-backend-parent-exit-");
        let mut command = Command::new(std::env::current_exe().unwrap());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = OwnedParent(
            command
                .args([
                    "--ignored",
                    "--exact",
                    "node_backend_parent_exit_fixture",
                    "--nocapture",
                ])
                .env("SWB_NODE_PARENT_EXIT_PROFILE", profile.path())
                .env("SWB_NODE_PARENT_EXIT_MODE", mode)
                .stdin(Stdio::null())
                .stdout(Stdio::from(
                    std::fs::File::create_new(profile.path().join("host.stdout")).unwrap(),
                ))
                .stderr(Stdio::from(
                    std::fs::File::create_new(profile.path().join("host.stderr")).unwrap(),
                ))
                .spawn()
                .unwrap(),
        );
        let marker = profile.path().join("node.pid");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !marker.exists() && Instant::now() < deadline {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "Fixture ended before real Node startup; see owned host.stderr"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        let pid = std::fs::read_to_string(&marker).unwrap().parse().unwrap();
        let mut node = node_owner_exit::ProcessExit::new(pid);
        assert!(
            !node.exited(),
            "Node must be running before parent termination ({mode})"
        );
        let mut descendant = mode.starts_with("child-").then(|| {
            let pid = std::fs::read_to_string(profile.path().join("child.pid"))
                .unwrap()
                .parse()
                .unwrap();
            let mut child = node_owner_exit::ProcessExit::new(pid);
            assert!(
                !child.exited(),
                "Spawned child must be running before parent termination ({mode})"
            );
            child
        });
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        assert!(
            node.wait(),
            "Node must actually exit after its Host is killed ({mode})"
        );
        if let Some(child) = &mut descendant {
            assert!(
                child.wait(),
                "Ordinary spawned child must actually exit with its Node group ({mode})"
            );
        }
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_owner_panic_keeps_actual_exit_observation_after_package_code_begins() {
    use serial_workbench_host::{
        node_backend::{NodeBackend, NodeBackendLimits},
        node_runtime::{NodeRuntimeLimits, verify_node_runtime},
    };
    use std::sync::Arc;
    let profile = support::Profile::isolated("node-backend-owner-panic-");
    let marker = profile.path().join("code-started.txt");
    let mut files = payloads();
    files.insert("dist/main.mjs".into(),format!("import {{writeFileSync}} from 'node:fs'; export async function register() {{writeFileSync({},'started'); await new Promise(() => {{}}); return () => {{}}; }}",serde_json::to_string(&marker).unwrap()).into_bytes());
    let store = serial_workbench_host::storage::Store::open(profile.path()).unwrap();
    let installer = NodePackageInstaller::new(store, profile.path()).unwrap();
    let receipt = installer
        .install(
            verify_local(&with_metadata(files, false)).unwrap(),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let id = receipt.package.manifest.id;
    let digest = receipt.package.archive_sha256;
    let trust = installer
        .confirm_execution_trust(&id, receipt.revision, &digest)
        .unwrap();
    let enabled = installer
        .set_enabled(&id, true, trust.revision, &digest)
        .unwrap();
    let proof = installer
        .verify_installed(
            &id,
            enabled.revision,
            &digest,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let root = std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT").unwrap();
    let runtime = verify_node_runtime(
        std::path::Path::new(&root),
        &NodeRuntimeLimits::default(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let backend = NodeBackend::start(
        runtime,
        NodeBackendLimits::default(),
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap();
    let result = backend.activate(proof, move || {
        assert!(
            !marker.exists(),
            "Injected owner observer panic after real code begins"
        );
        Ok(())
    });
    assert_eq!(result.unwrap_err().code, "NODE_BACKEND_INTERRUPTED");
    let exit = backend.shutdown();
    assert!(
        exit.process_id > 0 && exit.reaped,
        "Real RAII completion must survive the failed owner join: {exit:?}"
    );
    node_owner_exit::assert_gone(exit.process_id);
}

fn verified_manifest(
    manifest: Value,
    signing_seed: Option<u8>,
) -> serial_workbench_host::node_packages::VerifiedNodePackage {
    let mut files = payloads();
    files.insert(
        "manifest.json".into(),
        serde_json::to_vec(&manifest).unwrap(),
    );
    let mut files = with_metadata(files, signing_seed.is_some());
    if let Some(seed) = signing_seed {
        let key = SigningKey::from_bytes(&[seed; 32]);
        let message = [
            NODE_PACKAGE_SIGNATURE_PREFIX,
            files["integrity.json"].as_slice(),
        ]
        .concat();
        files.insert(
            "signature.json".into(),
            serde_json::to_vec(&json!({
                "algorithm":"Ed25519", "keyId":"test-key",
                "signatureBase64":STANDARD.encode(key.sign(&message).to_bytes()),
            }))
            .unwrap(),
        );
        verify_node_package(
            archive(&files),
            NodePackageSource::Trusted {
                source: &"test-source".try_into().unwrap(),
                key_id: &"test-key".try_into().unwrap(),
                public_key: &key.verifying_key().to_bytes(),
            },
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap()
    } else {
        verify_local(&files).unwrap()
    }
}

#[test]
fn verifies_unicode_offline_package_without_executing_main() {
    let bytes = archive(&with_metadata(payloads(), false));
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let verified = verify_node_package(
        bytes,
        NodePackageSource::Local,
        &NodePackageLimits::default(),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(verified.manifest().id.as_str(), "example.terminal");
    assert_eq!(verified.archive_sha256().as_str(), hash);
    assert!(!verified.is_source_verified());
    assert_eq!(verified.integrity().files.len(), 4);
}

#[tokio::test]
async fn public_package_query_returns_committed_identity_without_private_code_paths() {
    use serial_workbench_core::*;
    let h = support::Harness::new().await;
    let installer = NodePackageInstaller::new(h.store.clone(), h.dir.path()).unwrap();
    let receipt = installer
        .install(
            verify_local(&with_metadata(payloads(), false)).unwrap(),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let reader = h
        .auth
        .authenticate(&support::id("package-reader"), None)
        .unwrap()
        .actor;
    let identity = h.store.identity().unwrap();
    let result = h
        .host
        .query(
            &reader,
            Query {
                protocol_version: ProtocolVersion::V0_1,
                host_id: identity.host_id.clone(),
                instance_epoch: identity.instance_epoch,
                actor_id: reader.id().clone(),
                request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
                action_id: support::id("node.packages.list"),
                target: Target {
                    host_id: identity.host_id.clone(),
                    kind: ResourceKind::try_from("host").unwrap(),
                    id: identity.host_id,
                    session_id: None,
                    session_epoch: None,
                },
                params: serde_json::from_value(json!({})).unwrap(),
                reveal_target: RevealTarget {
                    page_id: support::id("workbench"),
                    workspace_id: None,
                    session_id: None,
                    panel_id: None,
                    result_ref: None,
                },
            },
        )
        .await
        .unwrap();
    let QueryResult::NodePackages(snapshot) = result else {
        panic!("Expected installed packages")
    };
    assert_eq!(snapshot.revision, receipt.revision);
    assert_eq!(snapshot.packages.len(), 1);
    let package = &snapshot.packages[0];
    assert_eq!(package.id.as_str(), "example.terminal");
    assert_eq!(package.archive_sha256, receipt.package.archive_sha256);
    assert!(!package.enabled);
    assert!(!package.source_verified);
    assert!(!package.execution_approved);
    let public = serde_json::to_value(package).unwrap();
    assert!(public.get("objectId").is_none());
    assert!(public.get("codeDirectory").is_none());
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn fixed_package_file_proof_observes_cancellation_between_hash_blocks() {
    use serial_workbench_core::*;
    let h = support::Harness::new().await;
    let store = h.store.clone();
    let auth = h.auth.clone();
    let actor = h.actor.clone();
    let path = h.dir.path().join("proof-cancellation.bin");
    let (error, read, length) = tokio::task::spawn_blocking(move || {
        let identity = store.identity().unwrap();
        let operator = auth
            .authenticate_user_control(
                &support::id("operator"),
                &ContextToken::try_from("test-user-control").unwrap(),
            )
            .unwrap();
        let length = 8 * 1024 * 1024;
        std::fs::write(&path, vec![7u8; length]).unwrap();
        let registration = serial_workbench_host::files::FileService::new(
            store.clone(),
            auth.clone(),
            identity.clone(),
        );
        let reference = registration
            .register(
                RegisterFileParams {
                    path: path.to_str().unwrap().into(),
                    purpose: FilePurpose::ReadFile,
                },
                &operator,
            )
            .unwrap();
        let reader = serial_workbench_host::files::FileService::new(store, auth, identity);
        let outcome = reader.open_fixed_checked(&reference, &actor, || {
            if reader.file_read_bytes() > 0 {
                Err(HostError::new(
                    "CANCELLED",
                    "Stop the proof after the first real read",
                ))
            } else {
                Ok(())
            }
        });
        let error = match outcome {
            Err(error) => error,
            Ok(_) => panic!("Expected cancelled proof"),
        };
        (error, reader.file_read_bytes(), length as u64)
    })
    .await
    .unwrap();
    assert_eq!(error.code, "CANCELLED");
    assert!(
        read > 0 && read < length,
        "Cancellation must stop remaining real reads: {read}/{length}"
    );
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn package_metadata_stays_discoverable_with_large_manifests_and_complete_chunked_details() {
    use serial_workbench_core::*;
    let h = support::Harness::new().await;
    let store = h.store.clone();
    let profile = h.dir.path().to_path_buf();
    let expected = format!("{}尾部中文🛰️", "x".repeat(600 * 1024));
    let description = expected.clone();
    let identity = tokio::task::spawn_blocking(move || {
        let installer = NodePackageInstaller::new(store.clone(), &profile).unwrap();
        for (revision, id) in ["example.large-one", "example.large-two"]
            .iter()
            .enumerate()
        {
            let mut manifest = manifest();
            manifest["id"] = json!(id);
            manifest["description"] = json!(description);
            installer
                .install(
                    verified_manifest(manifest, None),
                    (revision as u64).into(),
                    &NodePackageLimits::default(),
                    &AtomicBool::new(false),
                )
                .unwrap();
        }
        store.identity().unwrap()
    })
    .await
    .unwrap();
    let target = Target {
        host_id: identity.host_id.clone(),
        kind: ResourceKind::try_from("host").unwrap(),
        id: identity.host_id.clone(),
        session_id: None,
        session_epoch: None,
    };
    let query = |action: &str, params: Value| Query {
        protocol_version: ProtocolVersion::V0_1,
        host_id: identity.host_id.clone(),
        instance_epoch: identity.instance_epoch,
        actor_id: h.actor.id().clone(),
        request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
        action_id: support::id(action),
        target: target.clone(),
        params: serde_json::from_value(params).unwrap(),
        reveal_target: RevealTarget {
            page_id: support::id("workbench"),
            workspace_id: None,
            session_id: None,
            panel_id: None,
            result_ref: None,
        },
    };
    let result = h
        .host
        .query(&h.actor, query("node.packages.list", json!({})))
        .await
        .unwrap();
    let encoded = serde_json::to_vec(&result).unwrap();
    assert!(
        encoded.len() < 1024 * 1024,
        "Legal package metadata must fit the existing 1 MiB control frame: {}",
        encoded.len()
    );
    let value = serde_json::to_value(result).unwrap();
    assert_eq!(value["value"]["packages"].as_array().unwrap().len(), 2);
    let first = h
        .host
        .query(
            &h.actor,
            query("node.packages.list", json!({"pageSize":"1"})),
        )
        .await
        .unwrap();
    let QueryResult::NodePackages(first) = first else {
        panic!("Expected first package page")
    };
    assert_eq!(first.packages.len(), 1);
    assert_eq!(first.next_after.as_ref(), Some(&first.packages[0].id));
    let second = h
        .host
        .query(
            &h.actor,
            query(
                "node.packages.list",
                json!({
                    "pageSize":"1","after":first.next_after,"expectedRevision":first.revision
                }),
            ),
        )
        .await
        .unwrap();
    let QueryResult::NodePackages(second) = second else {
        panic!("Expected second package page")
    };
    assert_eq!(second.revision, first.revision);
    assert_eq!(second.packages.len(), 1);
    assert_ne!(second.packages[0].id, first.packages[0].id);
    assert!(second.next_after.is_none());
    for params in [
        json!({"pageSize":"0"}),
        json!({"pageSize":"101"}),
        json!({"after":first.packages[0].id}),
        json!({"after":"example.missing","expectedRevision":first.revision}),
    ] {
        assert_eq!(
            h.host
                .query(&h.actor, query("node.packages.list", params))
                .await
                .unwrap_err()
                .code,
            "INVALID_ARGUMENT"
        );
    }
    let selected = &value["value"]["packages"][0];
    let mut bytes = Vec::new();
    let mut digest = None;
    loop {
        let result = h.host.query(&h.actor, query("node.packages.detailsRead", json!({
            "id":selected["id"],"expectedRevision":value["value"]["revision"],"archiveSha256":selected["archiveSha256"],
            "offset":bytes.len().to_string(),"length":"32768"
        }))).await.unwrap();
        assert!(serde_json::to_vec(&result).unwrap().len() < 1024 * 1024);
        let value = serde_json::to_value(result).unwrap();
        let detail = &value["value"];
        let next_digest = detail["jsonSha256"].as_str().unwrap().to_string();
        if let Some(previous) = &digest {
            assert_eq!(previous, &next_digest);
        }
        digest = Some(next_digest);
        let chunk = STANDARD
            .decode(detail["bytesBase64"].as_str().unwrap())
            .unwrap();
        assert!(!chunk.is_empty());
        bytes.extend(chunk);
        if bytes.len() as u64
            == detail["totalBytes"]
                .as_str()
                .unwrap()
                .parse::<u64>()
                .unwrap()
        {
            break;
        }
    }
    assert_eq!(format!("{:x}", Sha256::digest(&bytes)), digest.unwrap());
    let complete: NodePackageInstallation = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(complete.manifest.description, expected);
    assert_eq!(
        complete.manifest.id.as_str(),
        selected["id"].as_str().unwrap()
    );
    let details = json!({"id":selected["id"],"expectedRevision":value["value"]["revision"],"archiveSha256":selected["archiveSha256"],"offset":"0","length":"32768"});
    for (field, invalid, code) in [
        ("length", json!("0"), "INVALID_ARGUMENT"),
        ("length", json!("32769"), "INVALID_ARGUMENT"),
        (
            "offset",
            json!((bytes.len() + 1).to_string()),
            "INVALID_ARGUMENT",
        ),
        ("archiveSha256", json!("0".repeat(64)), "INTEGRITY_FAILED"),
        ("id", json!("example.missing"), "NOT_FOUND"),
    ] {
        let mut invalid_params = details.clone();
        invalid_params[field] = invalid;
        assert_eq!(
            h.host
                .query(&h.actor, query("node.packages.detailsRead", invalid_params))
                .await
                .unwrap_err()
                .code,
            code
        );
    }
    let store = h.store.clone();
    let profile = h.dir.path().to_path_buf();
    tokio::task::spawn_blocking(move || {
        let installer = NodePackageInstaller::new(store, &profile).unwrap();
        let mut manifest = manifest();
        manifest["id"] = json!("example.later");
        installer
            .install(
                verified_manifest(manifest, None),
                2.into(),
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap();
    })
    .await
    .unwrap();
    assert_eq!(
        h.host
            .query(&h.actor, query("node.packages.detailsRead", details))
            .await
            .unwrap_err()
            .code,
        "REVISION_CONFLICT"
    );
    assert_eq!(
        h.host
            .query(
                &h.actor,
                query(
                    "node.packages.list",
                    json!({"after":first.packages[0].id,"expectedRevision":first.revision})
                )
            )
            .await
            .unwrap_err()
            .code,
        "REVISION_CONFLICT"
    );
    h.host.shutdown().await.unwrap();
}

async fn package_fixture_io() -> tokio::sync::OwnedSemaphorePermit {
    static FIXTURE_IO: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
        std::sync::OnceLock::new();
    FIXTURE_IO
        .get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(1)))
        .clone()
        .acquire_owned()
        .await
        .unwrap()
}

async fn start_large_package_install(
    h: &support::Harness,
) -> (
    serial_workbench_core::Operation,
    serial_workbench_core::Target,
    serial_workbench_host::auth::AuthenticatedActor,
    tokio::sync::OwnedSemaphorePermit,
) {
    start_large_package_install_from(h, false).await
}

async fn start_large_package_install_from(
    h: &support::Harness,
    trusted: bool,
) -> (
    serial_workbench_core::Operation,
    serial_workbench_core::Target,
    serial_workbench_host::auth::AuthenticatedActor,
    tokio::sync::OwnedSemaphorePermit,
) {
    use serial_workbench_core::*;
    // 各停止用例单独保留64MiB夹具的I/O窗口；用例内的安装/撤销仍真实并发。
    let fixture = package_fixture_io().await;
    let store = h.store.clone();
    let auth = h.auth.clone();
    let actor = h.actor.clone();
    let path = h.dir.path().join("cooperative-package.zip");
    let (target, operator, reference, length) = tokio::task::spawn_blocking(move || {
        let identity = store.identity().unwrap();
        let target = Target {
            host_id: identity.host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            id: identity.host_id.clone(),
            session_id: None,
            session_epoch: None,
        };
        let operator = auth
            .authenticate_user_control(
                &support::id("operator"),
                &ContextToken::try_from("test-user-control").unwrap(),
            )
            .unwrap();
        auth.authorize(
            &operator,
            AuthorizeParams {
                client_id: actor.client_id().clone(),
                permissions: vec!["plugins.manage".into()],
                targets: vec![target.clone()],
                expires_at: None,
            },
        )
        .unwrap();
        let mut files = payloads();
        files.insert("data.bin".into(), vec![7; 64 * 1024 * 1024]);
        let bytes =
            archive_with_compression(&with_metadata(files, trusted), CompressionMethod::Stored);
        let length = bytes.len() as u64;
        std::fs::write(&path, bytes).unwrap();
        // 独立登记服务不预热 Host 的读取证明，屏障观察真实冷读取。
        let registration = serial_workbench_host::files::FileService::new(store, auth, identity);
        let reference = registration
            .register(
                RegisterFileParams {
                    path: path.to_str().unwrap().into(),
                    purpose: FilePurpose::ReadFile,
                },
                &operator,
            )
            .unwrap();
        (target, operator, reference, length)
    })
    .await
    .unwrap();
    assert_eq!(h.host.files().file_read_bytes(), 0);
    let mut call = h.call(
        &target,
        "node.packages.install",
        json!({"archiveRef":reference,"source":if trusted {json!({"kind":"trusted","source":"test-source","keyId":"test-key"})} else {json!({"kind":"local"})}}),
    );
    call.expected_revision = Some(0.into());
    call.execution_mode = Some(ExecutionMode::Independent);
    let accepted = h.host.invoke(&h.actor, call).await.unwrap();
    support::until(|| h.host.files().file_read_bytes() > 0).await;
    assert!(
        h.host.files().file_read_bytes() < length,
        "The stop must start during the real cold proof"
    );
    (accepted, target, operator, fixture)
}

async fn approve_test_source(
    h: &support::Harness,
) -> (
    serial_workbench_host::auth::AuthenticatedActor,
    serial_workbench_core::Target,
    serial_workbench_core::Digest,
) {
    use serial_workbench_core::*;
    let operator = h
        .auth
        .authenticate_user_control(
            &support::id("operator"),
            &ContextToken::try_from("test-user-control").unwrap(),
        )
        .unwrap();
    let target = Target {
        host_id: h.host_id.clone(),
        kind: ResourceKind::try_from("host").unwrap(),
        id: h.host_id.clone(),
        session_id: None,
        session_epoch: None,
    };
    let public_key = SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes();
    let fingerprint = serial_workbench_core::Digest::try_from(
        format!("{:x}", Sha256::digest(public_key)).as_str(),
    )
    .unwrap();
    let mut call = h.call_as(&operator, &target, "node.sources.approveKey", json!({"source":"test-source","keyId":"test-key","publicKey":public_key,"publicKeySha256":fingerprint}));
    call.expected_revision = Some(0.into());
    call.execution_mode = Some(ExecutionMode::Independent);
    let accepted = h.host.invoke(&operator, call).await.unwrap();
    let completed = h.wait_as(&operator, &accepted.operation_id).await;
    assert_eq!(
        completed.state,
        OperationState::Succeeded,
        "{:?}",
        completed.error
    );
    (operator, target, fingerprint)
}

async fn install_for_execution_confirmation(
    h: &support::Harness,
) -> serial_workbench_host::node_packages::NodePackageInstallReceipt {
    let store = h.store.clone();
    let profile = h.dir.path().to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut files = payloads();
        let mut metadata = manifest();
        metadata["permissions"]["hostApi"] =
            json!([{"permissions":["device.modify"],"targetKinds":["session"]}]);
        files.insert(
            "manifest.json".into(),
            serde_json::to_vec(&metadata).unwrap(),
        );
        NodePackageInstaller::new(store, &profile)
            .unwrap()
            .install(
                verify_local(&with_metadata(files, false)).unwrap(),
                0.into(),
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap()
    })
    .await
    .unwrap()
}

fn confirmation_operator(h: &support::Harness) -> serial_workbench_host::auth::AuthenticatedActor {
    use serial_workbench_core::*;
    h.auth
        .authenticate_user_control(
            &support::id("operator"),
            &ContextToken::try_from("test-user-control").unwrap(),
        )
        .unwrap()
}
fn package_host_target(h: &support::Harness) -> serial_workbench_core::Target {
    use serial_workbench_core::*;
    Target {
        host_id: h.host_id.clone(),
        kind: ResourceKind::try_from("host").unwrap(),
        id: h.host_id.clone(),
        session_id: None,
        session_epoch: None,
    }
}

#[tokio::test]
async fn user_execution_confirmation_is_content_bound_without_enabling_or_running_package_code() {
    use serial_workbench_core::*;
    let h = support::Harness::new().await;
    let installed = install_for_execution_confirmation(&h).await;
    let user = confirmation_operator(&h);
    let target = package_host_target(&h);
    let mut call = h.call_as(&user, &target, "node.packages.confirmExecutionTrust", json!({"id":installed.package.manifest.id,"archiveSha256":installed.package.archive_sha256}));
    call.expected_revision = Some(installed.revision);
    call.execution_mode = Some(ExecutionMode::Independent);
    let accepted = h.host.invoke(&user, call.clone()).await.unwrap();
    let completed = h.wait_as(&user, &accepted.operation_id).await;
    assert_eq!(
        completed.state,
        OperationState::Succeeded,
        "{:?}",
        completed.error
    );
    let result = serde_json::to_value(completed.result).unwrap();
    assert_eq!(result["kind"], "node_package_changed");
    assert_eq!(result["value"]["revision"], "2");
    assert_eq!(result["value"]["package"]["id"], "example.terminal");
    assert_eq!(result["value"]["package"]["executionApproved"], true);
    assert_eq!(result["value"]["package"]["enabled"], false);
    assert_eq!(result["value"]["package"]["sourceVerified"], false);
    let repeated = h.host.invoke(&user, call).await.unwrap();
    assert_eq!(repeated.operation_id, accepted.operation_id);
    let store = h.store.clone();
    let snapshot =
        tokio::task::spawn_blocking(move || NodePackageInstaller::read_snapshot(&store).unwrap())
            .await
            .unwrap();
    assert_eq!(snapshot.revision, 2.into());
    let package = &snapshot.packages[0];
    let trust = package.execution_trust.as_ref().unwrap();
    assert_eq!(trust.archive_sha256, installed.package.archive_sha256);
    assert_eq!(trust.permissions, installed.package.manifest.permissions);
    assert!(!package.enabled);
    for permission in ["plugins.manage", "code.execute", "device.modify"] {
        assert!(h.auth.require(&user, permission, &target).is_err());
    }
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn execution_confirmation_rejects_stale_identity_and_tampered_installed_code() {
    use serial_workbench_core::*;
    let h = support::Harness::new().await;
    let installed = install_for_execution_confirmation(&h).await;
    let user = confirmation_operator(&h);
    for (revision, digest, code) in [
        (
            0,
            installed.package.archive_sha256.clone(),
            "REVISION_CONFLICT",
        ),
        (
            1,
            Digest::try_from("0".repeat(64).as_str()).unwrap(),
            "INTEGRITY_FAILED",
        ),
    ] {
        let mut call = h.call_as(
            &user,
            &package_host_target(&h),
            "node.packages.confirmExecutionTrust",
            json!({"id":installed.package.manifest.id,"archiveSha256":digest}),
        );
        call.expected_revision = Some(revision.into());
        call.execution_mode = Some(ExecutionMode::Independent);
        let accepted = h.host.invoke(&user, call).await.unwrap();
        let completed = h.wait_as(&user, &accepted.operation_id).await;
        assert_eq!(completed.state, OperationState::Failed);
        assert_eq!(completed.error.unwrap().code, code);
    }
    let path = installed.code_directory().join("dist/main.mjs");
    tokio::task::spawn_blocking(move || {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        std::fs::write(path, b"tampered code").unwrap();
    })
    .await
    .unwrap();
    let mut call = h.call_as(&user, &package_host_target(&h), "node.packages.confirmExecutionTrust", json!({"id":installed.package.manifest.id,"archiveSha256":installed.package.archive_sha256}));
    call.expected_revision = Some(1.into());
    call.execution_mode = Some(ExecutionMode::Independent);
    let accepted = h.host.invoke(&user, call).await.unwrap();
    let completed = h.wait_as(&user, &accepted.operation_id).await;
    assert_eq!(completed.state, OperationState::Failed);
    assert_eq!(completed.error.unwrap().code, "INTEGRITY_FAILED");
    let store = h.store.clone();
    let snapshot =
        tokio::task::spawn_blocking(move || NodePackageInstaller::read_snapshot(&store).unwrap())
            .await
            .unwrap();
    assert_eq!(snapshot.revision, 1.into());
    assert!(snapshot.packages[0].execution_trust.is_none());
    assert!(!snapshot.packages[0].enabled);
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn ordinary_code_and_plugin_grants_cannot_confirm_package_execution_trust() {
    use serial_workbench_core::*;
    let h = support::Harness::new().await;
    let installed = install_for_execution_confirmation(&h).await;
    let user = confirmation_operator(&h);
    let target = package_host_target(&h);
    h.auth
        .authorize(
            &user,
            AuthorizeParams {
                client_id: h.actor.client_id().clone(),
                permissions: vec!["plugins.manage".into(), "code.execute".into()],
                targets: vec![target.clone()],
                expires_at: None,
            },
        )
        .unwrap();
    let mut call = h.call(&target, "node.packages.confirmExecutionTrust", json!({"id":installed.package.manifest.id,"archiveSha256":installed.package.archive_sha256}));
    call.expected_revision = Some(1.into());
    call.execution_mode = Some(ExecutionMode::Independent);
    assert_eq!(
        h.host.invoke(&h.actor, call).await.unwrap_err().code,
        "PERMISSION_DENIED"
    );
    let store = h.store.clone();
    let snapshot =
        tokio::task::spawn_blocking(move || NodePackageInstaller::read_snapshot(&store).unwrap())
            .await
            .unwrap();
    assert_eq!(snapshot.revision, 1.into());
    assert!(snapshot.packages[0].execution_trust.is_none());
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn execution_confirmation_rejects_a_revoked_signed_source_without_changing_installation() {
    use serial_workbench_core::*;
    let h = support::Harness::new().await;
    let (user, target, fingerprint) = approve_test_source(&h).await;
    let store = h.store.clone();
    let profile = h.dir.path().to_path_buf();
    let installed = tokio::task::spawn_blocking(move || {
        let package = NodePackageSources::new(store.clone())
            .verify(
                archive(&with_metadata(payloads(), true)),
                &support::id("test-source"),
                &support::id("test-key"),
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap();
        NodePackageInstaller::new(store, &profile)
            .unwrap()
            .install(
                package,
                0.into(),
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap()
    })
    .await
    .unwrap();
    let mut revoke = h.call_as(
        &user,
        &target,
        "node.sources.revokeKey",
        json!({"source":"test-source","keyId":"test-key","publicKeySha256":fingerprint}),
    );
    revoke.expected_revision = Some(1.into());
    revoke.execution_mode = Some(ExecutionMode::Independent);
    let revoked = h.host.invoke(&user, revoke).await.unwrap();
    assert_eq!(
        h.wait_as(&user, &revoked.operation_id).await.state,
        OperationState::Succeeded
    );
    let mut confirm = h.call_as(&user, &target, "node.packages.confirmExecutionTrust", json!({"id":installed.package.manifest.id,"archiveSha256":installed.package.archive_sha256}));
    confirm.expected_revision = Some(1.into());
    confirm.execution_mode = Some(ExecutionMode::Independent);
    let accepted = h.host.invoke(&user, confirm).await.unwrap();
    let completed = h.wait_as(&user, &accepted.operation_id).await;
    assert_eq!(
        completed.state,
        OperationState::Interrupted,
        "{:?}",
        completed.error
    );
    assert_eq!(completed.error.unwrap().code, "PERMISSION_DENIED");
    let store = h.store.clone();
    let snapshot =
        tokio::task::spawn_blocking(move || NodePackageInstaller::read_snapshot(&store).unwrap())
            .await
            .unwrap();
    assert_eq!(snapshot.revision, 1.into());
    assert!(snapshot.packages[0].execution_trust.is_none());
    assert!(!snapshot.packages[0].enabled);
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn source_revocation_during_trusted_install_cold_proof_is_not_blocked_by_install_capacity() {
    use serial_workbench_core::*;
    let h = support::Harness::new().await;
    let (operator, target, fingerprint) = approve_test_source(&h).await;
    let (accepted, _, _, _fixture) = start_large_package_install_from(&h, true).await;
    let mut revoke = h.call_as(
        &operator,
        &target,
        "node.sources.revokeKey",
        json!({"source":"test-source","keyId":"test-key","publicKeySha256":fingerprint}),
    );
    revoke.expected_revision = Some(1.into());
    revoke.execution_mode = Some(ExecutionMode::Independent);
    let revoked = h.host.invoke(&operator, revoke).await.unwrap();
    let revoked = h.wait_as(&operator, &revoked.operation_id).await;
    assert_eq!(
        revoked.state,
        OperationState::Succeeded,
        "{:?}",
        revoked.error
    );
    let stopped = h.wait(&accepted.operation_id).await;
    assert_eq!(
        stopped.state,
        OperationState::Interrupted,
        "{:?}",
        stopped.error
    );
    assert_eq!(stopped.error.unwrap().code, "PERMISSION_DENIED");
    let store = h.store.clone();
    let (installed, sources) = tokio::task::spawn_blocking(move || {
        (
            NodePackageInstaller::read_snapshot(&store).unwrap(),
            NodePackageSources::new(store).snapshot().unwrap(),
        )
    })
    .await
    .unwrap();
    assert_eq!(installed.revision, 0.into());
    assert!(installed.packages.is_empty());
    assert_eq!(sources.revision, 2.into());
    assert!(!sources.keys[0].approved);
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn source_rotation_after_verification_stops_before_all_package_files_are_written() {
    use serial_workbench_core::*;
    let h = support::Harness::new().await;
    let (operator, target, _) = approve_test_source(&h).await;
    let _fixture = package_fixture_io().await;
    let store = h.store.clone();
    let auth = h.auth.clone();
    let actor = h.actor.clone();
    let prepared_operator = operator.clone();
    let prepared_target = target.clone();
    let path = h.dir.path().join("signed-deflated-package.zip");
    let reference = tokio::task::spawn_blocking(move || {
        auth.authorize(
            &prepared_operator,
            AuthorizeParams {
                client_id: actor.client_id().clone(),
                permissions: vec!["plugins.manage".into()],
                targets: vec![prepared_target],
                expires_at: None,
            },
        )
        .unwrap();
        let mut files = payloads();
        files.insert("data.bin".into(), vec![7; 64 * 1024 * 1024]);
        let bytes = archive(&with_metadata(files, true));
        assert!(bytes.len() < 1024 * 1024);
        std::fs::write(&path, bytes).unwrap();
        let identity = store.identity().unwrap();
        serial_workbench_host::files::FileService::new(store, auth, identity)
            .register(
                RegisterFileParams {
                    path: path.to_str().unwrap().into(),
                    purpose: FilePurpose::ReadFile,
                },
                &prepared_operator,
            )
            .unwrap()
    })
    .await
    .unwrap();
    let mut install = h.call(&target, "node.packages.install", json!({"archiveRef":reference,"source":{"kind":"trusted","source":"test-source","keyId":"test-key"}}));
    install.expected_revision = Some(0.into());
    install.execution_mode = Some(ExecutionMode::Independent);
    let accepted = h.host.invoke(&h.actor, install).await.unwrap();
    // 公开文件进度只在归档验证完成后发布；不窥探暂存目录或私有数据库。
    let writing = h
        .wait_for_operation(&h.actor, &accepted.operation_id, |operation| {
            operation.progress.is_some() || support::terminal(operation.state)
        })
        .await;
    assert_eq!(
        writing.state,
        OperationState::Running,
        "{:?}",
        writing.error
    );
    let progress = writing.progress.unwrap();
    assert_eq!(progress.unit, "files");
    assert!(progress.completed < progress.total.unwrap());
    let next_key = SigningKey::from_bytes(&[8; 32]).verifying_key().to_bytes();
    let mut rotate = h.call_as(&operator, &target, "node.sources.approveKey", json!({"source":"test-source","keyId":"test-key","publicKey":next_key,"publicKeySha256":format!("{:x}",Sha256::digest(next_key))}));
    rotate.expected_revision = Some(1.into());
    rotate.execution_mode = Some(ExecutionMode::Independent);
    let rotated = h.host.invoke(&operator, rotate).await.unwrap();
    let rotated = h.wait_as(&operator, &rotated.operation_id).await;
    assert_eq!(
        rotated.state,
        OperationState::Succeeded,
        "{:?}",
        rotated.error
    );
    let stopped = h.wait(&accepted.operation_id).await;
    assert_eq!(
        stopped.state,
        OperationState::Interrupted,
        "{:?}",
        stopped.error
    );
    assert_eq!(stopped.error.unwrap().code, "PERMISSION_DENIED");
    let progress = stopped.progress.unwrap();
    assert!(
        progress.completed < progress.total.unwrap(),
        "Rotation must stop remaining real file writes: {progress:?}"
    );
    eprintln!(
        "node_source_rotation_actual_progress={}",
        serde_json::to_string(&progress).unwrap()
    );
    let store = h.store.clone();
    let installed =
        tokio::task::spawn_blocking(move || NodePackageInstaller::read_snapshot(&store).unwrap())
            .await
            .unwrap();
    assert_eq!(installed.revision, 0.into());
    assert!(installed.packages.is_empty());
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn user_approved_source_enables_verified_install_but_never_grants_execution_trust() {
    use serial_workbench_core::*;
    let h = support::Harness::new().await;
    let (operator, target, fingerprint) = approve_test_source(&h).await;
    h.auth
        .authorize(
            &operator,
            AuthorizeParams {
                client_id: h.actor.client_id().clone(),
                permissions: vec!["plugins.manage".into()],
                targets: vec![target.clone()],
                expires_at: None,
            },
        )
        .unwrap();
    let path = h.dir.path().join("signed-package.zip");
    std::fs::write(&path, archive(&with_metadata(payloads(), true))).unwrap();
    let registration = serial_workbench_host::files::FileService::new(
        h.store.clone(),
        h.auth.clone(),
        h.store.identity().unwrap(),
    );
    let reference = registration
        .register(
            RegisterFileParams {
                path: path.to_str().unwrap().into(),
                purpose: FilePurpose::ReadFile,
            },
            &operator,
        )
        .unwrap();
    let mut call = h.call(&target, "node.packages.install", json!({"archiveRef":reference,"source":{"kind":"trusted","source":"test-source","keyId":"test-key"}}));
    call.expected_revision = Some(0.into());
    call.execution_mode = Some(ExecutionMode::Independent);
    let accepted = h.host.invoke(&h.actor, call.clone()).await.unwrap();
    let completed = h.wait(&accepted.operation_id).await;
    assert_eq!(
        completed.state,
        OperationState::Succeeded,
        "{:?}",
        completed.error
    );
    let Some(ActionResult::NodePackageInstalled(result)) = &completed.result else {
        panic!("Expected installation receipt")
    };
    assert!(result.package.source_verified);
    assert!(!result.package.execution_approved);
    assert!(!result.package.enabled);
    assert!(h.auth.require(&h.actor, "code.execute", &target).is_err());
    let mut revoke = h.call_as(
        &operator,
        &target,
        "node.sources.revokeKey",
        json!({"source":"test-source","keyId":"test-key","publicKeySha256":fingerprint}),
    );
    revoke.expected_revision = Some(1.into());
    revoke.execution_mode = Some(ExecutionMode::Independent);
    let revoked = h.host.invoke(&operator, revoke).await.unwrap();
    assert_eq!(
        h.wait_as(&operator, &revoked.operation_id).await.state,
        OperationState::Succeeded
    );
    let bytes_read = h.host.files().file_read_bytes();
    assert_eq!(
        h.host.invoke(&h.actor, call.clone()).await.unwrap(),
        completed
    );
    let mut conflicting = call.clone();
    conflicting.expected_revision = Some(1.into());
    assert_eq!(
        h.host.invoke(&h.actor, conflicting).await.unwrap_err().code,
        "REQUEST_CONFLICT"
    );
    let check = h
        .host
        .check_action(
            &h.actor,
            &target,
            ActionCheckParams {
                action_id: call.action_id.clone(),
                params: call.params.clone(),
            },
        )
        .await
        .unwrap();
    assert!(
        !check.allowed,
        "New installation still requires an approved source"
    );
    let mut fresh = call.clone();
    fresh.request_id = RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap();
    fresh.expected_revision = Some(1.into());
    assert_eq!(
        h.host.invoke(&h.actor, fresh).await.unwrap_err().code,
        "PERMISSION_DENIED"
    );
    assert_eq!(h.host.files().file_read_bytes(), bytes_read);
    // 来源变化不阻止读取历史事实；当前归档权限和管理权限仍各自约束重放。
    h.auth.require(&h.actor, "content.read", &target).unwrap();
    h.auth
        .revoke(
            &operator,
            RevokeParams {
                actor_id: h.actor.id().clone(),
                permissions: vec!["content.read".into()],
                targets: vec![target.clone()],
            },
        )
        .unwrap();
    assert_eq!(
        h.host
            .invoke(&h.actor, call.clone())
            .await
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    h.auth
        .authorize(
            &operator,
            AuthorizeParams {
                client_id: h.actor.client_id().clone(),
                permissions: vec!["content.read".into()],
                targets: vec![target.clone()],
                expires_at: None,
            },
        )
        .unwrap();
    assert_eq!(
        h.host.invoke(&h.actor, call.clone()).await.unwrap(),
        completed
    );
    h.auth
        .revoke(
            &operator,
            RevokeParams {
                actor_id: h.actor.id().clone(),
                permissions: vec!["plugins.manage".into()],
                targets: vec![target.clone()],
            },
        )
        .unwrap();
    assert_eq!(
        h.host.invoke(&h.actor, call).await.unwrap_err().code,
        "PERMISSION_DENIED"
    );
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn revoking_install_management_during_cold_proof_settles_interrupted_and_releases_capacity() {
    use serial_workbench_core::*;
    let h = support::Harness::new().await;
    let (accepted, target, operator, _fixture) = start_large_package_install(&h).await;
    let auth = h.auth.clone();
    let actor = h.actor.clone();
    let revoked_target = target.clone();
    let next_operator = operator.clone();
    tokio::task::spawn_blocking(move || {
        auth.revoke(
            &operator,
            RevokeParams {
                actor_id: actor.id().clone(),
                permissions: vec!["plugins.manage".into()],
                targets: vec![revoked_target],
            },
        )
        .unwrap();
    })
    .await
    .unwrap();
    let completed = h.wait(&accepted.operation_id).await;
    assert_eq!(
        completed.state,
        OperationState::Interrupted,
        "{:?}",
        completed.error
    );
    assert_eq!(completed.error.unwrap().code, "PERMISSION_DENIED");
    let store = h.store.clone();
    let auth = h.auth.clone();
    let actor = h.actor.clone();
    let next_target = target.clone();
    let path = h.dir.path().join("next-package.zip");
    let reference = tokio::task::spawn_blocking(move || {
        let snapshot = NodePackageInstaller::read_snapshot(&store).unwrap();
        assert_eq!(snapshot.revision, 0.into());
        assert!(snapshot.packages.is_empty());
        auth.authorize(
            &next_operator,
            AuthorizeParams {
                client_id: actor.client_id().clone(),
                permissions: vec!["plugins.manage".into()],
                targets: vec![next_target],
                expires_at: None,
            },
        )
        .unwrap();
        std::fs::write(&path, archive(&with_metadata(payloads(), false))).unwrap();
        let identity = store.identity().unwrap();
        serial_workbench_host::files::FileService::new(store, auth, identity)
            .register(
                RegisterFileParams {
                    path: path.to_str().unwrap().into(),
                    purpose: FilePurpose::ReadFile,
                },
                &next_operator,
            )
            .unwrap()
    })
    .await
    .unwrap();
    let mut call = h.call(
        &target,
        "node.packages.install",
        json!({"archiveRef":reference,"source":{"kind":"local"}}),
    );
    call.expected_revision = Some(0.into());
    call.execution_mode = Some(ExecutionMode::Independent);
    let next = h.host.invoke(&h.actor, call).await.unwrap();
    assert_eq!(
        h.wait(&next.operation_id).await.state,
        OperationState::Succeeded
    );
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn shutdown_during_install_cold_proof_waits_for_actual_work_and_preserves_its_stop_reason() {
    use serial_workbench_core::*;
    let h = support::Harness::new().await;
    let (accepted, _, _, _fixture) = start_large_package_install(&h).await;
    let report = h.host.quiesce(ShutdownMode::CancelAndSettle).await.unwrap();
    assert!(report.completed, "{report:?}");
    assert!(report.unsettled_operation_ids.is_empty());
    assert!(report.failures.is_empty());
    let completed = h.wait(&accepted.operation_id).await;
    assert_eq!(
        completed.state,
        OperationState::Interrupted,
        "{:?}",
        completed.error
    );
    assert_eq!(completed.error.unwrap().code, "HOST_CLOSING");
    let store = h.store.clone();
    let snapshot =
        tokio::task::spawn_blocking(move || NodePackageInstaller::read_snapshot(&store).unwrap())
            .await
            .unwrap();
    assert_eq!(snapshot.revision, 0.into());
    assert!(snapshot.packages.is_empty());
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn user_cancel_during_install_cold_proof_keeps_the_cancel_requested_terminal_path() {
    use serial_workbench_core::*;
    let h = support::Harness::new().await;
    let (accepted, _, _, _fixture) = start_large_package_install(&h).await;
    let cancellation = h.cancel(&accepted).await;
    assert_eq!(cancellation.state, OperationState::Succeeded);
    let completed = h.wait(&accepted.operation_id).await;
    assert_eq!(
        completed.state,
        OperationState::Cancelled,
        "{:?}",
        completed.error
    );
    assert_eq!(completed.error.unwrap().code, "CANCELLED");
    let store = h.store.clone();
    let snapshot =
        tokio::task::spawn_blocking(move || NodePackageInstaller::read_snapshot(&store).unwrap())
            .await
            .unwrap();
    assert_eq!(snapshot.revision, 0.into());
    assert!(snapshot.packages.is_empty());
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn host_install_action_commits_a_registered_archive_once_without_executing_code() {
    // 独立夹具不互相挤占I/O观察窗口；原数据量与五秒业务观察保持不变。
    let _fixture = package_fixture_io().await;
    use serial_workbench_core::*;
    let h = support::Harness::new().await;
    let operator = h
        .auth
        .authenticate_user_control(
            &support::id("operator"),
            &ContextToken::try_from("test-user-control").unwrap(),
        )
        .unwrap();
    let path = h.dir.path().join("formal-package.zip");
    let mut files = payloads();
    files.insert("dist/main.mjs".into(), vec![b' '; 64 * 1024]);
    let bytes = archive_with_compression(&with_metadata(files, false), CompressionMethod::Stored);
    assert!(bytes.len() > 32 * 1024);
    std::fs::write(&path, bytes).unwrap();
    let identity = h.store.identity().unwrap();
    let reference = serial_workbench_host::files::FileService::new(
        h.store.clone(),
        h.auth.clone(),
        identity.clone(),
    )
    .register(
        RegisterFileParams {
            path: path.to_str().unwrap().into(),
            purpose: FilePurpose::ReadFile,
        },
        &operator,
    )
    .unwrap();
    let target = Target {
        host_id: identity.host_id.clone(),
        kind: ResourceKind::try_from("host").unwrap(),
        id: identity.host_id,
        session_id: None,
        session_epoch: None,
    };
    let mut call = h.call_as(
        &h.actor,
        &target,
        "node.packages.install",
        json!({
            "archiveRef":reference,"source":{"kind":"local"}
        }),
    );
    h.auth
        .authorize(
            &operator,
            AuthorizeParams {
                client_id: h.actor.client_id().clone(),
                permissions: vec!["plugins.manage".into()],
                targets: vec![target.clone()],
                expires_at: None,
            },
        )
        .unwrap();
    call.expected_revision = Some(0.into());
    call.execution_mode = Some(ExecutionMode::Independent);
    let accepted = h.host.invoke(&h.actor, call.clone()).await.unwrap();
    let completed = h.wait(&accepted.operation_id).await;
    assert_eq!(
        completed.state,
        OperationState::Succeeded,
        "{:?}",
        completed.error
    );
    let output = serde_json::to_value(completed.result.unwrap()).unwrap();
    let progress = completed.progress.unwrap();
    assert_eq!(progress.completed, progress.total.unwrap());
    assert_eq!(output["kind"], "node_package_installed");
    assert_eq!(output["value"]["revision"], "1");
    assert_eq!(output["value"]["package"]["id"], "example.terminal");
    assert_eq!(output["value"]["package"]["enabled"], false);
    assert_eq!(output["value"]["package"]["executionApproved"], false);
    let repeated = h.host.invoke(&h.actor, call.clone()).await.unwrap();
    assert_eq!(repeated.operation_id, accepted.operation_id);
    let mut stale = call;
    stale.request_id = RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap();
    let rejected = h.host.invoke(&h.actor, stale).await.unwrap();
    let rejected = h.wait(&rejected.operation_id).await;
    assert_eq!(rejected.state, OperationState::Failed);
    assert_eq!(rejected.error.unwrap().code, "REVISION_CONFLICT");
    assert_eq!(
        NodePackageInstaller::read_snapshot(&h.store)
            .unwrap()
            .revision,
        1.into()
    );
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn install_discovery_and_execution_use_separate_management_and_archive_scopes() {
    let _fixture = package_fixture_io().await;
    use serial_workbench_core::*;
    let h = support::Harness::new().await;
    let operator = h
        .auth
        .authenticate_user_control(
            &support::id("operator"),
            &ContextToken::try_from("test-user-control").unwrap(),
        )
        .unwrap();
    let actor = h
        .auth
        .authenticate(&support::id("scoped-installer"), None)
        .unwrap()
        .actor;
    let identity = h.store.identity().unwrap();
    let target = Target {
        host_id: identity.host_id.clone(),
        kind: ResourceKind::try_from("host").unwrap(),
        id: identity.host_id.clone(),
        session_id: None,
        session_epoch: None,
    };
    let path = h.dir.path().join("scoped-package.zip");
    std::fs::write(&path, archive(&with_metadata(payloads(), false))).unwrap();
    let reference = serial_workbench_host::files::FileService::new(
        h.store.clone(),
        h.auth.clone(),
        identity.clone(),
    )
    .register(
        RegisterFileParams {
            path: path.to_str().unwrap().into(),
            purpose: FilePurpose::ReadFile,
        },
        &operator,
    )
    .unwrap();
    h.auth
        .authorize(
            &operator,
            AuthorizeParams {
                client_id: actor.client_id().clone(),
                permissions: vec!["plugins.manage".into()],
                targets: vec![target.clone()],
                expires_at: None,
            },
        )
        .unwrap();
    let mut call = h.call_as(
        &actor,
        &target,
        "node.packages.install",
        json!({"archiveRef":reference,"source":{"kind":"local"}}),
    );
    call.expected_revision = Some(0.into());
    call.execution_mode = Some(ExecutionMode::Independent);
    assert_eq!(
        h.host.invoke(&actor, call.clone()).await.unwrap_err().code,
        "PERMISSION_DENIED"
    );
    let file_target = Target {
        host_id: reference.host_id.clone(),
        kind: reference.kind.clone(),
        id: reference.id.clone(),
        session_id: None,
        session_epoch: None,
    };
    h.auth
        .authorize(
            &operator,
            AuthorizeParams {
                client_id: actor.client_id().clone(),
                permissions: vec!["content.read".into()],
                targets: vec![file_target],
                expires_at: None,
            },
        )
        .unwrap();
    assert!(h.auth.require(&actor, "content.read", &target).is_err());
    let query = h.call_as(&actor, &target, "catalog.list", json!({"pageSize":"100"}));
    let result = h
        .host
        .query(
            &actor,
            Query {
                protocol_version: query.protocol_version,
                host_id: query.host_id,
                instance_epoch: query.instance_epoch,
                actor_id: query.actor_id,
                request_id: query.request_id,
                action_id: query.action_id,
                target: query.target,
                params: query.params,
                reveal_target: query.reveal_target,
            },
        )
        .await
        .unwrap();
    let QueryResult::Catalog(catalog) = result else {
        panic!("Expected catalog")
    };
    assert!(
        catalog
            .items
            .iter()
            .any(|item| item.action_id.as_str() == "node.packages.install"),
        "Archive-scoped content permission must discover the real install handler"
    );
    let accepted = h.host.invoke(&actor, call).await.unwrap();
    let completed = h.wait_as(&actor, &accepted.operation_id).await;
    assert_eq!(
        completed.state,
        OperationState::Succeeded,
        "{:?}",
        completed.error
    );
    h.host.shutdown().await.unwrap();
}

#[test]
fn installs_verified_offline_bytes_disabled_without_executing_code_or_hooks() {
    let profile = support::Profile::isolated("node-install-");
    let profile_root = std::fs::canonicalize(profile.path()).unwrap();
    let marker = profile_root.join("must-not-execute.txt");
    let script = format!(
        "import {{writeFileSync}} from 'node:fs'; writeFileSync({}, 'executed');",
        serde_json::to_string(&marker).unwrap()
    );
    let mut files = payloads();
    files.insert("dist/main.mjs".into(), script.as_bytes().to_vec());
    files.insert(
        "package.json".into(),
        serde_json::to_vec(&json!({"scripts":{"postinstall":"node dist/main.mjs"}})).unwrap(),
    );
    let package = verify_local(&with_metadata(files.clone(), false)).unwrap();
    let archive_digest = package.archive_sha256().clone();
    let store = serial_workbench_host::storage::Store::open(&profile_root).unwrap();
    let installer = NodePackageInstaller::new(store.clone(), &profile_root).unwrap();
    let before = installer.snapshot().unwrap();
    assert_eq!(before.revision, 0.into());
    assert!(before.packages.is_empty());
    let installed = installer
        .install(
            package,
            before.revision,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(installed.revision, 1.into());
    assert_eq!(installed.package.manifest.id.as_str(), "example.terminal");
    assert_eq!(installed.package.archive_sha256, archive_digest);
    assert!(!installed.package.enabled);
    assert!(installed.package.execution_trust.is_none());
    assert!(installed.package.verified_source.is_none());
    for (path, bytes) in files {
        assert_eq!(
            std::fs::read(installed.code_directory().join(path)).unwrap(),
            bytes
        );
    }
    assert!(!marker.exists());
    drop(installer);
    let reopened = NodePackageInstaller::new(store, &profile_root).unwrap();
    let snapshot = reopened.snapshot().unwrap();
    assert_eq!(snapshot.revision, installed.revision);
    assert_eq!(snapshot.packages, [installed.package]);
}

#[test]
fn enabling_requires_explicit_trust_bound_to_the_current_archive_and_revision() {
    let profile = support::Profile::isolated("node-trust-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let store = serial_workbench_host::storage::Store::open(&root).unwrap();
    let installer = NodePackageInstaller::new(store, &root).unwrap();
    let installed = installer
        .install(
            verify_local(&with_metadata(payloads(), false)).unwrap(),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let id = &installed.package.manifest.id;
    let digest = &installed.package.archive_sha256;
    assert_eq!(
        installer
            .set_enabled(id, true, installed.revision, digest)
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    assert_eq!(installer.snapshot().unwrap().revision, installed.revision);
    let trusted = installer
        .confirm_execution_trust(id, installed.revision, digest)
        .unwrap();
    assert!(!trusted.packages[0].enabled);
    let confirmation = trusted.packages[0].execution_trust.as_ref().unwrap();
    assert_eq!(&confirmation.archive_sha256, digest);
    assert_eq!(
        confirmation.permissions,
        installed.package.manifest.permissions
    );
    assert!(confirmation.verified_source.is_none());
    let enabled = installer
        .set_enabled(id, true, trusted.revision, digest)
        .unwrap();
    assert!(enabled.packages[0].enabled);
    assert_eq!(
        installer
            .set_enabled(id, false, trusted.revision, digest)
            .unwrap_err()
            .code,
        "REVISION_CONFLICT"
    );
    let stale_digest = "0".repeat(64).as_str().try_into().unwrap();
    assert_eq!(
        installer
            .confirm_execution_trust(id, enabled.revision, &stale_digest)
            .unwrap_err()
            .code,
        "INTEGRITY_FAILED"
    );
    assert_eq!(installer.snapshot().unwrap(), enabled);
    let disabled = installer
        .set_enabled(id, false, enabled.revision, digest)
        .unwrap();
    assert!(!disabled.packages[0].enabled);
    assert_eq!(
        disabled.packages[0].execution_trust,
        enabled.packages[0].execution_trust
    );
}

#[test]
fn compatible_signed_upgrade_inherits_trust_and_keeps_the_previous_code() {
    let profile = support::Profile::isolated("node-upgrade-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let store = serial_workbench_host::storage::Store::open(&root).unwrap();
    let installer = NodePackageInstaller::new(store, &root).unwrap();
    let source: Id = "test-source".try_into().unwrap();
    let key_id: Id = "test-key".try_into().unwrap();
    let key = SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes();
    let verified = |version: &str| {
        let mut files = payloads();
        let mut manifest = manifest();
        manifest["version"] = json!(version);
        files.insert(
            "manifest.json".into(),
            serde_json::to_vec(&manifest).unwrap(),
        );
        verify_node_package(
            archive(&with_metadata(files, true)),
            NodePackageSource::Trusted {
                source: &source,
                key_id: &key_id,
                public_key: &key,
            },
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap()
    };
    let first = installer
        .install(
            verified("1.0.0"),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let id = &first.package.manifest.id;
    let trusted = installer
        .confirm_execution_trust(id, first.revision, &first.package.archive_sha256)
        .unwrap();
    let enabled = installer
        .set_enabled(id, true, trusted.revision, &first.package.archive_sha256)
        .unwrap();
    let upgraded = installer
        .install(
            verified("1.1.0"),
            enabled.revision,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(upgraded.package.manifest.version.as_str(), "1.1.0");
    assert!(upgraded.package.enabled);
    let inherited = upgraded.package.execution_trust.as_ref().unwrap();
    assert_eq!(inherited.archive_sha256, upgraded.package.archive_sha256);
    assert_eq!(inherited.verified_source, first.package.verified_source);
    assert_ne!(first.code_directory(), upgraded.code_directory());
    assert_eq!(
        std::fs::read(first.code_directory().join("dist/main.mjs")).unwrap(),
        payloads()["dist/main.mjs"]
    );
    assert_eq!(installer.snapshot().unwrap().packages, [upgraded.package]);
}

#[test]
fn upgrade_can_narrow_declared_scopes_but_expansion_needs_new_confirmation() {
    let profile = support::Profile::isolated("node-scopes-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let installer = NodePackageInstaller::new(
        serial_workbench_host::storage::Store::open(&root).unwrap(),
        &root,
    )
    .unwrap();
    let mut first_manifest = manifest();
    first_manifest["permissions"]["hostApi"] = json!([
        {"permissions":["content.read","device.modify"],"targetKinds":["session","device"]}
    ]);
    first_manifest["permissions"]["executionPurposes"] = json!(["terminal", "automation"]);
    let first = installer
        .install(
            verified_manifest(first_manifest.clone(), Some(7)),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let id = &first.package.manifest.id;
    let trusted = installer
        .confirm_execution_trust(id, first.revision, &first.package.archive_sha256)
        .unwrap();
    let enabled = installer
        .set_enabled(id, true, trusted.revision, &first.package.archive_sha256)
        .unwrap();
    let mut narrower = first_manifest;
    narrower["version"] = json!("1.1.0");
    narrower["permissions"]["hostApi"] = json!([
        {"permissions":["device.modify"],"targetKinds":["session"]},
        {"permissions":["content.read"],"targetKinds":["device"]}
    ]);
    narrower["permissions"]["executionPurposes"] = json!(["terminal"]);
    let upgraded = installer
        .install(
            verified_manifest(narrower.clone(), Some(7)),
            enabled.revision,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(upgraded.package.enabled);
    assert_eq!(
        upgraded
            .package
            .execution_trust
            .as_ref()
            .unwrap()
            .permissions,
        upgraded.package.manifest.permissions
    );
    narrower["version"] = json!("1.2.0");
    narrower["permissions"]["hostApi"][0]["permissions"] =
        json!(["device.modify", "settings.modify"]);
    let expanded = installer
        .install(
            verified_manifest(narrower, Some(7)),
            upgraded.revision,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(!expanded.package.enabled);
    assert!(expanded.package.execution_trust.is_none());
}

#[test]
fn revoking_execution_trust_disables_the_package_and_survives_reopen() {
    let profile = support::Profile::isolated("node-revoke-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let store = serial_workbench_host::storage::Store::open(&root).unwrap();
    let installer = NodePackageInstaller::new(store.clone(), &root).unwrap();
    let first = installer
        .install(
            verified_manifest(manifest(), Some(7)),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let id = &first.package.manifest.id;
    let digest = &first.package.archive_sha256;
    let trusted = installer
        .confirm_execution_trust(id, first.revision, digest)
        .unwrap();
    let enabled = installer
        .set_enabled(id, true, trusted.revision, digest)
        .unwrap();
    let revoked = installer
        .revoke_execution_trust(id, enabled.revision, digest)
        .unwrap();
    assert!(!revoked.packages[0].enabled);
    assert!(revoked.packages[0].execution_trust.is_none());
    assert_eq!(
        revoked.packages[0].verified_source,
        first.package.verified_source
    );
    assert_eq!(
        installer
            .set_enabled(id, true, revoked.revision, digest)
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    assert_eq!(
        NodePackageInstaller::new(store, &root)
            .unwrap()
            .snapshot()
            .unwrap(),
        revoked
    );
    assert!(first.code_directory().join("dist/main.mjs").is_file());
}

#[test]
fn changed_key_local_source_or_runtime_cannot_inherit_execution_trust() {
    for (name, seed, runtime) in [
        ("actual-key-change", Some(8), "node-26.13.0"),
        ("unverified-local", None, "node-26.13.0"),
        ("different-runtime", Some(7), "node-other"),
    ] {
        let profile = support::Profile::isolated("node-identity-");
        let root = std::fs::canonicalize(profile.path()).unwrap();
        let installer = NodePackageInstaller::new(
            serial_workbench_host::storage::Store::open(&root).unwrap(),
            &root,
        )
        .unwrap();
        let first = installer
            .install(
                verified_manifest(manifest(), Some(7)),
                0.into(),
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap();
        let id = &first.package.manifest.id;
        let trusted = installer
            .confirm_execution_trust(id, first.revision, &first.package.archive_sha256)
            .unwrap();
        let enabled = installer
            .set_enabled(id, true, trusted.revision, &first.package.archive_sha256)
            .unwrap();
        let mut next = manifest();
        next["version"] = json!("1.1.0");
        next["runtimeRef"] = json!(runtime);
        let next = installer
            .install(
                verified_manifest(next, seed),
                enabled.revision,
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap();
        assert!(!next.package.enabled, "{name}");
        assert!(next.package.execution_trust.is_none(), "{name}");
        if seed == Some(8) {
            let old = first.package.verified_source.as_ref().unwrap();
            let new = next.package.verified_source.as_ref().unwrap();
            assert_eq!(old.source, new.source);
            assert_eq!(old.key_id, new.key_id);
            assert_ne!(old.public_key_sha256, new.public_key_sha256);
        }
    }
}

#[test]
fn future_installation_format_is_preserved_before_any_staging_write() {
    let profile = support::Profile::isolated("node-future-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let store = serial_workbench_host::storage::Store::open(&root).unwrap();
    let document_id = "node-packages:installed".try_into().unwrap();
    let future = store
        .compare_and_swap_document(
            &document_id,
            0.into(),
            serde_json::from_value(json!({
                "formatVersion":"2", "futureField":{"preserve":"original"}
            }))
            .unwrap(),
        )
        .unwrap();
    let installer = NodePackageInstaller::new(store.clone(), &root).unwrap();
    assert_eq!(installer.snapshot().unwrap_err().code, "FUTURE_FORMAT");
    assert_eq!(
        installer
            .install(
                verified_manifest(manifest(), None),
                future.revision,
                &NodePackageLimits::default(),
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "FUTURE_FORMAT"
    );
    assert_eq!(store.read_document(&document_id).unwrap(), Some(future));
    assert!(!root.join("host-v0/node-packages").exists());
}

#[test]
fn failed_staged_upgrade_preserves_installed_bytes_data_and_original_archive() {
    let profile = support::Profile::isolated("node-failed-stage-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let installer = NodePackageInstaller::new(
        serial_workbench_host::storage::Store::open(&root).unwrap(),
        &root,
    )
    .unwrap();
    let first = installer
        .install(
            verified_manifest(manifest(), None),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let before = installer.snapshot().unwrap();
    let private_data = root.join("plugin-private-state.bin");
    std::fs::write(&private_data, b"unrelated private state").unwrap();
    let mut next = manifest();
    next["version"] = json!("1.1.0");
    let next = verified_manifest(next, None);
    let original_archive = next.archive_bytes().to_vec();
    let restricted = NodePackageLimits {
        max_file_bytes: 8,
        ..Default::default()
    };
    assert_eq!(
        installer
            .install(next, before.revision, &restricted, &AtomicBool::new(false))
            .unwrap_err()
            .code,
        "LIMIT_EXCEEDED"
    );
    assert_eq!(installer.snapshot().unwrap(), before);
    assert_eq!(
        std::fs::read(first.code_directory().join("dist/main.mjs")).unwrap(),
        payloads()["dist/main.mjs"]
    );
    assert_eq!(
        std::fs::read(private_data).unwrap(),
        b"unrelated private state"
    );
    let failures: Vec<_> = std::fs::read_dir(root.join("host-v0/node-packages/staging"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            let receipt: Value =
                serde_json::from_slice(&std::fs::read(path.join("installation.json")).unwrap())
                    .unwrap();
            receipt["outcome"]["committed"] == false
        })
        .collect();
    assert_eq!(failures.len(), 1);
    assert_eq!(
        std::fs::read(failures[0].join("input.zip")).unwrap(),
        original_archive
    );
}

#[test]
fn installation_rechecks_a_stricter_implicit_path_node_budget() {
    let profile = support::Profile::isolated("node-install-nodes-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let installer = NodePackageInstaller::new(
        serial_workbench_host::storage::Store::open(&root).unwrap(),
        &root,
    )
    .unwrap();
    // 五个 ZIP 条目还包含 dist、界面、许可证三个隐式目录，不能仅按条目计数。
    let restricted = NodePackageLimits {
        max_files: 5,
        ..Default::default()
    };
    assert_eq!(
        installer
            .install(
                verified_manifest(manifest(), None),
                0.into(),
                &restricted,
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "LIMIT_EXCEEDED"
    );
    assert!(installer.snapshot().unwrap().packages.is_empty());
}

#[test]
fn installation_rechecks_stricter_metadata_bytes_before_commit() {
    let profile = support::Profile::isolated("node-install-metadata-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let installer = NodePackageInstaller::new(
        serial_workbench_host::storage::Store::open(&root).unwrap(),
        &root,
    )
    .unwrap();
    let restricted = NodePackageLimits {
        max_metadata_bytes: 8,
        ..Default::default()
    };
    assert_eq!(
        installer
            .install(
                verified_manifest(manifest(), None),
                0.into(),
                &restricted,
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "LIMIT_EXCEEDED"
    );
    assert!(installer.snapshot().unwrap().packages.is_empty());
}

#[test]
fn revalidates_committed_installed_bytes_without_enabling_or_executing_them() {
    let profile = support::Profile::isolated("node-installed-verify-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let installer = NodePackageInstaller::new(
        serial_workbench_host::storage::Store::open(&root).unwrap(),
        &root,
    )
    .unwrap();
    let installed = installer
        .install(
            verified_manifest(manifest(), None),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let before = installer.snapshot().unwrap();
    let verified = installer
        .verify_installed(
            &installed.package.manifest.id,
            installed.revision,
            &installed.package.archive_sha256,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(verified.package(), &installed.package);
    assert_eq!(verified.revision(), installed.revision);
    assert_eq!(verified.code_directory(), installed.code_directory());
    assert!(!verified.package().enabled);
    assert!(verified.package().execution_trust.is_none());
    assert_eq!(installer.snapshot().unwrap(), before);
}

#[test]
fn installed_verification_rejects_a_hard_link_even_when_bytes_still_match() {
    let profile = support::Profile::isolated("node-installed-hardlink-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let installer = NodePackageInstaller::new(
        serial_workbench_host::storage::Store::open(&root).unwrap(),
        &root,
    )
    .unwrap();
    let installed = installer
        .install(
            verified_manifest(manifest(), None),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let shared = root.join("outside-code-object.mjs");
    std::fs::hard_link(installed.code_directory().join("dist/main.mjs"), &shared).unwrap();
    let error = installer
        .verify_installed(
            &installed.package.manifest.id,
            installed.revision,
            &installed.package.archive_sha256,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap_err();
    assert_eq!(error.code, "INTEGRITY_FAILED");
    assert_eq!(std::fs::read(shared).unwrap(), payloads()["dist/main.mjs"]);
    assert!(
        !serde_json::to_string(&error)
            .unwrap()
            .contains("node-installed-hardlink-")
    );
}

#[test]
fn installed_verification_requires_the_unchanged_unlinked_original_archive() {
    for fault in ["changed", "missing", "hardlink"] {
        let profile = support::Profile::isolated(&format!("node-installed-archive-{fault}-"));
        let root = std::fs::canonicalize(profile.path()).unwrap();
        let installer = NodePackageInstaller::new(
            serial_workbench_host::storage::Store::open(&root).unwrap(),
            &root,
        )
        .unwrap();
        let installed = installer
            .install(
                verified_manifest(manifest(), None),
                0.into(),
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap();
        let input = root
            .join("host-v0/node-packages/staging")
            .join(installed.code_directory().file_name().unwrap())
            .join("input.zip");
        let original = root.join("original-archive.zip");
        match fault {
            "changed" => {
                std::fs::copy(&input, &original).unwrap();
                std::fs::write(&input, b"different archive bytes").unwrap();
            }
            "missing" => std::fs::rename(&input, &original).unwrap(),
            "hardlink" => std::fs::hard_link(&input, &original).unwrap(),
            _ => unreachable!(),
        }
        let before = installer.snapshot().unwrap();
        let error = installer
            .verify_installed(
                &installed.package.manifest.id,
                installed.revision,
                &installed.package.archive_sha256,
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap_err();
        assert_eq!(error.code, "INTEGRITY_FAILED", "{fault}");
        assert_eq!(installer.snapshot().unwrap(), before);
        assert!(original.is_file());
    }
}

#[test]
fn installed_verification_rejects_changed_missing_and_unlisted_code() {
    for fault in [
        "payload",
        "metadata",
        "missing-file",
        "missing-directory",
        "extra-file",
        "extra-directory",
    ] {
        let profile = support::Profile::isolated(&format!("node-installed-code-{fault}-"));
        let root = std::fs::canonicalize(profile.path()).unwrap();
        let installer = NodePackageInstaller::new(
            serial_workbench_host::storage::Store::open(&root).unwrap(),
            &root,
        )
        .unwrap();
        let installed = installer
            .install(
                verified_manifest(manifest(), None),
                0.into(),
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap();
        let code = installed.code_directory();
        match fault {
            "payload" | "metadata" => {
                let path = code.join(if fault == "payload" {
                    "dist/main.mjs"
                } else {
                    "integrity.json"
                });
                let mut bytes = std::fs::read(&path).unwrap();
                if fault == "payload" {
                    bytes[0] ^= 1;
                } else {
                    *bytes.iter_mut().find(|byte| **byte == b' ').unwrap() = b'\t';
                }
                #[cfg(unix)]
                let previous = {
                    use std::os::unix::fs::PermissionsExt;
                    let previous = std::fs::metadata(&path).unwrap().permissions();
                    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                        .unwrap();
                    previous
                };
                std::fs::write(&path, bytes).unwrap();
                #[cfg(unix)]
                std::fs::set_permissions(path, previous).unwrap();
            }
            "missing-file" => {
                std::fs::rename(code.join("dist/main.mjs"), root.join("retained-main.mjs")).unwrap()
            }
            "missing-directory" => {
                std::fs::rename(code.join("界面"), root.join("retained-ui")).unwrap()
            }
            "extra-file" => {
                std::fs::write(code.join("unlisted.mjs"), b"throw new Error('unlisted');").unwrap()
            }
            "extra-directory" => std::fs::create_dir(code.join("unlisted-directory")).unwrap(),
            _ => unreachable!(),
        }
        let before = installer.snapshot().unwrap();
        let error = installer
            .verify_installed(
                &installed.package.manifest.id,
                installed.revision,
                &installed.package.archive_sha256,
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap_err();
        assert_eq!(error.code, "INTEGRITY_FAILED", "{fault}");
        if matches!(fault, "payload" | "metadata") {
            assert_eq!(
                serde_json::to_value(&error).unwrap()["details"]["reason"],
                "installedFileDigest"
            );
        }
        assert!(
            !serde_json::to_string(&error)
                .unwrap()
                .contains("node-installed-code-")
        );
        assert_eq!(installer.snapshot().unwrap(), before);
    }
}

#[test]
fn installed_verification_rechecks_current_source_after_historical_installation() {
    let profile = support::Profile::isolated("node-installed-source-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let store = serial_workbench_host::storage::Store::open(&root).unwrap();
    let sources = NodePackageSources::new(store.clone());
    let source: Id = "test-source".try_into().unwrap();
    let key_id: Id = "test-key".try_into().unwrap();
    let approval = sources
        .approve_key(
            source.clone(),
            key_id.clone(),
            SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes(),
            0.into(),
        )
        .unwrap();
    let installer = NodePackageInstaller::new(store, &root).unwrap();
    let installed = installer
        .install(
            verified_manifest(manifest(), Some(7)),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let proof = installer
        .verify_installed(
            &installed.package.manifest.id,
            installed.revision,
            &installed.package.archive_sha256,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(
        proof.package().verified_source,
        installed.package.verified_source
    );
    drop(proof);
    let before = installer.snapshot().unwrap();
    sources
        .revoke_key(&source, &key_id, approval.revision)
        .unwrap();
    assert_eq!(
        installer
            .verify_installed(
                &installed.package.manifest.id,
                installed.revision,
                &installed.package.archive_sha256,
                &NodePackageLimits::default(),
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    assert_eq!(installer.snapshot().unwrap(), before);
}

#[test]
fn installed_verification_rejects_a_manifest_record_that_disagrees_with_the_archive() {
    let profile = support::Profile::isolated("node-installed-record-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let store = serial_workbench_host::storage::Store::open(&root).unwrap();
    let installer = NodePackageInstaller::new(store.clone(), &root).unwrap();
    let installed = installer
        .install(
            verified_manifest(manifest(), None),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let document_id = "node-packages:installed".try_into().unwrap();
    let mut value =
        serde_json::to_value(store.read_document(&document_id).unwrap().unwrap().value).unwrap();
    value["packages"]["example.terminal"]["manifest"]["description"] =
        json!("changed persisted description");
    let changed = store
        .compare_and_swap_document(
            &document_id,
            installed.revision,
            serde_json::from_value(value).unwrap(),
        )
        .unwrap();
    let error = installer
        .verify_installed(
            &installed.package.manifest.id,
            changed.revision,
            &installed.package.archive_sha256,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap_err();
    assert_eq!(error.code, "INTEGRITY_FAILED");
    assert_eq!(
        serde_json::to_value(error).unwrap()["details"]["reason"],
        "installedRecordMismatch"
    );
    assert_eq!(store.read_document(&document_id).unwrap(), Some(changed));
}

#[test]
fn installed_verification_preserves_cancellation_budgets_and_expected_identity() {
    let profile = support::Profile::isolated("node-installed-control-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let installer = NodePackageInstaller::new(
        serial_workbench_host::storage::Store::open(&root).unwrap(),
        &root,
    )
    .unwrap();
    let installed = installer
        .install(
            verified_manifest(manifest(), None),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let before = installer.snapshot().unwrap();
    let id = &installed.package.manifest.id;
    let hash = &installed.package.archive_sha256;
    assert_eq!(
        installer
            .verify_installed(
                id,
                installed.revision,
                hash,
                &NodePackageLimits::default(),
                &AtomicBool::new(true)
            )
            .unwrap_err()
            .code,
        "CANCELLED"
    );
    let expired = NodePackageLimits {
        timeout: std::time::Duration::ZERO,
        ..Default::default()
    };
    assert_eq!(
        installer
            .verify_installed(
                id,
                installed.revision,
                hash,
                &expired,
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "LIMIT_EXCEEDED"
    );
    let restricted = NodePackageLimits {
        max_archive_bytes: 8,
        ..Default::default()
    };
    assert_eq!(
        installer
            .verify_installed(
                id,
                installed.revision,
                hash,
                &restricted,
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "LIMIT_EXCEEDED"
    );
    assert_eq!(
        installer
            .verify_installed(
                id,
                0.into(),
                hash,
                &NodePackageLimits::default(),
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "REVISION_CONFLICT"
    );
    let changed = "0".repeat(64).as_str().try_into().unwrap();
    assert_eq!(
        installer
            .verify_installed(
                id,
                installed.revision,
                &changed,
                &NodePackageLimits::default(),
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "INTEGRITY_FAILED"
    );
    assert_eq!(
        installer
            .verify_installed(
                &"example.missing".try_into().unwrap(),
                installed.revision,
                hash,
                &NodePackageLimits::default(),
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "NOT_FOUND"
    );
    assert_eq!(installer.snapshot().unwrap(), before);
}

#[cfg(windows)]
#[test]
fn installed_proof_pins_files_and_directories_until_the_owner_is_dropped() {
    let profile = support::Profile::isolated("node-installed-owner-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let installer = NodePackageInstaller::new(
        serial_workbench_host::storage::Store::open(&root).unwrap(),
        &root,
    )
    .unwrap();
    let installed = installer
        .install(
            verified_manifest(manifest(), None),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let proof = installer
        .verify_installed(
            &installed.package.manifest.id,
            installed.revision,
            &installed.package.archive_sha256,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let file = installed.code_directory().join("dist/main.mjs");
    assert!(std::fs::OpenOptions::new().write(true).open(&file).is_err());
    assert!(std::fs::rename(&file, root.join("held-file.mjs")).is_err());
    let directory = installed.code_directory().join("dist");
    let moved = root.join("held-directory");
    assert!(std::fs::rename(&directory, &moved).is_err());
    drop(proof);
    assert!(std::fs::OpenOptions::new().write(true).open(&file).is_ok());
    std::fs::rename(&directory, &moved).unwrap();
    std::fs::rename(&moved, &directory).unwrap();
}

#[cfg(windows)]
#[test]
fn installed_verification_rejects_junction_directories_and_object_roots() {
    use std::os::windows::process::CommandExt;
    for fault in ["directory", "object-root"] {
        let profile = support::Profile::isolated(&format!("node-installed-junction-{fault}-"));
        let root = std::fs::canonicalize(profile.path()).unwrap();
        let installer = NodePackageInstaller::new(
            serial_workbench_host::storage::Store::open(&root).unwrap(),
            &root,
        )
        .unwrap();
        let installed = installer
            .install(
                verified_manifest(manifest(), None),
                0.into(),
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap();
        let selected = if fault == "directory" {
            installed.code_directory().join("dist")
        } else {
            installed.code_directory().to_path_buf()
        };
        let original = root.join("retained-original");
        assert!(selected.starts_with(&root) && original.starts_with(&root));
        std::fs::rename(&selected, &original).unwrap();
        let output = std::process::Command::new("powershell.exe").creation_flags(0x08000000).args([
            "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command",
            "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:SWB_TEST_JUNCTION -Target $env:SWB_TEST_TARGET | Out-Null",
        ]).env("SWB_TEST_JUNCTION", &selected).env("SWB_TEST_TARGET", &original).output().unwrap();
        assert!(
            output.status.success(),
            "cannot create controlled junction: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let error = installer
            .verify_installed(
                &installed.package.manifest.id,
                installed.revision,
                &installed.package.archive_sha256,
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap_err();
        assert_eq!(error.code, "INTEGRITY_FAILED", "{fault}");
        let payload = if fault == "directory" {
            original.join("main.mjs")
        } else {
            original.join("dist/main.mjs")
        };
        assert_eq!(std::fs::read(payload).unwrap(), payloads()["dist/main.mjs"]);
        std::fs::remove_dir(&selected).unwrap();
    }
}

#[cfg(unix)]
#[test]
fn installed_verification_rejects_symbolic_files_directories_and_object_roots() {
    for fault in ["file", "directory", "object-root"] {
        let profile = support::Profile::isolated(&format!("node-installed-symlink-{fault}-"));
        let root = std::fs::canonicalize(profile.path()).unwrap();
        let installer = NodePackageInstaller::new(
            serial_workbench_host::storage::Store::open(&root).unwrap(),
            &root,
        )
        .unwrap();
        let installed = installer
            .install(
                verified_manifest(manifest(), None),
                0.into(),
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap();
        let selected = match fault {
            "file" => installed.code_directory().join("dist/main.mjs"),
            "directory" => installed.code_directory().join("dist"),
            _ => installed.code_directory().to_path_buf(),
        };
        let original = root.join("retained-original");
        std::fs::rename(&selected, &original).unwrap();
        std::os::unix::fs::symlink(&original, &selected).unwrap();
        assert_eq!(
            installer
                .verify_installed(
                    &installed.package.manifest.id,
                    installed.revision,
                    &installed.package.archive_sha256,
                    &NodePackageLimits::default(),
                    &AtomicBool::new(false)
                )
                .unwrap_err()
                .code,
            "INTEGRITY_FAILED",
            "{fault}"
        );
        assert!(original.exists());
    }
}

#[test]
fn source_approval_verifies_the_actual_key_without_granting_execution_trust() {
    let profile = support::Profile::isolated("node-sources-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let store = serial_workbench_host::storage::Store::open(&root).unwrap();
    let sources = NodePackageSources::new(store.clone());
    let source: Id = "test-source".try_into().unwrap();
    let key_id: Id = "test-key".try_into().unwrap();
    let key = SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes();
    let input = archive(&with_metadata(payloads(), true));
    assert_eq!(
        sources
            .verify(
                input.clone(),
                &source,
                &key_id,
                &NodePackageLimits::default(),
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    let approved = sources
        .approve_key(source.clone(), key_id.clone(), key, 0.into())
        .unwrap();
    assert_eq!(approved.revision, 1.into());
    let package = sources
        .verify(
            input,
            &source,
            &key_id,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(
        package
            .verified_source()
            .unwrap()
            .public_key_sha256
            .as_str(),
        format!("{:x}", Sha256::digest(key))
    );
    let installer = NodePackageInstaller::new(store.clone(), &root).unwrap();
    let installed = installer
        .install(
            package,
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(installed.package.verified_source.is_some());
    assert!(installed.package.execution_trust.is_none());
    assert!(!installed.package.enabled);
    assert_eq!(NodePackageSources::new(store).snapshot().unwrap(), approved);
}

#[test]
fn source_key_rotation_and_revocation_keep_history_and_reject_old_receipts() {
    let profile = support::Profile::isolated("node-source-rotation-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let store = serial_workbench_host::storage::Store::open(&root).unwrap();
    let sources = NodePackageSources::new(store.clone());
    let source: Id = "test-source".try_into().unwrap();
    let key_id: Id = "test-key".try_into().unwrap();
    let old_key = SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes();
    let next_key = SigningKey::from_bytes(&[8; 32]).verifying_key().to_bytes();
    let approved = sources
        .approve_key(source.clone(), key_id.clone(), old_key, 0.into())
        .unwrap();
    let old_bytes = archive(&with_metadata(payloads(), true));
    let old = sources
        .verify(
            old_bytes.clone(),
            &source,
            &key_id,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let rotated = sources
        .approve_key(source.clone(), key_id.clone(), next_key, approved.revision)
        .unwrap();
    assert_eq!(rotated.keys.len(), 2);
    assert_eq!(rotated.keys[0].public_key, old_key);
    assert!(!rotated.keys[0].approved);
    assert_eq!(rotated.keys[1].public_key, next_key);
    assert!(rotated.keys[1].approved);
    assert_eq!(
        sources
            .require_current(old.verified_source().unwrap())
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    assert_eq!(
        sources
            .verify(
                old_bytes,
                &source,
                &key_id,
                &NodePackageLimits::default(),
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    let new_bytes = verified_manifest(manifest(), Some(8))
        .archive_bytes()
        .to_vec();
    let current = sources
        .verify(
            new_bytes.clone(),
            &source,
            &key_id,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let revoked = sources
        .revoke_key(&source, &key_id, rotated.revision)
        .unwrap();
    assert_eq!(revoked.keys.len(), 2);
    assert!(revoked.keys.iter().all(|key| !key.approved));
    assert_eq!(
        sources
            .require_current(current.verified_source().unwrap())
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    assert_eq!(
        sources
            .verify(
                new_bytes,
                &source,
                &key_id,
                &NodePackageLimits::default(),
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    assert_eq!(
        sources
            .approve_key(source.clone(), key_id.clone(), old_key, rotated.revision)
            .unwrap_err()
            .code,
        "REVISION_CONFLICT"
    );
    assert_eq!(
        sources
            .approve_key(source, key_id, [0; 32], revoked.revision)
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
    assert_eq!(NodePackageSources::new(store).snapshot().unwrap(), revoked);
}

#[test]
fn future_source_trust_format_is_preserved_by_reads_and_all_mutations() {
    let profile = support::Profile::isolated("node-source-future-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let store = serial_workbench_host::storage::Store::open(&root).unwrap();
    let document_id = "node-packages:sources".try_into().unwrap();
    let future = store
        .compare_and_swap_document(
            &document_id,
            0.into(),
            serde_json::from_value(json!({
                "formatVersion":"2", "futureField":{"preserve":"original"}
            }))
            .unwrap(),
        )
        .unwrap();
    let sources = NodePackageSources::new(store.clone());
    let source: Id = "test-source".try_into().unwrap();
    let key_id: Id = "test-key".try_into().unwrap();
    let key = SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes();
    assert_eq!(sources.snapshot().unwrap_err().code, "FUTURE_FORMAT");
    assert_eq!(
        sources
            .approve_key(source.clone(), key_id.clone(), key, future.revision)
            .unwrap_err()
            .code,
        "FUTURE_FORMAT"
    );
    assert_eq!(
        sources
            .revoke_key(&source, &key_id, future.revision)
            .unwrap_err()
            .code,
        "FUTURE_FORMAT"
    );
    assert_eq!(
        sources
            .verify(
                archive(&with_metadata(payloads(), true)),
                &source,
                &key_id,
                &NodePackageLimits::default(),
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "FUTURE_FORMAT"
    );
    assert_eq!(store.read_document(&document_id).unwrap(), Some(future));
}

#[test]
fn source_trust_storage_cannot_substitute_key_bytes_behind_an_old_fingerprint() {
    let profile = support::Profile::isolated("node-source-tamper-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let store = serial_workbench_host::storage::Store::open(&root).unwrap();
    let sources = NodePackageSources::new(store.clone());
    let source: Id = "test-source".try_into().unwrap();
    let key_id: Id = "test-key".try_into().unwrap();
    let key = SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes();
    let approved = sources
        .approve_key(source.clone(), key_id.clone(), key, 0.into())
        .unwrap();
    let mut substituted = serde_json::to_value(&approved.keys).unwrap();
    substituted[0]["publicKey"] =
        json!(SigningKey::from_bytes(&[8; 32]).verifying_key().to_bytes());
    let document_id = "node-packages:sources".try_into().unwrap();
    let original = store
        .compare_and_swap_document(
            &document_id,
            approved.revision,
            serde_json::from_value(json!({
                "formatVersion":"1", "keys":substituted
            }))
            .unwrap(),
        )
        .unwrap();
    assert_eq!(sources.snapshot().unwrap_err().code, "STORAGE_UNAVAILABLE");
    assert_eq!(
        sources
            .approve_key(source, key_id, key, original.revision)
            .unwrap_err()
            .code,
        "STORAGE_UNAVAILABLE"
    );
    assert_eq!(store.read_document(&document_id).unwrap(), Some(original));
}

#[test]
fn verifies_only_a_pinned_source_key_over_original_integrity_bytes() {
    let files = with_metadata(payloads(), true);
    let source: Id = "test-source".try_into().unwrap();
    let key_id: Id = "test-key".try_into().unwrap();
    let key = SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes();
    let trusted = || NodePackageSource::Trusted {
        source: &source,
        key_id: &key_id,
        public_key: &key,
    };
    let verified = verify_node_package(
        archive(&files),
        trusted(),
        &NodePackageLimits::default(),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(verified.is_source_verified());
    let receipt = verified.verified_source().unwrap();
    assert_eq!(receipt.source, source);
    assert_eq!(receipt.key_id, key_id);
    assert_eq!(
        receipt.public_key_sha256.as_str(),
        format!("{:x}", Sha256::digest(key))
    );
    let mut altered = files;
    altered.get_mut("integrity.json").unwrap().push(b' ');
    assert!(
        verify_node_package(
            archive(&altered),
            trusted(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false)
        )
        .is_err()
    );
}

#[test]
fn rejects_tampering_missing_and_unlisted_payloads() {
    let good = with_metadata(payloads(), false);
    let mut tampered = good.clone();
    tampered.get_mut("dist/main.mjs").unwrap().push(b' ');
    let mut missing = good.clone();
    missing.remove("界面/index.html");
    let mut extra = good;
    extra.insert("unlisted.mjs".into(), b"throw 1".to_vec());
    for files in [tampered, missing, extra] {
        assert!(verify_local(&files).is_err());
    }
}

#[test]
fn rejects_traversal_and_portable_path_aliases() {
    let long_component = "a".repeat(256);
    for path in [
        "../escape.mjs",
        "C:/escape.mjs",
        "DIST/extra.mjs",
        "dist/main.mjs/child",
        "CON.txt",
        "dir./a",
        "dir /a",
        "a:stream",
        "x?y",
        long_component.as_str(),
        "con .txt",
        "COM¹.txt",
        "界面/cafe\u{301}.html",
    ] {
        let mut files = payloads();
        if path.contains("cafe") {
            files.insert("界面/café.html".into(), b"a".to_vec());
        }
        files.insert(path.into(), b"a".to_vec());
        assert!(
            verify_local(&with_metadata(files, false)).is_err(),
            "accepted {path:?}"
        );
    }
}

#[test]
fn preserves_nonconflicting_unicode_names_and_rejects_invalid_utf8() {
    let mut files = payloads();
    files.insert("界面/cafe\u{301}.html".into(), b"nfd".to_vec());
    assert!(verify_local(&with_metadata(files, false)).is_ok());
    let mut bytes = archive(&with_metadata(payloads(), false));
    let mut name = b"dist/main.mjs".to_vec();
    name[0] = 0xff;
    replace_name(&mut bytes, b"dist/main.mjs", &name);
    assert!(
        verify_node_package(
            bytes,
            NodePackageSource::Local,
            &NodePackageLimits::default(),
            &AtomicBool::new(false)
        )
        .is_err()
    );
}

#[test]
fn enforces_archive_payload_metadata_and_cancellation_budgets() {
    let bytes = archive(&with_metadata(payloads(), false));
    let limits = NodePackageLimits {
        max_archive_bytes: 1,
        ..Default::default()
    };
    assert!(
        verify_node_package(
            bytes.clone(),
            NodePackageSource::Local,
            &limits,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    let limits = NodePackageLimits {
        max_total_bytes: 1,
        ..Default::default()
    };
    assert!(
        verify_node_package(
            bytes.clone(),
            NodePackageSource::Local,
            &limits,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    let limits = NodePackageLimits {
        max_metadata_bytes: 1,
        ..Default::default()
    };
    assert!(
        verify_node_package(
            bytes.clone(),
            NodePackageSource::Local,
            &limits,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert_eq!(
        verify_node_package(
            bytes,
            NodePackageSource::Local,
            &NodePackageLimits::default(),
            &AtomicBool::new(true)
        )
        .unwrap_err()
        .code,
        "CANCELLED"
    );
}

#[test]
fn rejects_unknown_duplicate_metadata_and_future_schema_without_fallback() {
    let good = with_metadata(payloads(), false);
    for (file, from, to) in [
        (
            "manifest.json",
            "\"schemaVersion\":\"0.1\"",
            "\"schemaVersion\":\"0.1\",\"schemaVersion\":\"0.1\"",
        ),
        (
            "manifest.json",
            "\"schemaVersion\":\"0.1\"",
            "\"schemaVersion\":\"0.2\"",
        ),
        (
            "integrity.json",
            "\"source\": \"local\"",
            "\"source\": \"local\",\"source\": \"local\"",
        ),
    ] {
        let mut files = good.clone();
        let raw = String::from_utf8(files[file].clone()).unwrap();
        assert!(raw.contains(from));
        files.insert(file.into(), raw.replacen(from, to, 1).into_bytes());
        assert!(verify_local(&files).is_err());
    }
}

#[test]
fn rejects_unknown_source_wrong_key_missing_signature_and_weak_key() {
    let source: Id = "test-source".try_into().unwrap();
    let other: Id = "other".try_into().unwrap();
    let key_id: Id = "test-key".try_into().unwrap();
    let good_key = SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes();
    let wrong_key = SigningKey::from_bytes(&[8; 32]).verifying_key().to_bytes();
    let weak_key = [0; 32];
    let files = with_metadata(payloads(), true);
    for (source, key_id, key) in [
        (&other, &key_id, &good_key),
        (&source, &other, &good_key),
        (&source, &key_id, &wrong_key),
        (&source, &key_id, &weak_key),
    ] {
        let error = verify_node_package(
            archive(&files),
            NodePackageSource::Trusted {
                source,
                key_id,
                public_key: key,
            },
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert_eq!(error.code, "PERMISSION_DENIED");
    }
    let mut missing = files.clone();
    missing.remove("signature.json");
    assert!(
        verify_node_package(
            archive(&missing),
            NodePackageSource::Trusted {
                source: &source,
                key_id: &key_id,
                public_key: &good_key
            },
            &NodePackageLimits::default(),
            &AtomicBool::new(false)
        )
        .is_err()
    );
    // 自述来源和即使真实有效的未知签名都不能通过 Local 路径建立信任。
    assert!(!verify_local(&files).unwrap().is_source_verified());
}

fn replace_name(bytes: &mut [u8], from: &[u8], to: &[u8]) {
    assert_eq!(from.len(), to.len());
    let mut replaced = 0;
    for i in 0..=bytes.len() - from.len() {
        if &bytes[i..i + from.len()] == from {
            bytes[i..i + from.len()].copy_from_slice(to);
            replaced += 1;
        }
    }
    assert!(replaced >= 2, "expected both ZIP headers");
}

#[test]
fn rejects_duplicate_names_and_local_central_header_disagreement() {
    let mut files = payloads();
    files.insert("extra-a.mjs".into(), b"a".to_vec());
    files.insert("extra-b.mjs".into(), b"b".to_vec());
    let mut duplicate = archive(&with_metadata(files, false));
    replace_name(&mut duplicate, b"extra-b.mjs", b"extra-a.mjs");
    assert!(
        verify_node_package(
            duplicate,
            NodePackageSource::Local,
            &NodePackageLimits::default(),
            &AtomicBool::new(false)
        )
        .is_err()
    );
    let mut inconsistent = archive(&with_metadata(payloads(), false));
    let name = inconsistent
        .windows(b"manifest.json".len())
        .position(|bytes| bytes == b"manifest.json")
        .unwrap();
    inconsistent[name + 7] = b'z';
    assert!(
        verify_node_package(
            inconsistent,
            NodePackageSource::Local,
            &NodePackageLimits::default(),
            &AtomicBool::new(false)
        )
        .is_err()
    );
}

#[test]
fn rejects_links_reparse_flags_and_special_file_modes() {
    for creator in [0, 3] {
        for attributes in [(0o120644u32) << 16, (0o010644u32) << 16, 0x400] {
            let mut bytes = archive(&with_metadata(payloads(), false));
            let header = bytes
                .windows(4)
                .position(|part| part == b"PK\x01\x02")
                .unwrap();
            bytes[header + 38..header + 42].copy_from_slice(&attributes.to_le_bytes());
            bytes[header + 5] = creator;
            assert!(
                verify_node_package(
                    bytes,
                    NodePackageSource::Local,
                    &NodePackageLimits::default(),
                    &AtomicBool::new(false)
                )
                .is_err(),
                "accepted attributes={attributes:x} creator={creator}"
            );
        }
    }
}

#[test]
fn bounds_compressible_payload_entry_count_and_deadline() {
    let mut files = payloads();
    files.insert("data.bin".into(), vec![0; 128 * 1024]);
    let bytes = archive(&with_metadata(files, false));
    for limits in [
        NodePackageLimits {
            max_file_bytes: 64 * 1024,
            ..Default::default()
        },
        NodePackageLimits {
            max_files: 2,
            ..Default::default()
        },
        NodePackageLimits {
            timeout: std::time::Duration::ZERO,
            ..Default::default()
        },
    ] {
        assert_eq!(
            verify_node_package(
                bytes.clone(),
                NodePackageSource::Local,
                &limits,
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
            "LIMIT_EXCEEDED"
        );
    }
    let mut zip64 = bytes;
    let end = zip64.len() - 22;
    zip64[end + 10..end + 12].copy_from_slice(&u16::MAX.to_le_bytes());
    assert!(
        verify_node_package(
            zip64,
            NodePackageSource::Local,
            &NodePackageLimits::default(),
            &AtomicBool::new(false)
        )
        .is_err()
    );
}

#[test]
fn bounds_implicit_directory_nodes_even_with_few_archive_entries() {
    let mut files = payloads();
    files.insert(format!("nested/{}data.bin", "d/".repeat(80)), b"a".to_vec());
    let bytes = archive(&with_metadata(files, false));
    let limits = NodePackageLimits {
        max_files: 32,
        ..Default::default()
    };
    assert_eq!(
        verify_node_package(
            bytes,
            NodePackageSource::Local,
            &limits,
            &AtomicBool::new(false)
        )
        .unwrap_err()
        .code,
        "LIMIT_EXCEEDED"
    );
}
