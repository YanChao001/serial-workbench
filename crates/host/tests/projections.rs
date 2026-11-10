use serial_workbench_core::*;
use serial_workbench_host::{
    auth::{AuthService, AuthenticatedActor},
    clock::SystemClock,
    state::{ProjectionLimits, ProjectionStore, Subscription},
    storage::Store,
};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Barrier, Notify};

fn id(value: &str) -> Id {
    Id::try_from(value).unwrap()
}
fn object(value: u64) -> JsonObject {
    [("value".into(), JsonValue::String(value.to_string()))].into()
}
fn secret(bytes: usize) -> JsonObject {
    [("secret".into(), JsonValue::String("s".repeat(bytes)))].into()
}
struct Fixture {
    _directory: tempfile::TempDir,
    projections: ProjectionStore,
    auth: AuthService,
    actor: AuthenticatedActor,
    control: AuthenticatedActor,
    target: Target,
    scope: Id,
}
impl Fixture {
    fn new(limits: ProjectionLimits, permission: &str) -> Self {
        Self::with_clock(limits, permission, Arc::new(SystemClock::default()))
    }
    fn with_clock(limits: ProjectionLimits, permission: &str, clock: Arc<dyn Clock>) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open_with_clock(directory.path(), clock.clone()).unwrap();
        let identity = store.begin_instance().unwrap();
        let credential = ContextToken::try_from("projection-user-control").unwrap();
        let auth = AuthService::with_clock(store, credential.clone(), clock);
        let actor = auth
            .authenticate(&id("projection-client"), None)
            .unwrap()
            .actor;
        let control = auth
            .authenticate_user_control(&id("projection-operator"), &credential)
            .unwrap();
        let target = Target {
            host_id: identity.host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            id: identity.host_id.clone(),
            session_id: None,
            session_epoch: None,
        };
        if permission != "metadata.read" {
            auth.authorize(
                &control,
                AuthorizeParams {
                    client_id: id("projection-client"),
                    permissions: vec![permission.into()],
                    targets: vec![target.clone()],
                    expires_at: None,
                },
            )
            .unwrap();
        }
        let projections = ProjectionStore::new(identity, auth.clone(), limits);
        let scope = id("host.devices");
        projections
            .register_scope(scope.clone(), target.clone(), permission.into(), object(0))
            .unwrap();
        Self {
            _directory: directory,
            projections,
            auth,
            actor,
            control,
            target,
            scope,
        }
    }
    fn commit(&self, value: u64) -> Delta {
        self.projections
            .commit(
                &self.scope,
                id("devices.changed"),
                object(value),
                object(value),
            )
            .unwrap()
    }
    fn revoke(&self) {
        self.auth
            .revoke(
                &self.control,
                RevokeParams {
                    actor_id: self.actor.id().clone(),
                    permissions: vec!["content.read".into()],
                    targets: vec![self.target.clone()],
                },
            )
            .unwrap();
    }
    fn authorize_content(&self, expires_at: Option<Timestamp>) {
        self.auth
            .authorize(
                &self.control,
                AuthorizeParams {
                    client_id: id("projection-client"),
                    permissions: vec!["content.read".into()],
                    targets: vec![self.target.clone()],
                    expires_at,
                },
            )
            .unwrap();
    }
    fn session_target(&self, epoch: u64) -> Target {
        Target {
            host_id: self.target.host_id.clone(),
            kind: ResourceKind::try_from("session").unwrap(),
            id: id("stable-session"),
            session_id: Some(id("stable-session")),
            session_epoch: Some(epoch.into()),
        }
    }
    fn register_session(&self) -> Id {
        let scope = id("session:stable-session");
        self.projections
            .register_scope(
                scope.clone(),
                self.session_target(1),
                "content.read".into(),
                object(0),
            )
            .unwrap();
        scope
    }
}

#[tokio::test]
async fn reopened_session_ends_old_readers_and_requires_new_snapshot_with_monotonic_revision() {
    let f = Fixture::new(ProjectionLimits::default(), "content.read");
    let scope = f.register_session();
    let first = f
        .projections
        .commit(&scope, id("session.changed"), object(1), object(1))
        .unwrap();
    let mut old = f
        .projections
        .subscribe(&f.actor, &scope, &first.cursor)
        .await
        .unwrap();
    f.projections
        .commit(&scope, id("session.changed"), secret(32), secret(32))
        .unwrap();
    let reopened = f
        .projections
        .commit_for_target(
            &scope,
            f.session_target(2),
            id("session.opened"),
            object(3),
            object(3),
        )
        .unwrap();
    assert_eq!(reopened.revision.get(), 3);
    assert_eq!(reopened.cursor.position.get(), 3);
    assert_eq!(old.next().await.unwrap_err().code, "EPOCH_MISMATCH");
    assert_eq!(f.projections.reader_count(), 0);
    assert!(old.next().await.unwrap().is_none());
    let error = f
        .projections
        .subscribe(&f.actor, &scope, &first.cursor)
        .await
        .err()
        .unwrap();
    assert_eq!(error.code, "CURSOR_EXPIRED");
    assert_eq!(
        serde_json::to_value(error.details.unwrap()).unwrap()["oldestCursor"]["position"],
        "3"
    );
    let snapshot = f.projections.snapshot(&f.actor, &scope).await.unwrap();
    assert_eq!(snapshot.state, object(3));
    assert_eq!(snapshot.revision.get(), 3);
    let mut fresh = f
        .projections
        .subscribe(&f.actor, &scope, &snapshot.cursor)
        .await
        .unwrap();
    f.projections
        .commit(&scope, id("session.changed"), object(4), object(4))
        .unwrap();
    let live = fresh.next().await.unwrap().unwrap();
    assert_eq!(live.previous_cursor.position.get(), 3);
    assert_eq!(live.cursor.position.get(), 4);
    f.projections
        .commit_for_target(
            &scope,
            f.session_target(3),
            id("session.opened"),
            object(5),
            object(5),
        )
        .unwrap();
    assert_eq!(fresh.next().await.unwrap_err().code, "EPOCH_MISMATCH");
    assert_eq!(
        f.projections
            .snapshot(&f.actor, &scope)
            .await
            .unwrap()
            .revision
            .get(),
        5
    );
}

#[tokio::test]
async fn new_epoch_only_grant_cannot_replay_old_epoch_history() {
    let f = Fixture::new(ProjectionLimits::default(), "content.read");
    let scope = f.register_session();
    let old = f
        .projections
        .commit(&scope, id("session.changed"), secret(32), secret(32))
        .unwrap();
    let actor = f
        .auth
        .authenticate(&id("new-epoch-reader"), None)
        .unwrap()
        .actor;
    f.auth
        .authorize(
            &f.control,
            AuthorizeParams {
                client_id: id("new-epoch-reader"),
                permissions: vec!["content.read".into()],
                targets: vec![f.session_target(2)],
                expires_at: None,
            },
        )
        .unwrap();
    assert_eq!(
        f.projections
            .snapshot(&actor, &scope)
            .await
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    f.projections
        .commit_for_target(
            &scope,
            f.session_target(2),
            id("session.opened"),
            object(2),
            object(2),
        )
        .unwrap();
    let snapshot = f.projections.snapshot(&actor, &scope).await.unwrap();
    assert_eq!(snapshot.state, object(2));
    assert_eq!(
        f.projections
            .subscribe(&actor, &scope, &old.cursor)
            .await
            .err()
            .unwrap()
            .code,
        "CURSOR_EXPIRED"
    );
    let mut reader = f
        .projections
        .subscribe(&actor, &scope, &snapshot.cursor)
        .await
        .unwrap();
    f.projections
        .commit(&scope, id("session.changed"), object(3), object(3))
        .unwrap();
    assert_eq!(reader.next().await.unwrap().unwrap().payload, object(3));
}

#[tokio::test]
async fn retarget_rejects_identity_epoch_and_capacity_failures_without_changing_state() {
    let f = Fixture::new(ProjectionLimits::default(), "content.read");
    let scope = f.register_session();
    let before = f.projections.snapshot(&f.actor, &scope).await.unwrap();
    let mut wrong_host = f.session_target(2);
    wrong_host.host_id = id("another-host");
    let mut wrong_session = f.session_target(2);
    wrong_session.id = id("other-session");
    wrong_session.session_id = Some(id("other-session"));
    for (target, code) in [
        (f.session_target(1), "EPOCH_MISMATCH"),
        (f.session_target(0), "EPOCH_MISMATCH"),
        (wrong_host, "HOST_ID_MISMATCH"),
        (wrong_session, "INVALID_ARGUMENT"),
        (f.target.clone(), "INVALID_ARGUMENT"),
    ] {
        assert_eq!(
            f.projections
                .commit_for_target(&scope, target, id("session.opened"), object(1), object(1))
                .unwrap_err()
                .code,
            code
        );
        assert_eq!(
            f.projections.snapshot(&f.actor, &scope).await.unwrap(),
            before
        );
    }
    assert_eq!(
        f.projections
            .commit_for_target(
                &scope,
                f.session_target(2),
                id("session.opened"),
                secret(4 * 1024 * 1024),
                object(1)
            )
            .unwrap_err()
            .code,
        "LIMIT_EXCEEDED"
    );
    assert_eq!(
        f.projections.snapshot(&f.actor, &scope).await.unwrap(),
        before
    );
    f.projections
        .commit_for_target(
            &scope,
            f.session_target(2),
            id("session.opened"),
            object(1),
            object(1),
        )
        .unwrap();
    assert_eq!(
        f.projections
            .snapshot(&f.actor, &scope)
            .await
            .unwrap()
            .revision
            .get(),
        1
    );
}

struct AuthGateClock {
    armed: AtomicBool,
    entered: Notify,
    released: std::sync::Mutex<bool>,
    release: std::sync::Condvar,
}
impl AuthGateClock {
    fn new() -> Self {
        Self {
            armed: AtomicBool::new(false),
            entered: Notify::new(),
            released: std::sync::Mutex::new(false),
            release: std::sync::Condvar::new(),
        }
    }
    fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.release.notify_one();
    }
}
impl Clock for AuthGateClock {
    fn mono_ns(&self) -> u64 {
        if self.armed.swap(false, Ordering::SeqCst) {
            self.entered.notify_one();
            let mut released = self.released.lock().unwrap();
            while !*released {
                released = self.release.wait(released).unwrap();
            }
        }
        0
    }
    fn wall_time(&self) -> Timestamp {
        Timestamp::try_from("2026-11-07T00:00:00Z").unwrap()
    }
}

#[tokio::test]
async fn retarget_during_slow_auth_check_rejects_snapshot_and_subscription() {
    for subscribing in [false, true] {
        let clock = Arc::new(AuthGateClock::new());
        let f = Fixture::with_clock(ProjectionLimits::default(), "content.read", clock.clone());
        let scope = f.register_session();
        let cursor = f
            .projections
            .commit(&scope, id("session.changed"), object(1), object(1))
            .unwrap()
            .cursor;
        let reading_store = f.projections.clone();
        let actor = f.actor.clone();
        let reading_scope = scope.clone();
        clock.armed.store(true, Ordering::SeqCst);
        let reading = tokio::spawn(async move {
            if subscribing {
                reading_store
                    .subscribe(&actor, &reading_scope, &cursor)
                    .await
                    .map(|_| ())
            } else {
                reading_store
                    .snapshot(&actor, &reading_scope)
                    .await
                    .map(|_| ())
            }
        });
        let entered = tokio::time::timeout(Duration::from_secs(2), clock.entered.notified()).await;
        if entered.is_err() {
            clock.release();
        }
        entered.unwrap();
        let committed = f.projections.commit_for_target(
            &scope,
            f.session_target(2),
            id("session.opened"),
            object(2),
            object(2),
        );
        clock.release();
        committed.unwrap();
        assert_eq!(reading.await.unwrap().unwrap_err().code, "EPOCH_MISMATCH");
        assert_eq!(f.projections.reader_count(), 0);
        assert_eq!(
            f.projections
                .snapshot(&f.actor, &scope)
                .await
                .unwrap()
                .state,
            object(2)
        );
    }
}

#[tokio::test]
async fn snapshot_ten_replays_eleven_twelve_before_live_thirteen() {
    let f = Fixture::new(ProjectionLimits::default(), "metadata.read");
    for n in 1..=10 {
        f.commit(n);
    }
    let snapshot = f.projections.snapshot(&f.actor, &f.scope).await.unwrap();
    assert_eq!(snapshot.revision.get(), 10);
    assert_eq!(snapshot.cursor.position.get(), 10);
    assert_eq!(snapshot.state, object(10));
    f.commit(11);
    f.commit(12);
    let mut reader = f
        .projections
        .subscribe(&f.actor, &f.scope, &snapshot.cursor)
        .await
        .unwrap();
    assert_eq!(f.projections.reader_count(), 1);
    for n in 11..=12 {
        let delta = reader.next().await.unwrap().unwrap();
        assert_eq!(delta.cursor.position.get(), n);
        assert_eq!(delta.previous_cursor.position.get(), n - 1);
        assert_eq!(delta.revision.get(), n);
        assert_eq!(delta.payload, object(n));
    }
    f.commit(13);
    assert_eq!(
        reader.next().await.unwrap().unwrap().cursor.position.get(),
        13
    );
    reader.close();
    assert_eq!(f.projections.reader_count(), 0);
    assert!(reader.next().await.unwrap().is_none());
}

#[tokio::test]
async fn history_item_expiry_reports_oldest_connectable_cursor() {
    let f = Fixture::new(
        ProjectionLimits {
            history_items: 2,
            ..ProjectionLimits::default()
        },
        "metadata.read",
    );
    let old = f
        .projections
        .snapshot(&f.actor, &f.scope)
        .await
        .unwrap()
        .cursor;
    for n in 1..=3 {
        f.commit(n);
    }
    let error = f
        .projections
        .subscribe(&f.actor, &f.scope, &old)
        .await
        .err()
        .unwrap();
    assert_eq!(error.code, "CURSOR_EXPIRED");
    let details = serde_json::to_value(error.details.unwrap()).unwrap();
    assert_eq!(details["scopeId"], "host.devices");
    assert_eq!(details["snapshotRequired"], true);
    assert_eq!(details["oldestCursor"]["position"], "1");
    let mut boundary = old;
    boundary.position = 1.into();
    let mut reader = f
        .projections
        .subscribe(&f.actor, &f.scope, &boundary)
        .await
        .unwrap();
    assert_eq!(
        reader.next().await.unwrap().unwrap().cursor.position.get(),
        2
    );
}

#[tokio::test]
async fn history_byte_budget_expires_cursor_before_item_limit() {
    let f = Fixture::new(
        ProjectionLimits {
            history_items: 100,
            history_bytes: 1500,
            ..ProjectionLimits::default()
        },
        "metadata.read",
    );
    let old = f
        .projections
        .snapshot(&f.actor, &f.scope)
        .await
        .unwrap()
        .cursor;
    for n in 1..=4 {
        f.projections
            .commit(&f.scope, id("devices.changed"), object(n), secret(400))
            .unwrap();
    }
    assert_eq!(
        f.projections
            .subscribe(&f.actor, &f.scope, &old)
            .await
            .err()
            .unwrap()
            .code,
        "CURSOR_EXPIRED"
    );
}

#[tokio::test]
async fn cursor_identity_scope_and_future_are_rejected() {
    let f = Fixture::new(ProjectionLimits::default(), "metadata.read");
    let cursor = f
        .projections
        .snapshot(&f.actor, &f.scope)
        .await
        .unwrap()
        .cursor;
    for (field, code) in [
        ("host", "HOST_ID_MISMATCH"),
        ("epoch", "EPOCH_MISMATCH"),
        ("scope", "INVALID_ARGUMENT"),
        ("future", "INVALID_ARGUMENT"),
    ] {
        let mut invalid = cursor.clone();
        match field {
            "host" => invalid.host_id = id("other-host"),
            "epoch" => invalid.instance_epoch = 99.into(),
            "scope" => invalid.scope_id = id("host.activity"),
            _ => invalid.position = 1.into(),
        }
        assert_eq!(
            f.projections
                .subscribe(&f.actor, &f.scope, &invalid)
                .await
                .err()
                .unwrap()
                .code,
            code
        );
    }
}

#[tokio::test]
async fn item_overload_discards_body_and_does_not_interrupt_fast_reader() {
    let f = Fixture::new(
        ProjectionLimits {
            queue_items: 1,
            ..ProjectionLimits::default()
        },
        "metadata.read",
    );
    let cursor = f
        .projections
        .snapshot(&f.actor, &f.scope)
        .await
        .unwrap()
        .cursor;
    let mut slow = f
        .projections
        .subscribe(&f.actor, &f.scope, &cursor)
        .await
        .unwrap();
    let mut fast = f
        .projections
        .subscribe(&f.actor, &f.scope, &cursor)
        .await
        .unwrap();
    f.commit(1);
    assert_eq!(fast.next().await.unwrap().unwrap().cursor.position.get(), 1);
    f.commit(2);
    assert_eq!(fast.next().await.unwrap().unwrap().cursor.position.get(), 2);
    assert_eq!(slow.next().await.unwrap_err().code, "CURSOR_EXPIRED");
    assert!(slow.next().await.unwrap().is_none());
    assert_eq!(f.projections.reader_count(), 1);
    drop(fast);
    assert_eq!(f.projections.reader_count(), 0);
}

#[tokio::test]
async fn byte_overload_uses_separate_terminal_slot() {
    let f = Fixture::new(
        ProjectionLimits {
            queue_items: 100,
            queue_bytes: 1500,
            ..ProjectionLimits::default()
        },
        "metadata.read",
    );
    let cursor = f
        .projections
        .snapshot(&f.actor, &f.scope)
        .await
        .unwrap()
        .cursor;
    let mut reader = f
        .projections
        .subscribe(&f.actor, &f.scope, &cursor)
        .await
        .unwrap();
    for n in 1..=4 {
        f.projections
            .commit(&f.scope, id("devices.changed"), object(n), secret(400))
            .unwrap();
    }
    assert_eq!(reader.next().await.unwrap_err().code, "CURSOR_EXPIRED");
    assert_eq!(f.projections.reader_count(), 0);
}

#[tokio::test]
async fn oversized_commit_preserves_state_revision_and_cursor() {
    let f = Fixture::new(
        ProjectionLimits {
            history_bytes: 1200,
            queue_bytes: 1200,
            ..ProjectionLimits::default()
        },
        "metadata.read",
    );
    let before = f.projections.snapshot(&f.actor, &f.scope).await.unwrap();
    for (state, payload) in [(secret(1300), object(1)), (object(1), secret(1300))] {
        assert_eq!(
            f.projections
                .commit(&f.scope, id("devices.changed"), state, payload)
                .unwrap_err()
                .code,
            "LIMIT_EXCEEDED"
        );
        assert_eq!(
            f.projections.snapshot(&f.actor, &f.scope).await.unwrap(),
            before
        );
    }
    f.commit(1);
    assert_eq!(
        f.projections
            .snapshot(&f.actor, &f.scope)
            .await
            .unwrap()
            .revision
            .get(),
        1
    );
}

#[tokio::test]
async fn exact_delta_byte_limit_accounts_for_decimal_cursor_growth() {
    let baseline = Fixture::new(ProjectionLimits::default(), "metadata.read");
    for _ in 1..9 {
        baseline.commit(1);
    }
    let nine = baseline.commit(1);
    let ten = baseline.commit(1);
    let bytes = serde_json::to_vec(&nine).unwrap().len();
    assert_eq!(nine.payload, ten.payload);
    assert_eq!(serde_json::to_vec(&ten).unwrap().len(), bytes + 2);
    let f = Fixture::new(
        ProjectionLimits {
            history_bytes: bytes,
            queue_bytes: bytes,
            ..ProjectionLimits::default()
        },
        "metadata.read",
    );
    for _ in 1..=9 {
        f.commit(1);
    }
    let before = f.projections.snapshot(&f.actor, &f.scope).await.unwrap();
    assert_eq!(
        f.projections
            .commit(&f.scope, id("devices.changed"), object(1), object(1))
            .unwrap_err()
            .code,
        "LIMIT_EXCEEDED"
    );
    assert_eq!(
        f.projections.snapshot(&f.actor, &f.scope).await.unwrap(),
        before
    );
}

#[tokio::test]
async fn revocation_discards_queued_secret_and_rejects_all_new_reads() {
    let f = Fixture::new(ProjectionLimits::default(), "content.read");
    let cursor = f
        .projections
        .snapshot(&f.actor, &f.scope)
        .await
        .unwrap()
        .cursor;
    let mut reader = f
        .projections
        .subscribe(&f.actor, &f.scope, &cursor)
        .await
        .unwrap();
    f.projections
        .commit(&f.scope, id("devices.changed"), secret(32), secret(32))
        .unwrap();
    f.revoke();
    assert_eq!(reader.next().await.unwrap_err().code, "PERMISSION_DENIED");
    assert_eq!(f.projections.reader_count(), 0);
    assert!(reader.next().await.unwrap().is_none());
    assert_eq!(
        f.projections
            .snapshot(&f.actor, &f.scope)
            .await
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    assert_eq!(
        f.projections
            .subscribe(&f.actor, &f.scope, &cursor)
            .await
            .err()
            .unwrap()
            .code,
        "PERMISSION_DENIED"
    );
}

#[tokio::test]
async fn revoked_then_reauthorized_subscription_cannot_revive_queued_secret() {
    let f = Fixture::new(ProjectionLimits::default(), "content.read");
    let cursor = f
        .projections
        .snapshot(&f.actor, &f.scope)
        .await
        .unwrap()
        .cursor;
    let mut reader = f
        .projections
        .subscribe(&f.actor, &f.scope, &cursor)
        .await
        .unwrap();
    f.projections
        .commit(&f.scope, id("devices.changed"), secret(32), secret(32))
        .unwrap();
    f.revoke();
    f.authorize_content(None);
    assert_eq!(reader.next().await.unwrap_err().code, "PERMISSION_DENIED");
    assert_eq!(f.projections.reader_count(), 0);
    assert!(reader.next().await.unwrap().is_none());
    let snapshot = f.projections.snapshot(&f.actor, &f.scope).await.unwrap();
    let mut new_reader = f
        .projections
        .subscribe(&f.actor, &f.scope, &snapshot.cursor)
        .await
        .unwrap();
    f.commit(2);
    assert_eq!(
        new_reader
            .next()
            .await
            .unwrap()
            .unwrap()
            .cursor
            .position
            .get(),
        2
    );
}

struct IdleClock {
    now: AtomicU64,
    runtime_thread: std::thread::ThreadId,
    armed: AtomicBool,
    waiting: Notify,
}
impl IdleClock {
    fn new() -> Self {
        Self {
            now: AtomicU64::new(0),
            runtime_thread: std::thread::current().id(),
            armed: AtomicBool::new(false),
            waiting: Notify::new(),
        }
    }
    fn arm(&self) {
        self.armed.store(true, Ordering::SeqCst);
    }
    fn advance_ms(&self, ms: u64) {
        self.now.fetch_add(ms * 1_000_000, Ordering::SeqCst);
    }
}
impl Clock for IdleClock {
    fn mono_ns(&self) -> u64 {
        // wait_grant_expiry 在 current-thread 的等待分支调用时钟；Auth 检查在 blocking 线程。
        // 发信号到 select 之间没有 await，同线程测试只有在 next 真正 Pending 后才继续。
        if std::thread::current().id() == self.runtime_thread
            && self.armed.swap(false, Ordering::SeqCst)
        {
            self.waiting.notify_one();
        }
        self.now.load(Ordering::SeqCst)
    }
    fn wall_time(&self) -> Timestamp {
        Timestamp::try_from("2026-11-07T00:00:00Z").unwrap()
    }
}
async fn idle_subscription() -> (Fixture, Arc<IdleClock>, Subscription) {
    let clock = Arc::new(IdleClock::new());
    let f = Fixture::with_clock(ProjectionLimits::default(), "content.read", clock.clone());
    f.authorize_content(Some(Timestamp::try_from("2026-11-07T00:01:00Z").unwrap()));
    let cursor = f
        .projections
        .snapshot(&f.actor, &f.scope)
        .await
        .unwrap()
        .cursor;
    let reader = f
        .projections
        .subscribe(&f.actor, &f.scope, &cursor)
        .await
        .unwrap();
    (f, clock, reader)
}

#[tokio::test(flavor = "current_thread")]
async fn idle_subscription_observes_authorization_change_without_new_delta() {
    let (f, clock, mut reader) = idle_subscription().await;
    clock.arm();
    let waiting = tokio::spawn(async move { reader.next().await });
    tokio::time::timeout(Duration::from_secs(2), clock.waiting.notified())
        .await
        .unwrap();
    f.revoke();
    let error = tokio::time::timeout(Duration::from_secs(2), waiting)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(error.code, "PERMISSION_DENIED");
    assert_eq!(f.projections.reader_count(), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn idle_subscription_cannot_revive_after_coalesced_revoke_and_authorize() {
    let (f, clock, mut reader) = idle_subscription().await;
    clock.arm();
    let waiting = tokio::spawn(async move { reader.next().await });
    tokio::time::timeout(Duration::from_secs(2), clock.waiting.notified())
        .await
        .unwrap();
    // 当前 runtime 线程同步完成两次提交，等待中的 next 无法在两次通知之间运行。
    f.revoke();
    f.authorize_content(None);
    let error = tokio::time::timeout(Duration::from_secs(2), waiting)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(error.code, "PERMISSION_DENIED");
    assert_eq!(f.projections.reader_count(), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn idle_subscription_expires_without_authorization_write_or_delta() {
    let clock = Arc::new(IdleClock::new());
    let f = Fixture::with_clock(ProjectionLimits::default(), "content.read", clock.clone());
    f.authorize_content(Some(
        Timestamp::try_from("2026-11-07T00:00:00.200Z").unwrap(),
    ));
    let cursor = f
        .projections
        .snapshot(&f.actor, &f.scope)
        .await
        .unwrap()
        .cursor;
    let mut reader = f
        .projections
        .subscribe(&f.actor, &f.scope, &cursor)
        .await
        .unwrap();
    let grant_revision = f.auth.grant_revision(&f.actor).unwrap();
    clock.arm();
    let waiting = tokio::spawn(async move { reader.next().await });
    tokio::time::timeout(Duration::from_secs(2), clock.waiting.notified())
        .await
        .unwrap();
    assert!(!waiting.is_finished());
    assert_eq!(f.projections.reader_count(), 1);
    // Only advance the deadline after the reader has entered its actual idle wait.
    clock.advance_ms(200);
    let error = tokio::time::timeout(Duration::from_secs(2), waiting)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(error.code, "PERMISSION_DENIED");
    assert_eq!(f.projections.reader_count(), 0);
    assert_eq!(f.auth.grant_revision(&f.actor).unwrap(), grant_revision);
}

#[tokio::test]
async fn other_actor_grant_change_does_not_end_this_subscription() {
    let f = Fixture::new(ProjectionLimits::default(), "metadata.read");
    let cursor = f
        .projections
        .snapshot(&f.actor, &f.scope)
        .await
        .unwrap()
        .cursor;
    let mut reader = f
        .projections
        .subscribe(&f.actor, &f.scope, &cursor)
        .await
        .unwrap();
    f.auth.authenticate(&id("other-client"), None).unwrap();
    f.auth
        .authorize(
            &f.control,
            AuthorizeParams {
                client_id: id("other-client"),
                permissions: vec!["content.read".into()],
                targets: vec![f.target.clone()],
                expires_at: None,
            },
        )
        .unwrap();
    f.commit(1);
    assert_eq!(
        reader.next().await.unwrap().unwrap().cursor.position.get(),
        1
    );
}

#[tokio::test]
async fn duplicate_scope_never_overwrites_revision_and_invalid_targets_are_rejected() {
    let f = Fixture::new(ProjectionLimits::default(), "metadata.read");
    f.commit(1);
    assert_eq!(
        f.projections
            .register_scope(
                f.scope.clone(),
                f.target.clone(),
                "metadata.read".into(),
                object(0)
            )
            .unwrap_err()
            .code,
        "REVISION_CONFLICT"
    );
    assert_eq!(
        f.projections
            .snapshot(&f.actor, &f.scope)
            .await
            .unwrap()
            .state,
        object(1)
    );
    let mut target = f.target.clone();
    target.id = id("wrong-host");
    assert_eq!(
        f.projections
            .register_scope(
                id("host.activity"),
                target,
                "metadata.read".into(),
                object(0)
            )
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
    let mut session = f.target.clone();
    session.kind = ResourceKind::try_from("session").unwrap();
    session.id = id("a");
    session.session_id = Some(id("b"));
    session.session_epoch = Some(1.into());
    assert_eq!(
        f.projections
            .register_scope(id("session:a"), session, "metadata.read".into(), object(0))
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
    assert_eq!(
        f.projections
            .snapshot(&f.actor, &id("host.unknown"))
            .await
            .unwrap_err()
            .code,
        "NOT_FOUND"
    );
}

#[tokio::test]
async fn concurrent_commits_keep_snapshot_state_and_revision_in_one_linearization() {
    let f = Fixture::new(ProjectionLimits::default(), "metadata.read");
    let gate = Arc::new(Barrier::new(2));
    let writer_store = f.projections.clone();
    let writer_scope = f.scope.clone();
    let writer_gate = gate.clone();
    let writing = tokio::spawn(async move {
        writer_gate.wait().await;
        for n in 1..=100 {
            writer_store
                .commit(&writer_scope, id("devices.changed"), object(n), object(n))
                .unwrap();
            tokio::task::yield_now().await;
        }
    });
    gate.wait().await;
    for _ in 0..100 {
        let snapshot = f.projections.snapshot(&f.actor, &f.scope).await.unwrap();
        assert_eq!(snapshot.state, object(snapshot.revision.get()));
        assert_eq!(snapshot.cursor.position, snapshot.revision);
    }
    writing.await.unwrap();
}

#[tokio::test]
async fn subscribe_racing_commits_delivers_every_position_after_snapshot() {
    let f = Fixture::new(ProjectionLimits::default(), "metadata.read");
    let cursor = f
        .projections
        .snapshot(&f.actor, &f.scope)
        .await
        .unwrap()
        .cursor;
    let gate = Arc::new(Barrier::new(2));
    let store = f.projections.clone();
    let scope = f.scope.clone();
    let writer_gate = gate.clone();
    let writing = tokio::spawn(async move {
        writer_gate.wait().await;
        for n in 1..=100 {
            store
                .commit(&scope, id("devices.changed"), object(n), object(n))
                .unwrap();
            tokio::task::yield_now().await;
        }
    });
    gate.wait().await;
    let mut reader = f
        .projections
        .subscribe(&f.actor, &f.scope, &cursor)
        .await
        .unwrap();
    for n in 1..=100 {
        let delta = tokio::time::timeout(Duration::from_secs(2), reader.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(delta.cursor.position.get(), n);
        assert_eq!(delta.previous_cursor.position.get(), n - 1);
    }
    writing.await.unwrap();
}
