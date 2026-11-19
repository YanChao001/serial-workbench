//! 相容升级继承启用意图，旧业务回执与新登记分别验收。
use super::*;
use crate::test_support::{self as support, node_host_actions, node_package};
use serde_json::json;
use serial_workbench_client::{ConnectOptions, HostClient};
use std::{path::Path, time::Duration};

#[path = "upgrade_source_tests.rs"]
mod source_commit_tests;

#[path = "uninstall_tests.rs"]
mod uninstall_tests;

fn program(events: &Path, version: u8) -> Vec<u8> {
    format!(
        "import {{appendFileSync}} from 'node:fs'; const event=s=>appendFileSync({},s+'\\n'); export function register(context) {{event('register-{version}');let calls=0;context.actions.register('example.terminal.compute',call=>{{event('call-{version}');return {{value:call.params.value+{version},calls:++calls}};}});return ()=>event('dispose-{version}');}}",
        serde_json::to_string(events).unwrap()
    ).into_bytes()
}

async fn installer(fixture: &node_host_actions::Fixture) -> HostClient {
    let client = HostClient::connect(ConnectOptions::new(
        fixture.dir.path().to_path_buf(),
        id("upgrade-installer"),
        ClientKind::Cli,
    ))
    .await
    .unwrap();
    let authorized = fixture
        .invoke(
            &fixture.user,
            fixture.call(
                &fixture.user,
                &fixture.target,
                "auth.authorize",
                json!({"clientId":client.attachment().client_id,"permissions":["plugins.manage","content.read"],"targets":[fixture.target]}),
            ),
        )
        .await;
    assert_eq!(
        fixture
            .wait(&fixture.user, &authorized.operation_id)
            .await
            .state,
        OperationState::Succeeded
    );
    client
}

pub(super) async fn upgrade_request(
    fixture: &node_host_actions::Fixture,
    installer: &HostClient,
    events: &Path,
    expand_permissions: bool,
    version: u8,
    revision: u64,
    activation: Vec<Id>,
) -> Call {
    let mut spec = node_host_actions::spec();
    if expand_permissions {
        spec.permissions.push("device.modify".into());
    }
    let mut manifest = node_package::manifest();
    manifest["version"] = json!(format!("1.{}.0", version - 1));
    manifest["activation"] = json!(activation);
    manifest["permissions"]["hostApi"] =
        json!([{"permissions":spec.permissions,"targetKinds":spec.target_kinds}]);
    manifest["contributes"]["actions"] = json!([spec]);
    let mut files = node_package::payloads();
    files.insert(
        "manifest.json".into(),
        serde_json::to_vec(&manifest).unwrap(),
    );
    files.insert("dist/main.mjs".into(), program(events, version));
    let path = fixture
        .dir
        .path()
        .join(format!("signed-upgrade-{version}.zip"));
    std::fs::write(
        &path,
        node_package::archive(&node_package::with_metadata(files, true)),
    )
    .unwrap();
    let registered = fixture
        .invoke(
            &fixture.user,
            fixture.call(
                &fixture.user,
                &fixture.target,
                "file.register",
                json!({"path":path.to_str().unwrap(),"purpose":"read_file"}),
            ),
        )
        .await;
    let registered = fixture.wait(&fixture.user, &registered.operation_id).await;
    let Some(ActionResult::FileMetadata(reference)) = registered.result else {
        panic!("Expected registered upgrade archive: {registered:?}");
    };
    let mut request = fixture.call(installer, &fixture.target, "node.packages.install", json!({"archiveRef":reference.file_ref,"source":{"kind":"trusted","source":"test-source","keyId":"test-key"}}));
    request.expected_revision = Some(revision.into());
    request
}

async fn upgrade(
    fixture: &node_host_actions::Fixture,
    installer: &HostClient,
    events: &Path,
    expand_permissions: bool,
) -> (Call, Operation, Digest) {
    let request = upgrade_request(
        fixture,
        installer,
        events,
        expand_permissions,
        2,
        3,
        vec![id("startup")],
    )
    .await;
    let accepted = fixture.invoke(installer, request.clone()).await;
    let settled = fixture.wait(installer, &accepted.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    let Some(ActionResult::NodePackageInstalled(receipt)) = &settled.result else {
        panic!("Expected upgrade receipt: {settled:?}");
    };
    assert_eq!(receipt.revision, 4.into());
    assert!(receipt.package.source_verified);
    assert_eq!(receipt.package.enabled, !expand_permissions);
    assert_eq!(receipt.package.execution_approved, !expand_permissions);
    let archive = receipt.package.archive_sha256.clone();
    (request, settled, archive)
}

async fn runtime(fixture: &node_host_actions::Fixture) -> NodePackageRuntimeStatus {
    let QueryResult::NodePackageRuntime(status) = fixture
        .query(
            &fixture.client,
            &fixture.target,
            "node.packages.runtime",
            json!({"id":"example.terminal"}),
        )
        .await
    else {
        panic!("Expected runtime status");
    };
    status
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_compatible_upgrade_automatically_registers_without_replaying_business() {
    let markers = support::Profile::isolated("host-node-backend-upgrade-");
    let events = markers.path().join("events.txt");
    let fixture =
        node_host_actions::Fixture::program(node_host_actions::spec(), &program(&events, 1)).await;
    let installer = installer(&fixture).await;
    let old_request = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({"value":10}),
    );
    let old = fixture.invoke(&fixture.client, old_request.clone()).await;
    let old = fixture.wait(&fixture.client, &old.operation_id).await;
    assert_eq!(old.state, OperationState::Succeeded, "{old:?}");
    assert_eq!(
        fixture.result(&fixture.client, &old).await,
        json!({"value":11,"calls":1})
    );
    let (install_request, installed, archive) = upgrade(&fixture, &installer, &events, false).await;
    let mut last = None;
    let activated = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let status = runtime(&fixture).await;
            if status.phase == NodePackageRuntimePhase::Active
                && status.archive_sha256.as_ref() == Some(&archive)
            {
                return status;
            }
            last = Some(status);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    if activated.is_err() {
        let observed = std::fs::read_to_string(&events).unwrap();
        let _profile = fixture.finish().await;
        panic!(
            "Committed compatible upgrade did not automatically register: runtime={last:?} events={observed:?}"
        );
    }
    assert!(activated.unwrap().generation.get() >= 2);
    let replay = fixture.invoke(&fixture.client, old_request).await;
    assert_eq!(replay, old);
    assert_eq!(
        fixture.result(&fixture.client, &replay).await,
        json!({"value":11,"calls":1})
    );
    assert_eq!(fixture.invoke(&installer, install_request).await, installed);
    let fresh = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({"value":10}),
            ),
        )
        .await;
    let fresh = fixture.wait(&fixture.client, &fresh.operation_id).await;
    assert_eq!(fresh.state, OperationState::Succeeded, "{fresh:?}");
    assert_eq!(fresh.owner.version.as_ref().unwrap().as_str(), "1.1.0");
    assert_ne!(fresh.owner, old.owner);
    assert_eq!(
        fixture.result(&fixture.client, &fresh).await,
        json!({"value":12,"calls":1})
    );
    let before_stop = std::fs::read_to_string(&events).unwrap();
    let _profile = fixture.finish().await;
    assert_eq!(
        before_stop,
        "register-1\ncall-1\ndispose-1\nregister-2\ncall-2\n"
    );
    assert_eq!(
        std::fs::read_to_string(&events).unwrap(),
        format!("{before_stop}dispose-2\n")
    );
    eprintln!(
        "native_compatible_upgrade automatic_registration=true old_receipt_immutable=true new_calls=1 order=dispose_then_register"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_upgrade_cannot_replace_revoked_original_activation_actor() {
    let markers = support::Profile::isolated("host-node-backend-upgrade-denied-");
    let events = markers.path().join("events.txt");
    let fixture =
        node_host_actions::Fixture::program(node_host_actions::spec(), &program(&events, 1)).await;
    let installer = installer(&fixture).await;
    let mut restoring = fixture
        .host
        .inner
        .node_test_gates
        .recovery_before_restore
        .arm();
    let (request, installed, archive) = upgrade(&fixture, &installer, &events, false).await;
    // 新归档已提交且取得真实登记名额，再撤销原主体；不与旧owner的失权清理争抢安装名额。
    restoring.entered().await;
    let revoked = fixture.invoke(&fixture.user, fixture.call(&fixture.user, &fixture.target, "auth.revoke", json!({"actorId":fixture.client.attachment().actor_id,"permissions":["plugins.manage"],"targets":[fixture.target]}))).await;
    assert_eq!(
        fixture
            .wait(&fixture.user, &revoked.operation_id)
            .await
            .state,
        OperationState::Succeeded
    );
    restoring.release();
    let mut last = None;
    let denied = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let status = runtime(&fixture).await;
            if status.phase == NodePackageRuntimePhase::Failed
                && status.archive_sha256.as_ref() == Some(&archive)
                && status
                    .error
                    .as_ref()
                    .is_some_and(|error| error.code == "PERMISSION_DENIED")
            {
                return status;
            }
            last = Some(status);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    assert_eq!(fixture.invoke(&installer, request).await, installed);
    let _profile = fixture.finish().await;
    assert!(
        denied.is_ok(),
        "New content must keep the original denied actor: {last:?}"
    );
    let events = std::fs::read_to_string(events).unwrap();
    assert_eq!(
        events
            .lines()
            .filter(|event| *event == "register-1")
            .count(),
        1
    );
    assert!(
        !events.contains("register-2"),
        "Installer permission must not import code: {events}"
    );
    eprintln!(
        "native_upgrade_original_actor installer_authorized=true original_actor_revoked=true new_imports=0 install_receipt=succeeded runtime=permission_denied"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_upgrade_with_expanded_permissions_stays_disabled() {
    let markers = support::Profile::isolated("host-node-backend-upgrade-expanded-");
    let events = markers.path().join("events.txt");
    let fixture =
        node_host_actions::Fixture::program(node_host_actions::spec(), &program(&events, 1)).await;
    let installer = installer(&fixture).await;
    let (_request, _installed, archive) = upgrade(&fixture, &installer, &events, true).await;
    let status = runtime(&fixture).await;
    let QueryResult::NodePackages(list) = fixture
        .query(
            &fixture.client,
            &fixture.target,
            "node.packages.list",
            json!({}),
        )
        .await
    else {
        panic!("Expected package list");
    };
    assert_eq!(list.revision, 4.into());
    assert_eq!(list.packages.len(), 1);
    assert_eq!(list.packages[0].archive_sha256, archive);
    assert!(!list.packages[0].enabled);
    assert!(!list.packages[0].execution_approved);
    let _profile = fixture.finish().await;
    assert_eq!(status.phase, NodePackageRuntimePhase::Inactive);
    assert_eq!(
        std::fs::read_to_string(events).unwrap(),
        "register-1\ndispose-1\n"
    );
    eprintln!(
        "native_upgrade_expanded_permissions install=succeeded enabled=false execution_approved=false new_imports=0"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_uncommitted_upgrade_keeps_prior_committed_registration_intent() {
    let markers = support::Profile::isolated("host-node-backend-upgrade-uncommitted-");
    let events = markers.path().join("events.txt");
    let fixture =
        node_host_actions::Fixture::program(node_host_actions::spec(), &program(&events, 1)).await;
    let installer = installer(&fixture).await;
    let mut scan = fixture
        .host
        .inner
        .node_test_gates
        .recovery_before_scan
        .arm();
    scan.entered().await;
    let (_, installed, archive) = upgrade(&fixture, &installer, &events, false).await;
    let request = upgrade_request(
        &fixture,
        &installer,
        &events,
        false,
        3,
        4,
        vec![id("startup")],
    )
    .await;
    let mut before_commit = fixture
        .host
        .inner
        .node_test_gates
        .upgrade_before_commit
        .arm();
    let accepted = fixture.invoke(&installer, request).await;
    before_commit.entered().await;
    let revoked = fixture.invoke(&fixture.user, fixture.call(&fixture.user, &fixture.target, "auth.revoke", json!({"actorId":installer.attachment().actor_id,"permissions":["plugins.manage"],"targets":[fixture.target]}))).await;
    assert_eq!(
        fixture
            .wait(&fixture.user, &revoked.operation_id)
            .await
            .state,
        OperationState::Succeeded
    );
    before_commit.release();
    let rejected = fixture.wait(&installer, &accepted.operation_id).await;
    assert_eq!(rejected.state, OperationState::Interrupted, "{rejected:?}");
    assert_eq!(rejected.error.as_ref().unwrap().code, "PERMISSION_DENIED");
    assert!(
        rejected.result.is_none(),
        "Uncommitted upgrade cannot have a successful receipt"
    );
    let QueryResult::NodePackages(list) = fixture
        .query(
            &fixture.client,
            &fixture.target,
            "node.packages.list",
            json!({}),
        )
        .await
    else {
        panic!("Expected package list");
    };
    assert_eq!(list.revision, 4.into());
    assert_eq!(list.packages[0].archive_sha256, archive);
    assert!(list.packages[0].enabled && list.packages[0].execution_approved);
    scan.release();
    let mut last = None;
    let restored = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let status = runtime(&fixture).await;
            if status.phase == NodePackageRuntimePhase::Active
                && status.archive_sha256.as_ref() == Some(&archive)
            {
                return status;
            }
            last = Some(status);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    let receipt = fixture
        .query(
            &fixture.client,
            &fixture.target,
            "operation.get",
            json!({"operationId":installed.operation_id}),
        )
        .await;
    let QueryResult::Operation(receipt) = receipt else {
        panic!("Expected original install receipt");
    };
    assert_eq!(receipt.operation, installed);
    let _profile = fixture.finish().await;
    assert!(
        restored.is_ok(),
        "Rejected next upgrade lost a committed enabled intent: {last:?}"
    );
    assert_eq!(
        std::fs::read_to_string(events).unwrap(),
        "register-1\ndispose-1\nregister-2\ndispose-2\n"
    );
    eprintln!(
        "native_uncommitted_upgrade next_install=permission_denied committed_revision=4 previous_registration=active uncommitted_imports=0"
    );
}
