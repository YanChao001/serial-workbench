use super::ViewHost;
use super::host::{ViewReader, ViewStream};
use crate::host_bridge::DesktopHostBridge;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serial_workbench_core::*;
use std::time::Duration;

pub(crate) struct TestView {
    host: ViewHost,
    reader: ViewReader,
}

pub(crate) struct TestDerivedView(ViewHost, ViewStream);

impl TestDerivedView {
    pub(crate) async fn open(
        bridge: &DesktopHostBridge,
        generation: U64,
        operation_id: Id,
    ) -> Self {
        let host = ViewHost::attach(
            bridge.clone(),
            "main".into(),
            generation,
            operation_id,
            Id::try_from("swb.reference.chart.view").unwrap(),
        )
        .await
        .unwrap();
        assert!(
            host.asset(NodePackagePath::try_from("ui/view.js").unwrap())
                .await
                .unwrap()
                .len()
                > 100
        );
        let reader = host.open_stream().await.unwrap();
        assert!(matches!(reader, ViewStream::Derived(_)));
        Self(host, reader)
    }

    pub(crate) async fn next(&mut self) -> HostResult<serde_json::Value> {
        self.1.next(&self.0).await
    }
}

impl TestView {
    pub(crate) async fn open(
        bridge: &DesktopHostBridge,
        generation: U64,
        operation: Operation,
        target: &Target,
    ) -> Self {
        let host = ViewHost::attach(
            bridge.clone(),
            "main".into(),
            generation,
            operation.operation_id,
            Id::try_from("swb.reference.terminal.view").unwrap(),
        )
        .await
        .unwrap();
        let snapshot = host.snapshot().await.unwrap();
        assert_eq!(target.session_id.as_ref(), Some(&snapshot.session_id));
        assert_eq!(target.session_epoch, Some(snapshot.session_epoch));
        let asset = host
            .asset(NodePackagePath::try_from("ui/view.js").unwrap())
            .await
            .unwrap();
        assert!(!asset.is_empty());
        let reader = host.subscribe().await.unwrap();
        Self { host, reader }
    }

    pub(crate) async fn receive_through(&mut self, marker: &[u8]) -> Vec<u8> {
        tokio::time::timeout(Duration::from_secs(10), async {
            let mut bytes = Vec::new();
            loop {
                let Some(frame) = self.reader.next(&self.host).await.unwrap() else {
                    continue;
                };
                let IpcMessage::RawBatch { batch } = frame.body else {
                    panic!("Unexpected reader frame: {frame:?}");
                };
                for item in batch.items {
                    let StreamItem::Source { event } = item else {
                        panic!("Unexpected view gap: {item:?}");
                    };
                    if let RawPayload::Rx(rx) = event.payload {
                        bytes.extend(STANDARD.decode(rx.bytes_base64.as_str()).unwrap());
                    }
                }
                if bytes.ends_with(marker) {
                    break bytes;
                }
            }
        })
        .await
        .expect("Virtual echo did not reach the native view reader")
    }

    pub(crate) async fn next(&mut self) -> HostResult<Option<WireFrame>> {
        self.reader.next(&self.host).await
    }
}
