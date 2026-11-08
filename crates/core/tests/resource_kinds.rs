use serial_workbench_core::{ObjectRef, ResourceKind};

#[test]
fn derived_record_and_receipt_refs_keep_registered_resource_identity() {
    for kind in ["transfer_receipts", "capture_record"] {
        let reference: ObjectRef = serde_json::from_value(
            serde_json::json!({"hostId":"host","kind":kind,"id":"resource","revision":"1"}),
        )
        .unwrap();
        assert_eq!(reference.kind.as_str(), kind);
        assert_eq!(serde_json::to_value(reference).unwrap()["kind"], kind);
    }
}

#[test]
fn unknown_unqualified_resource_kind_remains_rejected() {
    for kind in [
        "future_resource",
        "transfer_receipts_extra",
        "capture_record_extra",
    ] {
        assert!(ResourceKind::try_from(kind).is_err());
        assert!(
            serde_json::from_value::<ObjectRef>(
                serde_json::json!({"hostId":"host","kind":kind,"id":"resource"})
            )
            .is_err()
        );
    }
}
