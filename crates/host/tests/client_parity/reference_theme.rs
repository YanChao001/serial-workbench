//! Verifies the signed appearance contribution through the real Host IPC.
use super::*;
use support::node_package::{archive, with_metadata};

const ID: &str = "swb.reference.theme";
const CONFIGURATION: &str = "swb.reference.theme.configuration";
const THEME: &str = "swb.reference.theme.bench-teal";
const ASSET: &str = "themes/bench-teal.json";
const MANIFEST: &[u8] =
    include_bytes!("../../../../packages/plugin-sdk/examples/reference-theme/manifest.json");
const TOKENS: &[u8] =
    include_bytes!("../../../../packages/plugin-sdk/examples/reference-theme/theme.json");

async fn fixture() -> Fixture {
    Fixture::connected(
        vec![
            "plugins.manage".into(),
            "settings.modify".into(),
            "content.read".into(),
        ],
        serial_workbench_host::device::DeviceService::virtual_opener(),
    )
    .await
}

async fn install(
    fixture: &Fixture,
    signed: bool,
    metadata: &[u8],
    tokens: &[u8],
) -> NodePackageChangeResult {
    let compiled = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.cache/plugin-sdk/examples/reference-theme/main.js");
    let program = std::fs::read(compiled).expect("Compile the public SDK theme fixture");
    let files = [
        ("LICENSE", include_bytes!("../../../../LICENSE").as_slice()),
        ("NOTICE", include_bytes!("../../../../NOTICE").as_slice()),
        ("dist/main.mjs", program.as_slice()),
        ("manifest.json", metadata),
        (ASSET, tokens),
    ]
    .into_iter()
    .map(|(name, contents)| (name.to_owned(), contents.to_vec()))
    .collect();
    let path = fixture.dir.path().join("reference-theme.zip");
    std::fs::write(&path, archive(&with_metadata(files, signed))).unwrap();
    let source = if signed {
        fixture.approve_test_source().await;
        json!({"kind":"trusted","source":"test-source","keyId":"test-key"})
    } else {
        json!({"kind":"local"})
    };
    let installed = fixture.install_archive(&path, source).await;
    assert_eq!(installed.state, OperationState::Succeeded, "{installed:?}");
    let Some(ActionResult::NodePackageInstalled(installed)) = installed.result else {
        panic!("Expected installed theme package");
    };
    *installed
}

async fn confirm(fixture: &Fixture, installed: &NodePackageChangeResult) -> Operation {
    fixture
        .mutate(
            &fixture.user,
            "node.packages.confirmExecutionTrust",
            json!({"id":ID,"archiveSha256":installed.package.archive_sha256}),
            installed.revision.get(),
        )
        .await
}

async fn themes(fixture: &Fixture, reader: &HostClient) -> Vec<NodeThemeEntry> {
    let QueryResult::NodeThemes(result) = fixture
        .query(reader, &fixture.target, "node.themes.list", json!({}))
        .await
    else {
        panic!("Expected live Host theme catalog");
    };
    result.themes
}

async fn enable(fixture: &Fixture, digest: &Digest, enabled: bool, revision: u64) -> Operation {
    fixture
        .mutate(
            &fixture.client,
            "node.packages.setEnabled",
            json!({"id":ID,"archiveSha256":digest,"enabled":enabled}),
            revision,
        )
        .await
}

#[tokio::test]
#[ignore = "Requires pnpm plugin-sdk:fixture and SWB_NODE_RUNTIME_TEST_ROOT"]
async fn native_node_dynamic_theme_publishes_signed_tokens_and_revokes_live_choice() {
    let fixture = fixture().await;
    let signed = install(&fixture, true, MANIFEST, TOKENS).await;
    let confirmed = confirm(&fixture, &signed).await;
    assert_eq!(confirmed.state, OperationState::Succeeded, "{confirmed:?}");
    let reader = HostClient::connect(ConnectOptions::new(
        fixture.dir.path().to_path_buf(),
        id("theme-reader"),
        ClientKind::Cli,
    ))
    .await
    .unwrap();
    let digest = &signed.package.archive_sha256;
    assert!(themes(&fixture, &reader).await.is_empty());

    let active = enable(&fixture, digest, true, 2).await;
    assert_eq!(active.state, OperationState::Succeeded, "{active:?}");
    eprintln!("signed_theme reading registered theme");
    let listed = themes(&fixture, &reader).await;
    assert_eq!(listed.len(), 1);
    let theme = &listed[0];
    assert_eq!(theme.package_id.as_str(), ID);
    assert_eq!(theme.theme_id.as_str(), THEME);
    assert_eq!(&theme.archive_sha256, digest);
    assert_eq!(theme.display_name, "Bench Teal");
    assert_eq!(theme.accent, "#1A6A73");
    eprintln!("signed_theme invoking public configuration");
    let mut configuration = fixture.query_call(&reader, &fixture.target, CONFIGURATION, json!({}));
    configuration.reveal_target.page_id = id("settings");
    let reply = reader
        .request(RpcRequest::Query(configuration))
        .await
        .unwrap();
    assert!(
        matches!(
            &reply,
            RpcReply::Success { result, .. }
                if matches!(result.as_ref(), RpcResult::Query(QueryResult::Extension(_)))
        ),
        "{reply:?}"
    );

    let settings = Target {
        host_id: fixture.target.host_id.clone(),
        kind: ResourceKind::try_from("settings").unwrap(),
        id: id("shared"),
        session_id: None,
        session_epoch: None,
    };
    eprintln!("signed_theme reading base settings");
    let QueryResult::Settings(before) = fixture
        .query(&reader, &settings, "settings.read", json!({}))
        .await
    else {
        panic!("Expected shared settings");
    };
    let mut selected = before.document.value.clone();
    selected.node_theme = Some(Box::new(NodeThemeReference {
        package_id: theme.package_id.clone(),
        theme_id: theme.theme_id.clone(),
        archive_sha256: theme.archive_sha256.clone(),
    }));
    let mut choose = fixture.call(
        &fixture.client,
        &settings,
        "settings.save",
        json!({ "value": selected }),
    );
    choose.expected_revision = Some(before.document.revision);
    eprintln!(
        "signed_theme saving selection against revision {}",
        before.document.revision.get()
    );
    let accepted = fixture.invoke(&fixture.client, choose).await;
    let saved = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_eq!(saved.state, OperationState::Succeeded, "{saved:?}");

    let disabled = enable(&fixture, digest, false, 3).await;
    assert_eq!(disabled.state, OperationState::Succeeded, "{disabled:?}");
    assert!(themes(&fixture, &reader).await.is_empty());

    let reenabled = enable(&fixture, digest, true, 4).await;
    assert_eq!(reenabled.state, OperationState::Succeeded, "{reenabled:?}");
    assert_eq!(themes(&fixture, &reader).await, listed);
    let revoked = fixture
        .mutate(
            &fixture.user,
            "node.packages.revokeExecutionTrust",
            json!({"id":ID,"archiveSha256":digest}),
            5,
        )
        .await;
    assert_eq!(revoked.state, OperationState::Succeeded, "{revoked:?}");
    assert!(themes(&fixture, &reader).await.is_empty());

    let QueryResult::Settings(after) = fixture
        .query(&reader, &settings, "settings.read", json!({}))
        .await
    else {
        panic!("Expected saved shared settings after revocation");
    };
    assert_eq!(after.document.value, selected);
    assert_eq!(after.document.value.accent, before.document.value.accent);
    assert_eq!(
        after.document.value.custom_accent,
        before.document.value.custom_accent
    );

    let receipt = serde_json::to_string(&listed).unwrap();
    let _ = fixture.finish().await;
    eprintln!(
        "signed_theme archive={digest} tokens={receipt} disable_removed=true revocation_removed=true scoped_selection_persisted=true base_accent_preserved=true clean_shutdown=true"
    );
}

#[tokio::test]
#[ignore = "Requires pnpm plugin-sdk:fixture and SWB_NODE_RUNTIME_TEST_ROOT"]
async fn native_node_dynamic_theme_rejects_unsafe_tokens_even_after_valid_signature() {
    let cases = [
        (
            json!({"type":"object"}),
            br##"{"accent":"#1A6A73","background":"url(https://example.invalid/color)"}"##
                .as_slice(),
        ),
        (
            json!({"type":"object","properties":{"accent":{"const":"#010203"}},"required":["accent"]}),
            TOKENS,
        ),
    ];
    for (schema, tokens) in cases {
        let fixture = fixture().await;
        let mut metadata: Value = serde_json::from_slice(MANIFEST).unwrap();
        // The package schema and the Host's fixed type independently constrain the resource.
        metadata["contributes"]["themes"][0]["resourceSchema"] = schema;
        let manifest = serde_json::to_vec(&metadata).unwrap();
        let blocked = install(&fixture, true, &manifest, tokens).await;
        let rejected = confirm(&fixture, &blocked).await;
        assert_eq!(rejected.state, OperationState::Failed, "{rejected:?}");
        assert!(themes(&fixture, &fixture.client).await.is_empty());
        let _ = fixture.finish().await;
    }
    eprintln!("signed_theme invalid_tokens_and_schema_mismatch_rejected=true clean_shutdown=true");
}

#[tokio::test]
#[ignore = "Requires pnpm plugin-sdk:fixture and SWB_NODE_RUNTIME_TEST_ROOT"]
async fn native_node_dynamic_theme_hides_unsigned_resource_after_execution_trust() {
    let fixture = fixture().await;
    let local = install(&fixture, false, MANIFEST, TOKENS).await;
    let confirmed = confirm(&fixture, &local).await;
    assert_eq!(confirmed.state, OperationState::Succeeded, "{confirmed:?}");
    let active = enable(&fixture, &local.package.archive_sha256, true, 2).await;
    assert_eq!(active.state, OperationState::Succeeded, "{active:?}");
    assert!(themes(&fixture, &fixture.client).await.is_empty());

    let _ = fixture.finish().await;
    eprintln!("signed_theme unsigned_resource_hidden=true clean_shutdown=true");
}
