/// Validate user-provided external links before handing them to the OS opener.
pub fn validate_external_url(value: &str) -> Result<url::Url, String> {
    if value.len() > 2_048 || value.chars().any(char::is_control) {
        return Err("Invalid URL".to_string());
    }
    let parsed = url::Url::parse(value).map_err(|_| "Invalid URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Unsupported URL".to_string());
    }
    Ok(parsed)
}

/// Keep navigation inside the app shell and the local development origin.
pub fn allow_webview_navigation(url: &url::Url) -> bool {
    match (url.scheme(), url.host_str()) {
        ("tauri", Some("localhost")) => true,
        ("http" | "https", Some("tauri.localhost")) => true,
        ("http", Some("localhost" | "127.0.0.1")) if cfg!(debug_assertions) => {
            url.port_or_known_default() == Some(1420)
        }
        _ => false,
    }
}
