//! Zugangsdaten für den Speicher (Entscheidung D-T3, ADR-0028 der Spezifikation).
//!
//! * Das Geheimnis kommt **nur** aus einer Datei (`OMP_TAMS_TOKEN_FILE`, Rechte höchstens 0600) oder der Umgebung
//!   (`OMP_TAMS_TOKEN`). Nie aus Parametern, Datenbank oder Workflow-Export.
//! * Ein [`Secret`] zeigt sich in `Debug` nie. Fehlermeldungen enthalten kein Geheimnis ([`redact_url`]).
//! * Arten der Anmeldung nach Spezifikation 8.2: `bearer`, `basic`, `url_token` (Query `access_token`), dazu `none`.

use std::fmt;
use std::path::Path;

pub const ENV_TOKEN_FILE: &str = "OMP_TAMS_TOKEN_FILE";
pub const ENV_TOKEN: &str = "OMP_TAMS_TOKEN";
/// Name des Query-Parameters bei `url_token` (Sicherheitsschema `url_token_auth`).
pub const URL_TOKEN_PARAM: &str = "access_token";

/// Ein Geheimnis. Kein `Display`, `Debug` zeigt nur die Länge.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Result<Secret, AuthError> {
        let v = value.into().trim().to_string();
        if v.is_empty() {
            return Err(AuthError::Empty);
        }
        if v.chars().any(|c| c.is_control()) {
            return Err(AuthError::BadCharacter);
        }
        Ok(Secret(v))
    }
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Secret(<{} Zeichen>)", self.0.chars().count())
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum AuthError {
    Empty,
    BadCharacter,
    /// Datei ist für Gruppe/Andere lesbar (Rechte schärfer als 0600 verlangt).
    FilePermissions(String),
    FileUnreadable(String),
}

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => write!(f, "Zugangsdaten sind leer"),
            Self::BadCharacter => write!(f, "Zugangsdaten enthalten Steuerzeichen"),
            Self::FilePermissions(p) => write!(f, "Geheimnis-Datei {p} ist für Gruppe/Andere zugänglich (erlaubt: höchstens 0600)"),
            Self::FileUnreadable(p) => write!(f, "Geheimnis-Datei {p} nicht lesbar"),
        }
    }
}
impl std::error::Error for AuthError {}

/// Liest ein Geheimnis aus einer Datei; lehnt sie ab, wenn Gruppe oder Andere Rechte haben.
pub fn secret_from_file(path: &Path) -> Result<Secret, AuthError> {
    let shown = path.display().to_string();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let meta = std::fs::metadata(path).map_err(|_| AuthError::FileUnreadable(shown.clone()))?;
        if meta.permissions().mode() & 0o077 != 0 {
            return Err(AuthError::FilePermissions(shown));
        }
    }
    let text = std::fs::read_to_string(path).map_err(|_| AuthError::FileUnreadable(shown))?;
    Secret::new(text)
}

/// Datei (`OMP_TAMS_TOKEN_FILE`) vor Umgebung (`OMP_TAMS_TOKEN`); `Ok(None)`, wenn beides fehlt.
pub fn secret_from_env() -> Result<Option<Secret>, AuthError> {
    secret_from_sources(std::env::var(ENV_TOKEN_FILE).ok(), std::env::var(ENV_TOKEN).ok())
}

/// Wie [`secret_from_env`], aber mit übergebenen Werten (testbar ohne Prozessumgebung).
pub fn secret_from_sources(file: Option<String>, token: Option<String>) -> Result<Option<Secret>, AuthError> {
    if let Some(f) = file.filter(|f| !f.trim().is_empty()) {
        return secret_from_file(Path::new(f.trim())).map(Some);
    }
    match token.filter(|t| !t.trim().is_empty()) {
        Some(t) => Secret::new(t).map(Some),
        None => Ok(None),
    }
}

/// Art der Anmeldung.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Auth {
    None,
    Bearer(Secret),
    /// Benutzername im Klartext (kein Geheimnis), Passwort als Geheimnis.
    Basic { user: String, password: Secret },
    /// Token im Query-Parameter `access_token`.
    UrlToken(Secret),
}

impl Auth {
    /// Aus den gewöhnlichen Parametern (`kind`, `user`) und dem Geheimnis. `kind`: `none|bearer|basic|url_token`.
    pub fn from_parts(kind: &str, user: Option<&str>, secret: Option<Secret>) -> Result<Auth, String> {
        let need = |s: Option<Secret>| s.ok_or_else(|| format!("Anmeldung {kind:?} braucht ein Geheimnis ({ENV_TOKEN_FILE} oder {ENV_TOKEN})"));
        match kind.trim().to_ascii_lowercase().as_str() {
            "" | "none" => Ok(Auth::None),
            "bearer" => Ok(Auth::Bearer(need(secret)?)),
            "url_token" => Ok(Auth::UrlToken(need(secret)?)),
            "basic" => {
                let user = user.map(str::trim).filter(|u| !u.is_empty()).ok_or("Anmeldung \"basic\" braucht einen Benutzernamen")?;
                if user.contains(':') {
                    return Err("Benutzername darf keinen Doppelpunkt enthalten (HTTP Basic)".into());
                }
                Ok(Auth::Basic { user: user.to_string(), password: need(secret)? })
            }
            other => Err(format!("unbekannte Art der Anmeldung {other:?} (erlaubt: none, bearer, basic, url_token)")),
        }
    }

    /// Wert des `Authorization`-Headers (nur bei `bearer`/`basic`).
    pub(crate) fn header(&self) -> Option<String> {
        match self {
            Auth::Bearer(s) => Some(format!("Bearer {}", s.expose())),
            Auth::Basic { user, password } => Some(format!("Basic {}", base64(format!("{user}:{}", password.expose()).as_bytes()))),
            _ => None,
        }
    }

    pub(crate) fn url_token(&self) -> Option<&str> {
        match self {
            Auth::UrlToken(s) => Some(s.expose()),
            _ => None,
        }
    }
}

/// Maskiert Token in Adressen und Meldungen: `access_token=…` → `access_token=***`.
pub fn redact_url(text: &str) -> String {
    let key = format!("{URL_TOKEN_PARAM}=");
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find(&key) {
        out.push_str(&rest[..i + key.len()]);
        out.push_str("***");
        let after = &rest[i + key.len()..];
        let end = after.find(['&', '#', '"', '\'', ' ', ')', '>']).unwrap_or(after.len());
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

/// Base64 (RFC 4648, mit Auffüllung) — nur für HTTP Basic; kleine Eigenlösung statt einer neuen Abhängigkeit.
fn base64(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc4648_vectors() {
        for (i, o) in [("", ""), ("f", "Zg=="), ("fo", "Zm8="), ("foo", "Zm9v"), ("foob", "Zm9vYg=="), ("fooba", "Zm9vYmE="), ("foobar", "Zm9vYmFy")] {
            assert_eq!(base64(i.as_bytes()), o);
        }
    }

    #[test]
    fn basic_header_is_user_colon_password() {
        let a = Auth::from_parts("basic", Some("aladdin"), Some(Secret::new("open sesame").unwrap())).unwrap();
        // Beispiel aus RFC 7617
        assert_eq!(a.header().unwrap(), "Basic YWxhZGRpbjpvcGVuIHNlc2FtZQ==");
    }

    #[test]
    fn secret_never_shows_in_debug() {
        let s = Secret::new("super-geheim-123").unwrap();
        assert!(!format!("{s:?}").contains("geheim"));
        let a = Auth::Bearer(s.clone());
        assert!(!format!("{a:?}").contains("geheim"));
        let b = Auth::Basic { user: "u".into(), password: s };
        assert!(!format!("{b:?}").contains("geheim"));
    }

    #[test]
    fn rejects_empty_and_control_characters() {
        assert_eq!(Secret::new("  \n"), Err(AuthError::Empty));
        assert_eq!(Secret::new("ab\u{0}c"), Err(AuthError::BadCharacter));
        // abschließender Zeilenumbruch aus Dateien wird entfernt
        assert_eq!(Secret::new("tok\n").unwrap().expose(), "tok");
    }

    #[test]
    fn auth_kinds_need_what_they_need() {
        let s = || Some(Secret::new("t").unwrap());
        assert_eq!(Auth::from_parts("none", None, None), Ok(Auth::None));
        assert!(Auth::from_parts("bearer", None, None).is_err());
        assert!(Auth::from_parts("basic", None, s()).is_err());
        assert!(Auth::from_parts("basic", Some("a:b"), s()).is_err());
        assert!(Auth::from_parts("url_token", None, None).is_err());
        assert!(Auth::from_parts("oauth", None, s()).is_err());
        assert!(matches!(Auth::from_parts("BEARER", None, s()), Ok(Auth::Bearer(_))));
    }

    #[test]
    fn redaction() {
        assert_eq!(redact_url("https://h/x?access_token=abc123&a=1"), "https://h/x?access_token=***&a=1");
        assert_eq!(redact_url("https://h/x?a=1&access_token=abc123"), "https://h/x?a=1&access_token=***");
        assert_eq!(redact_url("GET https://h/?access_token=a&access_token=b failed"), "GET https://h/?access_token=***&access_token=*** failed");
        assert_eq!(redact_url("ohne token"), "ohne token");
    }

    #[cfg(unix)]
    #[test]
    fn secret_file_permissions_are_enforced() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("omp-tams-auth-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("token");
        std::fs::write(&f, "tok-1\n").unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(secret_from_file(&f), Err(AuthError::FilePermissions(_))));
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(secret_from_file(&f).unwrap().expose(), "tok-1");
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o400)).unwrap();
        assert!(secret_from_file(&f).is_ok());
        // Datei hat Vorrang vor der Umgebung
        let s = secret_from_sources(Some(f.display().to_string()), Some("env-token".into())).unwrap().unwrap();
        assert_eq!(s.expose(), "tok-1");
        let s = secret_from_sources(None, Some("env-token".into())).unwrap().unwrap();
        assert_eq!(s.expose(), "env-token");
        assert_eq!(secret_from_sources(None, None), Ok(None));
        assert!(matches!(secret_from_file(&dir.join("fehlt")), Err(AuthError::FileUnreadable(_))));
        std::fs::remove_dir_all(&dir).ok();
    }
}
