use crate::catalog;
use rmcp::{
    ErrorData, RoleServer, ServerHandler,
    model::{
        CacheScope, CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock,
        DiscoverResult, ErrorCode, InitializeRequestParams, InitializeResult, ListToolsResult,
        PaginatedRequestParams, ServerCapabilities, ServerConfig, SubscriptionFilter,
    },
    service::{NotificationContext, RequestContext, SubscriptionContext},
};
use serde::{Deserialize, Deserializer};
use serde_json::Value;
use serial_workbench_client::{HostClient, RawConnection};
use serial_workbench_core::*;
use std::{
    collections::HashSet,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::{
    sync::{Mutex, RwLock, watch},
    task::JoinHandle,
};

pub struct McpBridge {
    inner: Arc<Bridge>,
}
struct Bridge {
    connection: RwLock<Arc<Connection>>,
    reconnecting: Mutex<()>,
    changes: watch::Sender<Option<(U64, Digest)>>,
    legacy_notifier: StdMutex<Option<JoinHandle<()>>>,
}
struct Connection {
    client: Arc<HostClient>,
    healthy: Arc<AtomicBool>,
    pump: JoinHandle<()>,
    raw: Mutex<Option<Arc<RawLink>>>,
    derived: Mutex<Option<Arc<RawLink>>>,
    raw_ids: Arc<StdMutex<HashSet<Id>>>,
}
struct RawLink {
    client: Arc<RawConnection>,
    pump: JoinHandle<()>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolInput {
    target: Target,
    params: JsonObject,
    #[serde(default, deserialize_with = "present")]
    request_id: Option<RequestId>,
    #[serde(default, deserialize_with = "present")]
    expected_revision: Option<U64>,
    #[serde(default, deserialize_with = "present")]
    lease_id: Option<Id>,
    #[serde(default, deserialize_with = "present")]
    execution_mode: Option<ExecutionMode>,
}
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

impl McpBridge {
    pub fn new(client: HostClient) -> Self {
        let (changes, _) = watch::channel(None);
        Self {
            inner: Arc::new(Bridge {
                connection: RwLock::new(Connection::new(client, changes.clone())),
                reconnecting: Mutex::new(()),
                changes,
                legacy_notifier: StdMutex::new(None),
            }),
        }
    }

    async fn connection(&self) -> HostResult<Arc<Connection>> {
        let connection = self.inner.connection.read().await.clone();
        if connection.healthy.load(Ordering::Acquire) {
            return Ok(connection);
        }
        let _guard = self.inner.reconnecting.lock().await;
        let current = self.inner.connection.read().await.clone();
        if current.healthy.load(Ordering::Acquire) {
            return Ok(current);
        }
        // 只在后续显式调用开始时重新 attach，绝不重发失败中的请求。
        let client = current.client.reconnect().await?;
        let replacement = Connection::new(client, self.inner.changes.clone());
        // Host 目录 watch 绑定物理连接；先恢复基线再向并发调用发布新连接。
        Self::catalog_page_on(&replacement, None, None).await?;
        *self.inner.connection.write().await = replacement.clone();
        Ok(replacement)
    }

    async fn catalog_page(&self, token: Option<String>) -> HostResult<CatalogListResult> {
        let connection = self.connection().await?;
        Self::catalog_page_on(&connection, token, None).await
    }

    async fn catalog_page_on(
        connection: &Connection,
        token: Option<String>,
        expected_version: Option<U64>,
    ) -> HostResult<CatalogListResult> {
        let attach = connection.client.attachment();
        let input = ToolInput {
            target: Target {
                host_id: attach.host_id.clone(),
                id: attach.host_id.clone(),
                kind: ResourceKind::try_from("host")?,
                session_id: None,
                session_epoch: None,
            },
            params: serde_json::from_value(
                serde_json::to_value(CatalogListParams {
                    page_size: 100.into(),
                    page_token: token,
                    catalog_version: expected_version,
                })
                .map_err(|_| invalid())?,
            )
            .map_err(|_| invalid())?,
            request_id: None,
            expected_revision: None,
            lease_id: None,
            execution_mode: None,
        };
        let query = query(&connection.client, BuiltinAction::CatalogList.spec(), input);
        match connection.request(RpcRequest::CatalogList(query)).await? {
            RpcReply::Success { result, .. } => match *result {
                RpcResult::Catalog(page) => Ok(page),
                _ => Err(invalid()),
            },
            RpcReply::Failure { error, .. } => Err(error),
        }
    }

    async fn resolve_tool_on(
        connection: &Connection,
        name: &str,
    ) -> HostResult<Option<ActionSpec>> {
        let mut token = None;
        let mut version = None;
        let mut names = HashSet::new();
        let mut selected = None;
        loop {
            let page = Self::catalog_page_on(connection, token, version).await?;
            if version.is_some_and(|expected| expected != page.catalog_version) {
                return Err(HostError::new(
                    "CATALOG_CHANGED",
                    "Host catalog changed during tool resolution",
                ));
            }
            version = Some(page.catalog_version);
            for spec in page.items {
                let tool_name = catalog::tool_name(spec.action_id.as_str())?;
                let matches = tool_name == name;
                if !names.insert(tool_name) {
                    return Err(ambiguous_tool());
                }
                if matches {
                    selected = Some(spec);
                }
            }
            token = page.next_page_token;
            if token.is_none() {
                // 必须读完同一目录快照，不能在后页存在同名工具时提前执行。
                return Ok(selected);
            }
        }
    }

    async fn execute_on(
        connection: &Arc<Connection>,
        spec: &ActionSpec,
        input: ToolInput,
    ) -> HostResult<Value> {
        let request = if spec.kind == ActionKind::Action {
            let attach = connection.client.attachment();
            RpcRequest::Invoke(Call {
                protocol_version: attach.protocol_version,
                host_id: attach.host_id.clone(),
                instance_epoch: attach.instance_epoch,
                actor_id: attach.actor_id.clone(),
                request_id: input.request_id.unwrap_or_else(request_id),
                request_context: attach.request_context.clone(),
                action_id: spec.action_id.clone(),
                target: input.target,
                params: input.params,
                reveal_target: spec.reveal_target.clone(),
                expected_revision: input.expected_revision,
                lease_id: input.lease_id,
                execution_mode: input.execution_mode,
            })
        } else {
            if input.expected_revision.is_some()
                || input.lease_id.is_some()
                || input.execution_mode.is_some()
            {
                return Err(invalid());
            }
            RpcRequest::Query(query(&connection.client, spec, input))
        };
        let close_id = match &request {
            RpcRequest::Query(q)
                if spec.action_id.as_str() == BuiltinAction::SubscriptionClose.action_id() =>
            {
                q.params
                    .get("subscriptionId")
                    .and_then(|v| serde_json::from_value::<Id>(serde_json::to_value(v).ok()?).ok())
            }
            _ => None,
        };
        let raw = request.required_channel()? == RequestChannel::Raw
            || close_id.as_ref().is_some_and(|id| {
                connection
                    .raw_ids
                    .lock()
                    .expect("subscription mutex")
                    .contains(id)
            });
        let reply = if raw {
            let derived = spec.action_id.as_str() == BuiltinAction::StreamDerivedRead.action_id();
            let reply = connection
                .raw_link(derived)
                .await?
                .client
                .request(request)
                .await;
            if reply.is_err() {
                connection.healthy.store(false, Ordering::Release);
            }
            reply
        } else {
            connection.request(request).await
        }?;
        let result = match reply {
            RpcReply::Failure { error, .. } => return Err(error),
            RpcReply::Success { result, .. } => *result,
        };
        match result {
            RpcResult::Operation(result) if spec.kind == ActionKind::Action => {
                serde_json::to_value(result.operation).map_err(|_| invalid())
            }
            RpcResult::Query(result) if spec.kind == ActionKind::Query => {
                if let QueryResult::StreamSubscribe(subscription) = &result {
                    connection
                        .raw_ids
                        .lock()
                        .expect("subscription mutex")
                        .insert(subscription.subscription_id.clone());
                }
                if let Some(id) = close_id {
                    connection
                        .raw_ids
                        .lock()
                        .expect("subscription mutex")
                        .remove(&id);
                }
                let mut tagged = serde_json::to_value(result).map_err(|_| invalid())?;
                tagged
                    .as_object_mut()
                    .and_then(|v| v.remove("value"))
                    .ok_or_else(invalid)
            }
            _ => Err(invalid()),
        }
    }
}

impl Connection {
    fn new(client: HostClient, changes: watch::Sender<Option<(U64, Digest)>>) -> Arc<Self> {
        let client = Arc::new(client);
        let healthy = Arc::new(AtomicBool::new(true));
        let source = client.clone();
        let health = healthy.clone();
        // 每条物理连接只有一个事件拥有者；正文不进入无限工具返回。
        let pump = tokio::spawn(async move {
            while health.load(Ordering::Acquire) {
                match source.next_event().await {
                    Ok(Some(frame)) => {
                        if !health.load(Ordering::Acquire) {
                            break;
                        }
                        if let IpcMessage::CatalogChanged {
                            catalog_version,
                            visibility_token,
                        } = frame.body
                        {
                            let current = Some((catalog_version, visibility_token));
                            if *changes.borrow() != current {
                                changes.send_replace(current);
                            }
                        }
                    }
                    _ => break,
                }
            }
            health.store(false, Ordering::Release);
        });
        Arc::new(Self {
            client,
            healthy,
            pump,
            raw: Mutex::new(None),
            derived: Mutex::new(None),
            raw_ids: Arc::new(StdMutex::new(HashSet::new())),
        })
    }
    async fn request(&self, request: RpcRequest) -> HostResult<RpcReply> {
        let reply = self.client.request(request).await;
        if reply.is_err() {
            self.healthy.store(false, Ordering::Release);
        }
        reply
    }
    async fn raw_link(&self, derived: bool) -> HostResult<Arc<RawLink>> {
        let slot = if derived { &self.derived } else { &self.raw };
        let mut slot = slot.lock().await;
        if let Some(raw) = &*slot {
            return Ok(raw.clone());
        }
        // 一个控制连接只允许一个 Raw 附接；派生分页使用同身份的独立连接对。
        let control = if derived {
            let attached = self.client.reconnect().await?;
            let origin = self.client.attachment();
            let actual = attached.attachment();
            if actual.host_id != origin.host_id
                || actual.instance_epoch != origin.instance_epoch
                || actual.actor_id != origin.actor_id
            {
                self.healthy.store(false, Ordering::Release);
                return Err(HostError::new(
                    "EPOCH_MISMATCH",
                    "Derived connection identity changed",
                ));
            }
            Arc::new(attached)
        } else {
            self.client.clone()
        };
        let client = Arc::new(control.connect_raw().await?);
        let source = client.clone();
        let ids = self.raw_ids.clone();
        let pump = tokio::spawn(async move {
            loop {
                tokio::select! {
                    result = source.next_event() => {
                        let Ok(Some(frame)) = result else { break };
                        if let IpcMessage::SubscriptionEnded { subscription_id, .. } = frame.body {
                            ids.lock().expect("subscription mutex").remove(&subscription_id);
                        }
                    }
                    result = control.next_event(), if derived => {
                        if !matches!(result, Ok(Some(_))) { break; }
                    }
                }
            }
        });
        let link = Arc::new(RawLink { client, pump });
        *slot = Some(link.clone());
        Ok(link)
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.pump.abort();
    }
}
impl Drop for RawLink {
    fn drop(&mut self) {
        self.pump.abort();
    }
}
impl Drop for Bridge {
    fn drop(&mut self) {
        if let Some(task) = self
            .legacy_notifier
            .get_mut()
            .expect("notifier mutex")
            .take()
        {
            task.abort();
        }
    }
}

impl ServerHandler for McpBridge {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_tool_list_changed()
                .build(),
        )
    }
    async fn initialize(
        &self,
        request: InitializeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<InitializeResult, ErrorData> {
        context.peer.set_peer_info(request.clone());
        let negotiated = self.negotiate_initialize(&request)?;
        // 初始化即建立 Host 授权目录 watch，不等待调用方首次 tools/list。
        self.catalog_page(None).await.map_err(protocol_error)?;
        Ok(negotiated)
    }
    async fn discover(
        &self,
        _context: RequestContext<RoleServer>,
    ) -> Result<DiscoverResult, ErrorData> {
        // 新协议没有 initialize；发现握手也先建立同一 Host 目录 watch。
        self.catalog_page(None).await.map_err(protocol_error)?;
        Ok(DiscoverResult::from_server_info(
            self.supported_protocol_versions().into_owned(),
            self.get_info(),
        ))
    }
    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let page = self
            .catalog_page(request.and_then(|p| p.cursor))
            .await
            .map_err(protocol_error)?;
        let mut names = HashSet::new();
        let tools = page
            .items
            .iter()
            .map(|spec| {
                let tool = catalog::tool(spec)?;
                if !names.insert(tool.name.clone()) {
                    return Err(ambiguous_tool());
                }
                Ok(tool)
            })
            .collect::<HostResult<Vec<_>>>()
            .map_err(protocol_error)?;
        let mut result = ListToolsResult::with_all_items(tools)
            .with_ttl_ms(0)
            .with_cache_scope(CacheScope::Private);
        result.next_cursor = page.next_page_token;
        Ok(result)
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let input = serde_json::from_value::<ToolInput>(Value::Object(
            request.arguments.unwrap_or_default(),
        ));
        let execute = async {
            let connection = self.connection().await?;
            let Some(spec) = Self::resolve_tool_on(&connection, &request.name).await? else {
                return Ok(None);
            };
            Self::execute_on(&connection, &spec, input.map_err(|_| invalid())?)
                .await
                .map(Some)
        };
        let result = tokio::select! {
            biased;
            () = context.ct.cancelled() => Err(HostError::new("CANCELLED", "MCP request waiting was cancelled")),
            result = execute => result,
        };
        Ok(match result {
            Ok(Some(value)) => CallToolResult::structured(value),
            Ok(None) => {
                return Err(ErrorData::new(
                    ErrorCode::METHOD_NOT_FOUND,
                    "Unknown Host tool",
                    None,
                ));
            }
            Err(error) => CallToolResult::error(vec![ContentBlock::text(
                serde_json::to_string(&error).expect("HostError JSON"),
            )]),
        }
        .into())
    }
    fn accepted_subscription_filter(
        &self,
        requested: &SubscriptionFilter,
    ) -> Option<SubscriptionFilter> {
        let mut accepted = SubscriptionFilter::default();
        accepted.tools_list_changed = requested.tools_list_changed;
        Some(accepted)
    }
    async fn listen(&self, context: SubscriptionContext) -> Result<(), ErrorData> {
        let mut changes = self.inner.changes.subscribe();
        self.catalog_page(None).await.map_err(protocol_error)?;
        let dirty = changes.borrow_and_update().is_some();
        if dirty && context.accepted().tools_list_changed == Some(true) {
            context
                .sink()
                .notify_tool_list_changed()
                .await
                .map_err(|_| {
                    ErrorData::internal_error("Tool notification delivery failed", None)
                })?;
        }
        loop {
            tokio::select! {
                () = context.cancelled() => return Ok(()),
                changed = changes.changed() => {
                    if changed.is_err() { return Ok(()); }
                    if context.accepted().tools_list_changed == Some(true) {
                        context.sink().notify_tool_list_changed().await.map_err(|_|ErrorData::internal_error("Tool notification delivery failed",None))?;
                    }
                }
            }
        }
    }
    async fn on_initialized(&self, context: NotificationContext<RoleServer>) {
        if !context
            .peer
            .peer_info()
            .is_some_and(|info| info.protocol_version.as_str() < "2026-07-28")
        {
            return;
        }
        let mut changes = self.inner.changes.subscribe();
        let peer = context.peer;
        let task = tokio::spawn(async move {
            let dirty = changes.borrow_and_update().is_some();
            if dirty && peer.notify_tool_list_changed().await.is_err() {
                return;
            }
            while changes.changed().await.is_ok() {
                if peer.notify_tool_list_changed().await.is_err() {
                    break;
                }
            }
        });
        if let Some(previous) = self
            .inner
            .legacy_notifier
            .lock()
            .expect("notifier mutex")
            .replace(task)
        {
            previous.abort();
        }
    }
}

fn query(client: &HostClient, spec: &ActionSpec, input: ToolInput) -> Query {
    let attach = client.attachment();
    Query {
        protocol_version: attach.protocol_version,
        host_id: attach.host_id.clone(),
        instance_epoch: attach.instance_epoch,
        actor_id: attach.actor_id.clone(),
        request_id: input.request_id.unwrap_or_else(request_id),
        action_id: spec.action_id.clone(),
        target: input.target,
        params: input.params,
        reveal_target: spec.reveal_target.clone(),
    }
}
fn request_id() -> RequestId {
    RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).expect("UUID request Id")
}
fn invalid() -> HostError {
    HostError::new(
        "INVALID_ARGUMENT",
        "Invalid Host tool parameters or response",
    )
}
fn ambiguous_tool() -> HostError {
    HostError::new(
        "PROTOCOL_ERROR",
        "Host catalog has ambiguous MCP tool names",
    )
}
fn protocol_error(error: HostError) -> ErrorData {
    ErrorData::invalid_params(error.message.clone(), serde_json::to_value(error).ok())
}
