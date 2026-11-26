use super::{ErrorCode, NativeError, NativeResult, ShortcutBinding};
use futures_util::StreamExt;
use serde::Serialize;
use std::collections::HashMap;
use zbus::{
    Connection, MatchRule, MessageStream, Proxy,
    fdo::DBusProxy,
    message::Type,
    names::{BusName, WellKnownName},
    proxy::OwnerChangedStream,
    zvariant::{DynamicType, ObjectPath, OwnedObjectPath, OwnedValue, Value},
};

const SERVICE: &str = "org.freedesktop.portal.Desktop";
const DESKTOP: &str = "/org/freedesktop/portal/desktop";
const SHORTCUTS: &str = "org.freedesktop.portal.GlobalShortcuts";
const REQUEST: &str = "org.freedesktop.portal.Request";
const SESSION: &str = "org.freedesktop.portal.Session";
const ACTION: &str = "send-draft";

type Properties = HashMap<String, OwnedValue>;
type Shortcuts = Vec<(String, Properties)>;

pub(super) enum Signal {
    Pressed(bool),
    Binding(Option<String>),
    Closed,
}

pub(super) struct Portal {
    connection: Connection,
    signals: MessageStream,
    owner_changes: OwnerChangedStream<'static>,
    proxy: Proxy<'static>,
}

impl Portal {
    pub(super) async fn connect(application: Option<&str>) -> NativeResult<Self> {
        let connection = Connection::session().await.map_err(unavailable)?;
        let dbus = DBusProxy::new(&connection).await.map_err(unavailable)?;
        let service = BusName::try_from(SERVICE).expect("static portal service name");
        let owner = match dbus.get_name_owner(service.clone()).await {
            Ok(owner) => owner,
            Err(zbus::fdo::Error::NameHasNoOwner(_)) => {
                dbus.start_service_by_name(
                    WellKnownName::try_from(SERVICE).expect("static portal service name"),
                    0,
                )
                .await
                .map_err(unavailable)?;
                dbus.get_name_owner(service).await.map_err(unavailable)?
            }
            Err(error) => return Err(unavailable(error)),
        };

        // 裸包使用已安装的桌面条目标识。旧版门户没有 Registry，可用常规发现。
        if let Some(application) = application
            && let Ok(registry) = Proxy::new(
                &connection,
                owner.as_str(),
                DESKTOP,
                "org.freedesktop.host.portal.Registry",
            )
            .await
        {
            let result: zbus::Result<()> = registry
                .call("Register", &(application, Properties::new()))
                .await;
            if let Err(error) = result {
                log::debug!("Portal application discovery will use the bus peer: {error}");
            }
        }

        let rule = MatchRule::builder()
            .msg_type(Type::Signal)
            .sender(owner.clone())
            .map_err(unavailable)?
            .path_namespace(DESKTOP)
            .map_err(unavailable)?
            .build();
        // 请求回执和所有会话信号共用一条有序队列，避免抢在订阅前收到 Response。
        let signals = MessageStream::for_match_rule(rule, &connection, Some(32))
            .await
            .map_err(unavailable)?;
        let proxy = Proxy::new_owned(connection.clone(), owner, DESKTOP, SHORTCUTS)
            .await
            .map_err(unavailable)?;
        let owner_changes = proxy.receive_owner_changed().await.map_err(unavailable)?;
        let version = proxy
            .get_property::<u32>("version")
            .await
            .map_err(unavailable)?;
        if version == 0 {
            return Err(super::unavailable());
        }
        Ok(Self {
            connection,
            signals,
            owner_changes,
            proxy,
        })
    }

    pub(super) async fn create_session(&mut self) -> NativeResult<OwnedObjectPath> {
        // 各候选的连接独立，令牌仅需在这一连接的请求之间保持唯一。
        let options = HashMap::from([
            ("handle_token", Value::from("create_send_shortcut")),
            ("session_handle_token", Value::from("send_shortcut")),
        ]);
        let mut response = self.request("CreateSession", &options, None).await?;
        // 门户 1.16 以字符串传递会话路径，沿用协议保留的格式。
        response
            .remove("session_handle")
            .and_then(|value| String::try_from(value).ok())
            .and_then(|path| OwnedObjectPath::try_from(path).ok())
            .ok_or_else(protocol_error)
    }

    pub(super) async fn bind(
        &mut self,
        session: &OwnedObjectPath,
        binding: &ShortcutBinding,
        description: &str,
    ) -> NativeResult<String> {
        let trigger = preferred_trigger(binding);
        let shortcuts = [(
            ACTION,
            HashMap::from([
                ("description", Value::from(description)),
                ("preferred_trigger", Value::from(trigger.as_str())),
            ]),
        )];
        let options = HashMap::from([("handle_token", Value::from("bind_send_shortcut"))]);
        // Tauri 使用 GTK3；未导出的 Wayland 父窗口句柄按协议传空。
        let mut response = self
            .request(
                "BindShortcuts",
                &(session, &shortcuts[..], "", options),
                Some(session),
            )
            .await?;
        let shortcuts = response
            .remove("shortcuts")
            .map(Shortcuts::try_from)
            .transpose()
            .map_err(|_| protocol_error())?
            .unwrap_or_default();
        trigger_description(shortcuts).ok_or_else(|| {
            NativeError::new(
                ErrorCode::Conflict,
                "The portal did not bind a global send shortcut",
            )
        })
    }

    async fn request<B>(
        &mut self,
        method: &str,
        arguments: &B,
        session: Option<&OwnedObjectPath>,
    ) -> NativeResult<Properties>
    where
        B: Serialize + DynamicType,
    {
        let path: OwnedObjectPath = self
            .proxy
            .call(method, arguments)
            .await
            .map_err(portal_error)?;
        while let Some(message) = self.next_message().await {
            let message = message.map_err(portal_error)?;
            let header = message.header();
            if session.is_some_and(|session| session_closed(&header, session)) {
                break;
            }
            if header.interface().is_some_and(|name| name == REQUEST)
                && header.member().is_some_and(|name| name == "Response")
                && header.path().is_some_and(|name| *name == path.as_ref())
            {
                let (code, results): (u32, Properties) =
                    message.body().deserialize().map_err(portal_error)?;
                return match code {
                    0 => Ok(results),
                    1 => Err(NativeError::new(
                        ErrorCode::UserCancelled,
                        "Portal request was cancelled",
                    )),
                    _ => Err(NativeError::new(
                        ErrorCode::Conflict,
                        "The portal rejected the shortcut request",
                    )),
                };
            }
        }
        Err(super::unavailable())
    }

    pub(super) async fn next(&mut self, session: &OwnedObjectPath) -> Signal {
        while let Some(Ok(message)) = self.next_message().await {
            let header = message.header();
            let (Some(interface), Some(member)) = (header.interface(), header.member()) else {
                continue;
            };
            if session_closed(&header, session) {
                break;
            }
            if interface != SHORTCUTS || header.path().is_none_or(|path| path != DESKTOP) {
                continue;
            }
            match member.as_str() {
                "Activated" | "Deactivated" => {
                    if let Ok((owner, action, _, _)) =
                        message
                            .body()
                            .deserialize::<(ObjectPath<'_>, &str, u64, Properties)>()
                        && owner == session.as_ref()
                        && action == ACTION
                    {
                        return Signal::Pressed(member == "Activated");
                    }
                }
                "ShortcutsChanged" => {
                    if let Ok((owner, shortcuts)) =
                        message.body().deserialize::<(ObjectPath<'_>, Shortcuts)>()
                        && owner == session.as_ref()
                    {
                        return Signal::Binding(trigger_description(shortcuts));
                    }
                }
                _ => {}
            }
        }
        Signal::Closed
    }

    async fn next_message(&mut self) -> Option<zbus::Result<zbus::Message>> {
        tokio::select! {
            biased;
            _ = self.owner_changes.next() => None,
            message = self.signals.next() => message,
        }
    }

    pub(super) async fn disconnect(self) {
        let connection = self.connection.clone();
        drop(self);
        if let Err(error) = connection.close().await {
            log::debug!("Global shortcuts bus connection closed: {error}");
        }
    }
}

fn session_closed(header: &zbus::message::Header<'_>, session: &OwnedObjectPath) -> bool {
    header.interface().is_some_and(|name| name == SESSION)
        && header.member().is_some_and(|name| name == "Closed")
        && header.path().is_some_and(|path| *path == session.as_ref())
}

fn trigger_description(shortcuts: Shortcuts) -> Option<String> {
    let (_, mut properties) = shortcuts.into_iter().find(|(id, _)| id == ACTION)?;
    let description = String::try_from(properties.remove("trigger_description")?).ok()?;
    (!description.trim().is_empty()).then_some(description)
}

fn preferred_trigger(binding: &ShortcutBinding) -> String {
    let key = match binding.key.as_str() {
        "Enter" => "Return",
        "," => "comma",
        "." => "period",
        "/" => "slash",
        key => key,
    };
    format!(
        "{}{}{}{}",
        if binding.primary { "CTRL+" } else { "" },
        if binding.alt { "ALT+" } else { "" },
        if binding.shift { "SHIFT+" } else { "" },
        key,
    )
}

fn unavailable(error: impl std::fmt::Display) -> NativeError {
    NativeError::operation(
        ErrorCode::PlatformUnavailable,
        "Global shortcuts portal is unavailable",
        error,
    )
}

fn portal_error(error: impl std::fmt::Display) -> NativeError {
    NativeError::operation(
        ErrorCode::WindowError,
        "Global shortcuts portal request failed",
        error,
    )
}

fn protocol_error() -> NativeError {
    NativeError::new(
        ErrorCode::WindowError,
        "Invalid response from the global shortcuts portal",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portal_variant_returns_the_system_trigger_for_the_requested_action() {
        let triggers = [("another-action", "Super+F7"), (ACTION, "Alt+F8")];
        let shortcuts = triggers
            .into_iter()
            .map(|(id, trigger)| {
                (
                    id.to_owned(),
                    Properties::from([(
                        "trigger_description".into(),
                        OwnedValue::try_from(Value::from(trigger)).unwrap(),
                    )]),
                )
            })
            .collect::<Shortcuts>();
        let variant = OwnedValue::try_from(Value::new(shortcuts)).unwrap();
        assert_eq!(
            trigger_description(Shortcuts::try_from(variant).unwrap()).as_deref(),
            Some("Alt+F8")
        );
        assert!(trigger_description(vec![(ACTION.into(), Properties::new())]).is_none());
    }

    #[test]
    fn portal_closed_signal_matches_only_its_session() {
        let current =
            OwnedObjectPath::try_from("/org/freedesktop/portal/desktop/session/1_42/swb").unwrap();
        let another =
            OwnedObjectPath::try_from("/org/freedesktop/portal/desktop/session/1_43/swb").unwrap();
        let message = zbus::Message::signal(current.as_ref(), SESSION, "Closed")
            .unwrap()
            .build(&Properties::new())
            .unwrap();
        assert!(session_closed(&message.header(), &current));
        assert!(!session_closed(&message.header(), &another));
    }
}
