use super::{
    AuthService, AuthenticatedActor, AuthorizationSnapshot, ClientRecord, GrantDocument,
    GrantStamp, MAX_CLIENT_RULES, Rule, corrupt, denied, invalid, limit, matching_rule,
    unauthenticated,
};
use crate::lan::{LanPeer, LanShare, LanShareAccess};
use serde::{Deserialize, Serialize};
use serial_workbench_core::{
    HostError, HostResult, Id, LanPeerSettings, ResourceKind, Target, U64,
};
use serial_workbench_ipc::identity::{credential_verifier, random_token};
use std::{collections::BTreeMap, sync::Arc};

const MAX_LAN_CLIENTS: usize = 1024;

pub(super) type SessionBindings = Arc<BTreeMap<Id, SessionBinding>>;

#[derive(Clone)]
pub(super) struct SessionBinding {
    session: Target,
    device: Target,
}

pub(super) fn base_rule<'a>(
    record: &'a ClientRecord,
    permission: &str,
    target: &Target,
    sessions: Option<&BTreeMap<Id, SessionBinding>>,
) -> Option<&'a Rule> {
    let explicit = matching_rule(record, permission, target);
    if explicit.is_some()
        || sessions.is_none()
        || target.kind.as_str() != "session"
        || matching_rule(record, "metadata.read", target).is_some()
    {
        return explicit;
    }
    let binding = sessions?.get(&target.id)?;
    if &binding.session != target {
        return None;
    }
    matching_rule(record, permission, &binding.device)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct LanClient {
    client_id: Id,
    writes: Vec<LanWriteRule>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct LanWriteRule {
    pub(super) rule: Rule,
    revision: U64,
}

pub(super) enum LanSubject<'a> {
    Actor(&'a Id),
    Client(&'a Id),
}

pub(super) enum LanGrantStamp {
    Write { target: Target, revision: U64 },
    Catalog { revision: U64 },
}

impl LanGrantStamp {
    pub(super) fn matches(&self, record: &ClientRecord, actor_id: &Id) -> bool {
        match self {
            Self::Write { target, revision } => {
                let write = record.lan_write(actor_id, target);
                write.map_or(U64::from(0), |write| write.revision) == *revision
                    && write.is_none_or(|write| write.rule.allowed)
            }
            Self::Catalog { revision } => record.lan_catalog_revision(actor_id) == *revision,
        }
    }
}

impl GrantDocument {
    pub(super) fn has_lan_client(&self, client_id: &Id) -> bool {
        self.clients.values().any(|record| {
            record
                .lan_clients
                .values()
                .any(|client| &client.client_id == client_id)
        })
    }
}

impl ClientRecord {
    pub(super) fn rule_count(&self) -> usize {
        self.rules.len()
            + self
                .lan_clients
                .values()
                .map(|client| client.writes.len())
                .sum::<usize>()
    }

    pub(super) fn lan_write(&self, actor_id: &Id, target: &Target) -> Option<&LanWriteRule> {
        self.lan_clients
            .get(actor_id)?
            .writes
            .iter()
            .find(|write| &write.rule.target == target)
    }

    fn lan_catalog_revision(&self, actor_id: &Id) -> U64 {
        self.lan_clients
            .get(actor_id)
            .and_then(|client| client.writes.iter().map(|write| write.revision).max())
            .unwrap_or_else(|| 0.into())
    }
}

impl AuthorizationSnapshot {
    pub(crate) fn capture_session_write_grants(&self, target: &Target) -> Option<GrantStamp> {
        let mut stamp = self.capture_grants()?;
        let record = self.grants.as_ref()?.record();
        if record.lan_peer.is_some() {
            let write = record.lan_write(self.actor.id(), target);
            stamp.deadline_ns = stamp
                .deadline_ns
                .into_iter()
                .chain(write.and_then(|write| write.rule.deadline_ns.map(U64::get)))
                .min();
            stamp.lan = Some(Arc::new(LanGrantStamp::Write {
                target: target.clone(),
                revision: write.map_or(U64::from(0), |write| write.revision),
            }));
        }
        Some(stamp)
    }

    pub(crate) fn capture_catalog_grants(&self) -> Option<GrantStamp> {
        let mut stamp = self.capture_grants()?;
        let record = self.grants.as_ref()?.record();
        if record.lan_peer.is_some() {
            let now = self.clock.mono_ns();
            let deadlines = record
                .lan_clients
                .get(self.actor.id())
                .into_iter()
                .flat_map(|client| &client.writes)
                .filter(|write| {
                    write.rule.allowed && write.rule.epoch == Some(self.identity.instance_epoch)
                })
                .filter_map(|write| write.rule.deadline_ns.map(U64::get))
                .filter(|deadline| *deadline > now);
            stamp.deadline_ns = stamp.deadline_ns.into_iter().chain(deadlines).min();
            stamp.lan = Some(Arc::new(LanGrantStamp::Catalog {
                revision: record.lan_catalog_revision(self.actor.id()),
            }));
        }
        Some(stamp)
    }
}

impl AuthService {
    pub(super) fn lan_session_bindings(&self) -> HostResult<SessionBindings> {
        Ok(self.lan_sessions.lock().map_err(|_| corrupt())?.clone())
    }

    pub(crate) fn bind_lan_session(&self, session: &Target, device_id: &Id) -> HostResult<()> {
        let device = Target {
            host_id: session.host_id.clone(),
            kind: ResourceKind::try_from("device")?,
            id: device_id.clone(),
            session_id: None,
            session_epoch: None,
        };
        let mut sessions = self.lan_sessions.lock().map_err(|_| corrupt())?;
        Arc::make_mut(&mut sessions).insert(
            session.id.clone(),
            SessionBinding {
                session: session.clone(),
                device,
            },
        );
        Ok(())
    }

    pub(crate) fn register_lan_client(&self, actor: &AuthenticatedActor) -> HostResult<()> {
        let (client_id, actor_id) = actor.grant_owner();
        let _guard = self.serial.lock().map_err(|_| corrupt())?;
        let (revision, document) = self.load()?;
        let record = document
            .clients
            .get(client_id)
            .filter(|record| &record.actor_id == actor_id && record.lan_peer.is_some())
            .ok_or_else(unauthenticated)?;
        if let Some(known) = record.lan_clients.get(actor.id()) {
            return if &known.client_id == actor.client_id() {
                Ok(())
            } else {
                Err(unauthenticated())
            };
        }
        if (actor.client_id() != client_id && document.clients.contains_key(actor.client_id()))
            || document.has_lan_client(actor.client_id())
        {
            return Err(unauthenticated());
        }
        if document
            .clients
            .values()
            .map(|record| record.lan_clients.len())
            .sum::<usize>()
            >= MAX_LAN_CLIENTS
        {
            return Err(limit());
        }
        let mut document = (*document).clone();
        let record = document.clients.get_mut(client_id).ok_or_else(corrupt)?;
        record.lan_clients.insert(
            actor.id().clone(),
            LanClient {
                client_id: actor.client_id().clone(),
                writes: Vec::new(),
            },
        );
        self.save(revision, document)?;
        Ok(())
    }

    pub(super) fn update_lan_writes(
        &self,
        revision: U64,
        mut document: GrantDocument,
        subject: LanSubject<'_>,
        permissions: &[String],
        rules: impl Iterator<Item = Rule>,
    ) -> HostResult<U64> {
        if permissions != ["device.modify"] {
            return Err(denied());
        }
        let (record, actor_id) = document
            .clients
            .values_mut()
            .filter(|record| record.lan_peer.is_some())
            .find_map(|record| {
                let actor_id = match subject {
                    LanSubject::Actor(actor) => record.lan_clients.get_key_value(actor)?.0,
                    LanSubject::Client(id) => {
                        record
                            .lan_clients
                            .iter()
                            .find(|(_, client)| &client.client_id == id)?
                            .0
                    }
                }
                .clone();
                Some((record, actor_id))
            })
            .ok_or_else(denied)?;
        let next = revision.checked_next()?;
        let sessions = self.lan_session_bindings()?;
        let mut changed = false;
        for rule in rules {
            if rule.target.kind.as_str() != "session"
                || (rule.allowed
                    && !base_rule(record, "device.modify", &rule.target, Some(&sessions))
                        .is_some_and(|base| base.allowed))
            {
                return Err(denied());
            }
            let client = record.lan_clients.get_mut(&actor_id).ok_or_else(corrupt)?;
            if let Some(write) = client
                .writes
                .iter_mut()
                .find(|write| write.rule.target == rule.target)
            {
                if write.rule == rule {
                    continue;
                }
                *write = LanWriteRule {
                    rule,
                    revision: next,
                };
            } else {
                if client.writes.len() >= MAX_CLIENT_RULES {
                    return Err(limit());
                }
                client.writes.push(LanWriteRule {
                    rule,
                    revision: next,
                });
            }
            changed = true;
        }
        if !changed {
            return Ok(record.lan_catalog_revision(&actor_id));
        }
        let committed = self.save(revision, document)?;
        self.changes.send_replace(committed);
        Ok(committed)
    }

    pub(crate) fn lan_settings(&self) -> HostResult<Vec<LanPeerSettings>> {
        let (_, document) = self.load()?;
        Ok(document
            .clients
            .values()
            .filter_map(|record| {
                let peer = record.lan_peer.clone()?;
                let shares = record
                    .rules
                    .iter()
                    .filter(|rule| rule.permission == "metadata.read" && rule.allowed)
                    .map(|rule| LanShare {
                        target: rule.target.clone(),
                        access: if super::matching_rule(record, "device.modify", &rule.target)
                            .is_some_and(|write| write.allowed)
                        {
                            LanShareAccess::Operate
                        } else {
                            LanShareAccess::ReadOnly
                        },
                    })
                    .collect();
                Some(LanPeerSettings { peer, shares })
            })
            .collect())
    }

    pub(crate) fn lan_peers(&self) -> HostResult<Vec<LanPeer>> {
        let (_, document) = self.load()?;
        Ok(document
            .clients
            .values()
            .filter_map(|record| record.lan_peer.clone())
            .collect())
    }

    pub(crate) fn authenticate_lan(&self, peer: &LanPeer) -> HostResult<AuthenticatedActor> {
        let (_, document) = self.load()?;
        let (client_id, record) = document
            .clients
            .iter()
            .find(|(_, record)| record.lan_peer.as_ref() == Some(peer))
            .ok_or_else(unauthenticated)?;
        Ok(AuthenticatedActor::from_verified(
            record.actor_id.clone(),
            client_id.clone(),
            record.grant_revision,
            false,
        ))
    }

    pub(crate) fn set_lan_shares(
        &self,
        operator: &AuthenticatedActor,
        peer: LanPeer,
        shares: &[LanShare],
    ) -> HostResult<()> {
        self.require_control(operator)?;
        let _guard = self.serial.lock().map_err(|_| corrupt())?;
        let identity = self.store.identity()?;
        if shares.len() > 64 || peer.host_id == identity.host_id {
            return Err(invalid());
        }
        for (index, share) in shares.iter().enumerate() {
            share.target.validate()?;
            if share.target.host_id != identity.host_id
                || !matches!(share.target.kind.as_str(), "device" | "session")
                || shares[..index]
                    .iter()
                    .any(|other| other.target == share.target)
            {
                return Err(invalid());
            }
        }

        let (revision, document) = self.load()?;
        let mut document = (*document).clone();
        let existing = document.clients.iter().find(|(_, record)| {
            record.lan_peer.as_ref().is_some_and(|known| {
                known.host_id == peer.host_id || known.fingerprint == peer.fingerprint
            })
        });
        let (client_id, mut record) = match existing {
            Some((id, record)) if record.lan_peer.as_ref() == Some(&peer) => {
                (id.clone(), record.clone())
            }
            Some(_) => return Err(pairing_conflict()),
            None => {
                if document.clients.len() >= 1024 {
                    return Err(limit());
                }
                let id = new_id()?;
                if document.clients.contains_key(&id) {
                    return Err(pairing_conflict());
                }
                let record = ClientRecord {
                    actor_id: new_id()?,
                    grant_revision: 0.into(),
                    // 普通本地认证也会明确拒绝 LAN 记录。
                    verifier: credential_verifier(&random_token()),
                    rules: Vec::new(),
                    lan_peer: Some(peer),
                    lan_clients: Default::default(),
                };
                (id, record)
            }
        };

        let next = record.grant_revision.checked_next()?;
        let mut rules = Vec::new();
        for share in shares {
            let permissions: &[&str] = match share.access {
                LanShareAccess::ReadOnly => &["metadata.read", "content.read"],
                LanShareAccess::Operate => &["metadata.read", "content.read", "device.modify"],
            };
            for permission in permissions {
                let mut rule = Rule {
                    permission: (*permission).into(),
                    target: share.target.clone(),
                    allowed: true,
                    expires_at: None,
                    epoch: None,
                    deadline_ns: None,
                    changed_at_revision: next.get(),
                };
                if let Some(previous) = super::matching_rule(&record, permission, &share.target)
                    && previous.allowed
                {
                    rule.changed_at_revision = previous.changed_at_revision;
                }
                rules.push(rule);
            }
        }
        if record.grant_revision.get() != 0 && record.rules == rules {
            return Ok(());
        }
        record.rules = rules;
        record.grant_revision = next;
        document.clients.insert(client_id, record);
        let committed = self.save(revision, document)?;
        self.changes.send_replace(committed);
        Ok(())
    }

    pub(crate) fn unpair_lan(
        &self,
        operator: &AuthenticatedActor,
        peer: &LanPeer,
    ) -> HostResult<()> {
        self.require_control(operator)?;
        let _guard = self.serial.lock().map_err(|_| corrupt())?;
        let (revision, document) = self.load()?;
        let Some((client_id, record)) = document.clients.iter().find(|(_, record)| {
            record
                .lan_peer
                .as_ref()
                .is_some_and(|known| known.host_id == peer.host_id)
        }) else {
            return Ok(());
        };
        if record.lan_peer.as_ref() != Some(peer) {
            return Err(pairing_conflict());
        }
        let mut document = (*document).clone();
        document.clients.remove(client_id);
        let committed = self.save(revision, document)?;
        self.changes.send_replace(committed);
        Ok(())
    }
}

fn new_id() -> HostResult<Id> {
    Id::try_from(uuid::Uuid::new_v4().to_string().as_str())
}

fn pairing_conflict() -> HostError {
    HostError::new(
        "LAN_PEER_CONFLICT",
        "A trusted key or Host ID is already paired",
    )
}
