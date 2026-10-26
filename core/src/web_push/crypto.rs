//! A push message's encryption (RFC 8291: one "aes128gcm" record of
//! RFC 8188) and the VAPID token that names this Core to a push service
//! (RFC 8292). Every message has a key pair and salt of its own; the
//! device's keys come from its subscription.
use anyhow::{anyhow, bail, Result};
use base64::{
    engine::{general_purpose::{GeneralPurpose, GeneralPurposeConfig, URL_SAFE_NO_PAD}, DecodePaddingMode},
    Engine,
};
use ring::{
    aead, agreement, hkdf,
    rand::{SecureRandom, SystemRandom},
    signature::{self, EcdsaKeyPair, KeyPair},
};

const RECORD_SIZE: u32 = 4096;
/// The longest message one record holds: the record less the AEAD tag and
/// the padding delimiter.
pub(super) const MAX_PLAINTEXT: usize = RECORD_SIZE as usize - 16 - 1;
/// A browser gives keys as base64url, with or without padding.
const LENIENT: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::URL_SAFE,
    GeneralPurposeConfig::new().with_encode_padding(false).with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

pub(super) fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub(super) fn unb64(text: &str) -> Option<Vec<u8>> {
    LENIENT.decode(text.trim()).ok()
}

struct Len(usize);
impl hkdf::KeyType for Len {
    fn len(&self) -> usize {
        self.0
    }
}

fn expand(prk: &hkdf::Prk, info: &[&[u8]], out: &mut [u8]) -> Result<()> {
    prk.expand(info, Len(out.len())).and_then(|okm| okm.fill(out)).map_err(|_| anyhow!("HKDF could not expand a key"))
}

/// The content key and nonce of one message (RFC 8291 §3.3–3.4).
fn derive(ecdh_secret: &[u8], auth: &[u8], ua_public: &[u8], as_public: &[u8], salt: &[u8]) -> Result<([u8; 16], [u8; 12])> {
    let prk_key = hkdf::Salt::new(hkdf::HKDF_SHA256, auth).extract(ecdh_secret);
    let mut ikm = [0; 32];
    expand(&prk_key, &[b"WebPush: info\0", ua_public, as_public], &mut ikm)?;
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, salt).extract(&ikm);
    let (mut cek, mut nonce) = ([0; 16], [0; 12]);
    expand(&prk, &[b"Content-Encoding: aes128gcm\0"], &mut cek)?;
    expand(&prk, &[b"Content-Encoding: nonce\0"], &mut nonce)?;
    Ok((cek, nonce))
}

/// The one record: the message, its padding delimiter (0x02, the last
/// record) and the tag.
fn seal(cek: &[u8; 16], nonce: [u8; 12], plaintext: &[u8]) -> Result<Vec<u8>> {
    let key = aead::UnboundKey::new(&aead::AES_128_GCM, cek).map_err(|_| anyhow!("AES-128-GCM refused the key"))?;
    let mut record = Vec::with_capacity(plaintext.len() + 17);
    record.extend_from_slice(plaintext);
    record.push(2);
    aead::LessSafeKey::new(key)
        .seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::empty(), &mut record)
        .map_err(|_| anyhow!("AES-128-GCM could not seal the message"))?;
    Ok(record)
}

/// The content coding header: salt, record size and the sender's key.
fn header(salt: &[u8; 16], as_public: &[u8]) -> Vec<u8> {
    let mut header = Vec::with_capacity(21 + as_public.len());
    header.extend_from_slice(salt);
    header.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    header.push(as_public.len() as u8);
    header.extend_from_slice(as_public);
    header
}

/// The body of one push message to a device with these subscription keys.
pub(super) fn encrypt(ua_public: &[u8], auth: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    if plaintext.len() > MAX_PLAINTEXT {
        bail!("A push message holds at most {MAX_PLAINTEXT} bytes");
    }
    let rng = SystemRandom::new();
    let mut salt = [0; 16];
    rng.fill(&mut salt).map_err(|_| anyhow!("No random salt"))?;
    let private = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).map_err(|_| anyhow!("No key pair"))?;
    let as_public = private.compute_public_key().map_err(|_| anyhow!("No public key"))?.as_ref().to_vec();
    let device = agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, ua_public);
    let (cek, nonce) = agreement::agree_ephemeral(private, &device, |secret| derive(secret, auth, ua_public, &as_public, &salt))
        .map_err(|_| anyhow!("The device's push key is not a P-256 public key"))??;
    let mut body = header(&salt, &as_public);
    body.extend(seal(&cek, nonce, plaintext)?);
    Ok(body)
}

/// Whether a subscription's `p256dh` is a key messages can be encrypted to.
pub(super) fn device_key_usable(ua_public: &[u8]) -> bool {
    let rng = SystemRandom::new();
    let Ok(private) = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng) else { return false };
    agreement::agree_ephemeral(private, &agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, ua_public), |_| ()).is_ok()
}

/// This Core's VAPID key (ES256): its public half is the
/// `applicationServerKey` a page subscribes with.
pub(super) struct Vapid(EcdsaKeyPair);

impl Vapid {
    /// A new key, as PKCS#8.
    pub fn generate() -> Result<Vec<u8>> {
        let rng = SystemRandom::new();
        Ok(EcdsaKeyPair::generate_pkcs8(&signature::ECDSA_P256_SHA256_FIXED_SIGNING, &rng)
            .map_err(|_| anyhow!("No VAPID key"))?
            .as_ref()
            .to_vec())
    }

    pub fn from_pkcs8(pkcs8: &[u8]) -> Result<Self> {
        let rng = SystemRandom::new();
        EcdsaKeyPair::from_pkcs8(&signature::ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8, &rng)
            .map(Self)
            .map_err(|error| anyhow!("The saved VAPID key is not usable: {error}"))
    }

    /// The uncompressed P-256 point (65 bytes).
    pub fn public_key(&self) -> &[u8] {
        self.0.public_key().as_ref()
    }

    /// A token for one push service: `aud` is its origin, `sub` names this
    /// Core's own entry, `exp` is in Unix seconds.
    pub fn token(&self, aud: &str, sub: &str, exp: i64) -> Result<String> {
        let header = b64(br#"{"typ":"JWT","alg":"ES256"}"#);
        let claims = b64(&serde_json::to_vec(&serde_json::json!({"aud":aud,"exp":exp,"sub":sub}))?);
        let input = format!("{header}.{claims}");
        let signed = self.0.sign(&SystemRandom::new(), input.as_bytes()).map_err(|_| anyhow!("The VAPID token was not signed"))?;
        Ok(format!("{input}.{}", b64(signed.as_ref())))
    }

    /// The `Authorization` value for a token (RFC 8292 §3).
    pub fn authorization(&self, token: &str) -> String {
        format!("vapid t={token}, k={}", b64(self.public_key()))
    }
}

/// What a device does with a message (tests): its own key agreed with the
/// sender's from the header, the same derivation, then the record opened.
#[cfg(test)]
pub(super) fn open(device: agreement::EphemeralPrivateKey, ua_public: &[u8], auth: &[u8], body: &[u8]) -> Vec<u8> {
    let salt = &body[..16];
    assert_eq!(u32::from_be_bytes(body[16..20].try_into().unwrap()), RECORD_SIZE);
    let id_len = body[20] as usize;
    let as_public = &body[21..21 + id_len];
    let peer = agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, as_public);
    let (cek, nonce) = agreement::agree_ephemeral(device, &peer, |secret| derive(secret, auth, ua_public, as_public, salt)).unwrap().unwrap();
    let key = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_128_GCM, &cek).unwrap());
    let mut record = body[21 + id_len..].to_vec();
    let opened = key.open_in_place(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::empty(), &mut record).unwrap();
    assert_eq!(opened.last(), Some(&2), "one record, the last");
    opened[..opened.len() - 1].to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(text: &str) -> Vec<u8> {
        unb64(&text.split_whitespace().collect::<String>()).unwrap()
    }

    // RFC 8291 Appendix A, a published example: no key here is anyone's.
    const PLAINTEXT: &str = "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24";
    const AS_PUBLIC: &str = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
    const AS_PRIVATE: &str = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
    const UA_PUBLIC: &str = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV- JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const SALT: &str = "DGv6ra1nlYgDCS1FRnbzlw";
    const AUTH: &str = "BTBZMqHH6r4Tts7J_aSIgg";
    const ECDH_SECRET: &str = "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs";
    const CEK: &str = "oIhVW04MRdy2XN9CiKLxTg";
    const NONCE: &str = "4h_95klXJ5E_qnoN";
    const HEADER: &str = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8";
    const CIPHERTEXT: &str = "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ";

    #[test]
    fn rfc8291_example_gives_its_key_nonce_header_and_record() {
        let (cek, nonce) = derive(&bytes(ECDH_SECRET), &bytes(AUTH), &bytes(UA_PUBLIC), &bytes(AS_PUBLIC), &bytes(SALT)).unwrap();
        assert_eq!(cek.to_vec(), bytes(CEK));
        assert_eq!(nonce.to_vec(), bytes(NONCE));
        let salt: [u8; 16] = bytes(SALT).try_into().unwrap();
        assert_eq!(header(&salt, &bytes(AS_PUBLIC)), bytes(HEADER));
        assert_eq!(seal(&cek, nonce, &bytes(PLAINTEXT)).unwrap(), bytes(CIPHERTEXT));
    }

    #[test]
    fn a_device_opens_what_is_sent_to_it_and_each_message_has_its_own_key() {
        let rng = SystemRandom::new();
        let auth = bytes(AUTH);
        let message = br#"{"v":1,"kind":"finished"}"#;
        let mut senders = Vec::new();
        for _ in 0..2 {
            let device = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).unwrap();
            let ua_public = device.compute_public_key().unwrap().as_ref().to_vec();
            assert!(device_key_usable(&ua_public));
            let body = encrypt(&ua_public, &auth, message).unwrap();
            assert_eq!(open(device, &ua_public, &auth, &body), message);
            senders.push(body[..86].to_vec());
        }
        assert_ne!(senders[0], senders[1], "a fresh salt and key pair per message");
    }

    #[test]
    fn keys_that_are_not_p256_points_and_long_messages_are_refused() {
        assert!(!device_key_usable(&[4; 65]));
        assert!(!device_key_usable(&bytes(UA_PUBLIC)[..33]));
        assert!(encrypt(&[4; 65], &bytes(AUTH), b"x").is_err());
        assert!(encrypt(&bytes(UA_PUBLIC), &bytes(AUTH), &vec![b'x'; MAX_PLAINTEXT + 1]).is_err());
        assert!(encrypt(&bytes(UA_PUBLIC), &bytes(AUTH), &vec![b'x'; MAX_PLAINTEXT]).is_ok());
    }

    #[test]
    fn a_vapid_token_verifies_with_the_key_it_names() {
        // The published RFC 8291 sender key, as a synthetic VAPID key.
        let rng = SystemRandom::new();
        let pair = EcdsaKeyPair::from_private_key_and_public_key(&signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            &bytes(AS_PRIVATE), &bytes(AS_PUBLIC), &rng).unwrap();
        let vapid = Vapid(pair);
        let token = vapid.token("https://web.push.apple.com", "https://core.example.ts.net:8444", 1_800_000_000).unwrap();
        let (input, signed) = token.rsplit_once('.').unwrap();
        signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, bytes(AS_PUBLIC))
            .verify(input.as_bytes(), &bytes(signed))
            .unwrap();
        let (header, claims) = input.split_once('.').unwrap();
        assert_eq!(bytes(header), br#"{"typ":"JWT","alg":"ES256"}"#);
        let claims: serde_json::Value = serde_json::from_slice(&bytes(claims)).unwrap();
        assert_eq!(claims, serde_json::json!({"aud":"https://web.push.apple.com","exp":1_800_000_000,"sub":"https://core.example.ts.net:8444"}));
        assert_eq!(vapid.authorization(&token), format!("vapid t={token}, k={}", AS_PUBLIC.replace(' ', "")));
        // A generated key reads back as the same key.
        let pkcs8 = Vapid::generate().unwrap();
        assert_eq!(Vapid::from_pkcs8(&pkcs8).unwrap().public_key(), Vapid::from_pkcs8(&pkcs8).unwrap().public_key());
        assert_eq!(Vapid::from_pkcs8(&pkcs8).unwrap().public_key().len(), 65);
        assert!(Vapid::from_pkcs8(b"not a key").is_err());
    }
}
