//! 错误日志与诊断预览共用的纯文本脱敏，不依赖应用状态或服务模块。

use std::sync::OnceLock;

use regex::Regex;

pub fn redact(text: &str) -> String {
    static PRIVATE_KEY: OnceLock<Regex> = OnceLock::new();
    let keys = PRIVATE_KEY.get_or_init(|| {
        Regex::new(r"(?s)-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----.*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|\z)")
            .expect("valid private key redaction pattern")
    });
    let without_keys = keys.replace_all(text, "[private key omitted]");
    static ESCAPED_SECRET: OnceLock<Regex> = OnceLock::new();
    let escaped = ESCAPED_SECRET.get_or_init(|| {
        Regex::new(r#"(?i)(\\["'](?:token|password|secret|credential|pairing[_ -]?code|api[_-]?key)\\["'][ \t]*:[ \t]*\\["'])[^\r\n]*"#)
            .expect("valid escaped secret redaction pattern")
    });
    let without_escaped = escaped.replace_all(&without_keys, "$1[redacted]");
    static URL_PATTERN: OnceLock<Regex> = OnceLock::new();
    let urls = URL_PATTERN.get_or_init(|| {
        Regex::new(r#"[a-zA-Z][a-zA-Z0-9+.-]*://[^\s<>\"']+"#).expect("valid URL redaction pattern")
    });
    let sanitized_urls = urls.replace_all(&without_escaped, |captures: &regex::Captures<'_>| {
        if let Ok(mut parsed) = url::Url::parse(&captures[0]) {
            let _ = parsed.set_username("");
            let _ = parsed.set_password(None);
            parsed.set_query(None);
            parsed.set_fragment(None);
            parsed.to_string()
        } else {
            "[url omitted]".into()
        }
    });
    static AUTHORIZATION_PATTERN: OnceLock<Regex> = OnceLock::new();
    let authorization = AUTHORIZATION_PATTERN.get_or_init(|| {
        // 未加引号的认证头按整行处理，避免只抹掉 Basic / Digest 等方案名。
        Regex::new(r#"(?i)(authorization["']?(?:\s*[:=]\s*|\s+))(?:"(?:\\[^\r\n]|[^"\\\r\n])*"?|'(?:\\[^\r\n]|[^'\\\r\n])*'?|[^\r\n]+)"#)
            .expect("valid authorization redaction pattern")
    });
    let sanitized_authorization = authorization.replace_all(&sanitized_urls, "$1[redacted]");
    static SECRET_PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = SECRET_PATTERN.get_or_init(|| {
        // 引号中的空格、转义引号与日志截断后的未闭合值都需完整脱敏。
        Regex::new(r#"(?i)(bearer\s+|(?:token|password|secret|credential|pairing[_ -]?code|api[_-]?key)["']?(?:\s*[:=]\s*|\s+))(?:"(?:\\[^\r\n]|[^"\\\r\n])*"?|'(?:\\[^\r\n]|[^'\\\r\n])*'?|[^\s&"']+)"#)
            .expect("valid secret redaction pattern")
    });
    let mut redacted = pattern
        .replace_all(&sanitized_authorization, "$1[redacted]")
        .into_owned();
    for variable in ["USERPROFILE", "HOME"] {
        if let Some(value) = std::env::var_os(variable) {
            let home = value.to_string_lossy();
            if home.len() > 3 {
                redacted = redacted
                    .replace(home.as_ref(), "[home]")
                    .replace(&home.replace('\\', "/"), "[home]");
            }
        }
    }
    redacted
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostics_remove_common_secrets_and_home_paths() {
        let text = redact("request token=abc&password=secret Authorization: Bearer xyz");
        assert!(!text.contains("abc"));
        assert!(!text.contains("xyz"));
        if let Ok(home) = std::env::var("USERPROFILE") {
            assert!(!redact(&format!("{home}/file")).contains(&home));
        }
        assert!(text.contains("[redacted]"));
        let url =
            redact("fetch https://user:pass@example.com/path?code=oauth&session=private#secret");
        assert_eq!(url, "fetch https://example.com/path");
        assert!(!url.contains("user"));
        assert!(!url.contains("oauth"));
    }

    #[test]
    fn authorization_redacts_the_full_credential_for_each_scheme() {
        for value in [
            "Authorization: Basic dXNlcjpwYXNzd29yZA==",
            "authorization=Bearer private-access-token",
            r#"Authorization: Digest username="private-user", response="private-response""#,
            r#"{"Authorization":"Basic private-credential","status":401}"#,
        ] {
            let redacted = redact(&format!("{value}\nnext log entry"));
            assert!(!redacted.contains("private"), "{redacted}");
            assert!(!redacted.contains("dXNlcjpwYXNzd29yZA=="));
            assert!(redacted.ends_with("\nnext log entry"));
        }
        assert_eq!(
            redact(r#"{"Authorization":"Basic private-credential","status":401}"#),
            r#"{"Authorization":[redacted],"status":401}"#
        );
    }

    #[test]
    fn quoted_secrets_redact_spaces_and_escaped_quotes_without_losing_other_fields() {
        for value in [
            r#"password="first secret last" status=failed"#,
            r#"secret='first secret last' status=failed"#,
            r#"api_key="first \"secret\" last" status=failed"#,
            r#"token='first \'secret\' last' status=failed"#,
            r#"password: "first secret last" status=failed"#,
        ] {
            let redacted = redact(value);
            assert!(!redacted.contains("first"), "{redacted}");
            assert!(!redacted.contains("last"), "{redacted}");
            assert!(redacted.ends_with(" status=failed"));
        }
        assert_eq!(
            redact(r#"{"password":"first secret last","status":"failed"}"#),
            r#"{"password":[redacted],"status":"failed"}"#
        );
        for value in [
            r#"password="first secret last"#,
            "secret='first secret last",
            r#"Authorization: "Basic private-credential"#,
        ] {
            let redacted = redact(&format!("{value}\nnext log entry"));
            assert!(!redacted.contains("first"), "{redacted}");
            assert!(!redacted.contains("last"), "{redacted}");
            assert!(!redacted.contains("private"), "{redacted}");
            assert!(redacted.ends_with("\nnext log entry"));
        }
    }

    #[test]
    fn removes_private_key_blocks_and_escaped_credentials() {
        let input = r#"nested {\"credential\":\"fixture-secret\"}"#;
        assert!(!redact(input).contains("fixture-secret"));
        let input = "prefix\n-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-key\n-----END OPENSSH PRIVATE KEY-----\nsuffix";
        assert_eq!(redact(input), "prefix\n[private key omitted]\nsuffix");
        assert!(!redact("-----BEGIN PRIVATE KEY-----\nclipped-key").contains("clipped-key"));
    }
}
