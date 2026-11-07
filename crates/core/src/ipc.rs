use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase")]
pub enum IpcChannel {
    Control,
    Raw,
    State,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WireFrame {
    pub request_id: RequestId,
    pub channel: IpcChannel,
    pub body: IpcMessage,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum IpcMessage {
    ClientHello {
        supported_protocol_versions: Vec<String>,
        client_nonce: ContextToken,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::identity::non_null_option"
        )]
        #[schemars(with = "Id")]
        #[specta(type=Id, optional)]
        expected_host_id: Option<Id>,
    },
    HostHello {
        protocol_version: ProtocolVersion,
        host_id: Id,
        instance_epoch: U64,
        server_nonce: ContextToken,
        proof: ContextToken,
    },
    Authenticate {
        client_id: Id,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::identity::non_null_option"
        )]
        #[schemars(with = "ContextToken")]
        #[specta(type=ContextToken, optional)]
        credential: Option<ContextToken>,
    },
    AuthenticateUserControl {
        client_id: Id,
        credential: ContextToken,
    },
    Authenticated {
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::identity::non_null_option"
        )]
        #[schemars(with = "ContextToken")]
        #[specta(type=ContextToken, optional)]
        credential: Option<ContextToken>,
        raw_attach_token: ContextToken,
    },
    RawAttach {
        token: ContextToken,
    },
    RawAttached {},
    Request {
        request: Box<RpcRequest>,
    },
    Reply {
        reply: Box<RpcReply>,
    },
    Error {
        error: HostError,
    },
    RawBatch {
        batch: Box<RawBatch>,
    },
    Delta {
        subscription_id: Id,
        delta: Box<Delta>,
    },
    SubscriptionEnded {
        subscription_id: Id,
        error: HostError,
    },
}
