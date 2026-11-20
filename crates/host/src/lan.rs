//! 两个 Host 的认证加密传输。串口与委托授权由 Host 层处理。
mod lanes;
mod peer;
mod rpc_client;
pub(crate) use lanes::{LanOrigin, Lane, LaneReady, read_lane, write_lane};
pub use peer::{LanAdmission, LanConnection, LanEndpoint};
pub use rpc_client::LanHostClient;
pub use serial_workbench_core::{LanPeer, LanShare, LanShareAccess};

use ::ring::{rand::SystemRandom, signature::Ed25519KeyPair};
use rustls::{
    AlertDescription, CertificateError, ClientConfig, CommonState, DigitallySignedStruct,
    DistinguishedName, Error, ServerConfig, SignatureScheme,
    client::{
        AlwaysResolvesClientRawPublicKeys, Resumption,
        danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    },
    crypto::{WebPkiSupportedAlgorithms, ring as tls_ring, verify_tls13_signature_with_raw_key},
    pki_types::{
        CertificateDer, PrivatePkcs8KeyDer, ServerName, SubjectPublicKeyInfoDer, UnixTime,
    },
    server::{
        AlwaysResolvesServerRawPublicKeys,
        danger::{ClientCertVerified, ClientCertVerifier},
    },
    sign::CertifiedKey,
    version::TLS13,
};
use serial_workbench_core::{Digest, HostError, HostResult};
use serial_workbench_ipc::{read_secret, write_secret_new};
use sha2::{Digest as _, Sha256};
use std::{collections::HashSet, io, net::SocketAddr, path::Path, sync::Arc, time::Duration};
use tokio::{net::TcpStream, time::timeout};
use tokio_rustls::{TlsAcceptor, TlsConnector, client, server};

const KEY_FILE: &str = "lan-tls.secret";
const ALPN: &[u8] = b"serial-workbench-lan/0.1";
const CONNECT_DEADLINE: Duration = Duration::from_secs(10);

struct LanIdentity {
    key: Arc<CertifiedKey>,
    fingerprint: Digest,
}

impl LanIdentity {
    /// 调用方须持有该 Host profile 的实例锁。
    fn load_or_create(namespace: &Path) -> HostResult<Self> {
        let path = namespace.join(KEY_FILE);
        if let Some(encoded) = read_secret(&path)? {
            return Self::from_pkcs8(PrivatePkcs8KeyDer::from(encoded));
        }
        let generated =
            Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).map_err(|_| identity_error())?;
        let identity = Self::from_pkcs8(PrivatePkcs8KeyDer::from(generated.as_ref()))?;
        write_secret_new(&path, generated.as_ref())?;
        Ok(identity)
    }

    fn from_pkcs8(encoded: PrivatePkcs8KeyDer<'_>) -> HostResult<Self> {
        let key = tls_ring::sign::any_eddsa_type(&encoded).map_err(|_| identity_error())?;
        let spki = key.public_key().ok_or_else(identity_error)?;
        let fingerprint = fingerprint(spki.as_ref());
        let certificate = CertificateDer::from(spki.as_ref().to_vec());
        Ok(Self {
            key: Arc::new(CertifiedKey::new(vec![certificate], key)),
            fingerprint,
        })
    }

    fn fingerprint(&self) -> &Digest {
        &self.fingerprint
    }

    fn client(&self, trusted_server: Digest) -> HostResult<LanClient> {
        let provider = Arc::new(tls_ring::default_provider());
        let pins = TrustedPins {
            fingerprints: HashSet::from([trusted_server]),
            algorithms: provider.signature_verification_algorithms,
        };
        let mut config = ClientConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&TLS13])
            .map_err(|_| protocol_error())?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(pins))
            .with_client_cert_resolver(Arc::new(AlwaysResolvesClientRawPublicKeys::new(
                self.key.clone(),
            )));
        config.alpn_protocols.push(ALPN.to_vec());
        config.resumption = Resumption::disabled();
        Ok(LanClient(TlsConnector::from(Arc::new(config))))
    }

    fn server(&self, trusted_clients: HashSet<Digest>) -> HostResult<LanServer> {
        let provider = Arc::new(tls_ring::default_provider());
        let pins = TrustedPins {
            fingerprints: trusted_clients,
            algorithms: provider.signature_verification_algorithms,
        };
        let mut config = ServerConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&TLS13])
            .map_err(|_| protocol_error())?
            .with_client_cert_verifier(Arc::new(pins))
            .with_cert_resolver(Arc::new(AlwaysResolvesServerRawPublicKeys::new(
                self.key.clone(),
            )));
        config.alpn_protocols.push(ALPN.to_vec());
        config.send_tls13_tickets = 0;
        Ok(LanServer(TlsAcceptor::from(Arc::new(config))))
    }
}

struct LanClient(TlsConnector);

impl LanClient {
    async fn connect(&self, address: SocketAddr) -> HostResult<client::TlsStream<TcpStream>> {
        timeout(CONNECT_DEADLINE, async {
            let socket = TcpStream::connect(address)
                .await
                .map_err(|_| connection_error())?;
            let name = ServerName::IpAddress(address.ip().into());
            let stream = self
                .0
                .connect(name, socket)
                .await
                .map_err(handshake_error)?;
            require_protocol(stream.get_ref().1)?;
            Ok(stream)
        })
        .await
        .map_err(|_| connection_error())?
    }
}

struct LanServer(TlsAcceptor);

impl LanServer {
    async fn accept(
        &self,
        socket: TcpStream,
    ) -> HostResult<(Digest, server::TlsStream<TcpStream>)> {
        let stream = timeout(CONNECT_DEADLINE, self.0.accept(socket))
            .await
            .map_err(|_| connection_error())?
            .map_err(handshake_error)?;
        let connection = stream.get_ref().1;
        require_protocol(connection)?;
        let key = connection
            .peer_certificates()
            .and_then(|keys| keys.first())
            .ok_or_else(authentication_error)?;
        Ok((fingerprint(key.as_ref()), stream))
    }
}

#[derive(Debug)]
struct TrustedPins {
    fingerprints: HashSet<Digest>,
    algorithms: WebPkiSupportedAlgorithms,
}

impl TrustedPins {
    fn check_pin(
        &self,
        leaf: &CertificateDer<'_>,
        intermediate: &[CertificateDer<'_>],
    ) -> Result<(), Error> {
        if !intermediate.is_empty() {
            return Err(CertificateError::BadEncoding.into());
        }
        if self.fingerprints.contains(&fingerprint(leaf.as_ref())) {
            Ok(())
        } else {
            Err(CertificateError::UnknownIssuer.into())
        }
    }

    fn check_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature_with_raw_key(
            message,
            &SubjectPublicKeyInfoDer::from(cert.as_ref()),
            signature,
            &self.algorithms,
        )
    }
}

impl ServerCertVerifier for TrustedPins {
    fn verify_server_cert(
        &self,
        leaf: &CertificateDer<'_>,
        intermediate: &[CertificateDer<'_>],
        _name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        self.check_pin(leaf, intermediate)?;
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(CertificateError::BadSignature.into())
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.check_signature(message, cert, signature)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ED25519]
    }

    fn requires_raw_public_keys(&self) -> bool {
        true
    }
}

impl ClientCertVerifier for TrustedPins {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }

    fn verify_client_cert(
        &self,
        leaf: &CertificateDer<'_>,
        intermediate: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> Result<ClientCertVerified, Error> {
        self.check_pin(leaf, intermediate)?;
        Ok(ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(CertificateError::BadSignature.into())
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.check_signature(message, cert, signature)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ED25519]
    }

    fn requires_raw_public_keys(&self) -> bool {
        true
    }
}

fn fingerprint(spki: &[u8]) -> Digest {
    Digest::try_from(format!("{:x}", Sha256::digest(spki)).as_str())
        .expect("SHA-256 encodes a Digest")
}

fn require_protocol(connection: &CommonState) -> HostResult<()> {
    if connection.alpn_protocol() == Some(ALPN) {
        Ok(())
    } else {
        Err(protocol_error())
    }
}

fn handshake_error(error: io::Error) -> HostError {
    match error
        .get_ref()
        .and_then(|error| error.downcast_ref::<Error>())
    {
        Some(
            Error::NoApplicationProtocol
            | Error::AlertReceived(AlertDescription::NoApplicationProtocol),
        ) => protocol_error(),
        _ => authentication_error(),
    }
}

fn authentication_error() -> HostError {
    HostError::new(
        "LAN_AUTHENTICATION_FAILED",
        "Could not authenticate the LAN peer",
    )
}

fn connection_error() -> HostError {
    HostError::new("LAN_CONNECTION_UNAVAILABLE", "Could not reach the LAN peer")
}

fn identity_error() -> HostError {
    HostError::new(
        "LAN_IDENTITY_INVALID",
        "LAN identity key is unavailable or invalid",
    )
}

fn protocol_error() -> HostError {
    HostError::new(
        "LAN_PROTOCOL_MISMATCH",
        "The peers do not share a supported LAN protocol version",
    )
}

#[cfg(test)]
mod tests;
