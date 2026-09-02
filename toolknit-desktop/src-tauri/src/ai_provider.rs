const AI_PROVIDER_MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const AI_PROVIDER_MAX_MESSAGES: usize = 12;
const AI_PROVIDER_MAX_MESSAGE_CHARS: usize = 50_000;
const AI_PROVIDER_MAX_TOKENS: u32 = 16_384;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub(super) struct AiProviderNativeMessage {
    role: String,
    content: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AiProviderNativeRequest {
    url: String,
    api_key: String,
    model: String,
    messages: Vec<AiProviderNativeMessage>,
    max_tokens: Option<u32>,
    #[serde(default)]
    allow_private_http: bool,
}

#[derive(serde::Serialize)]
pub(super) struct AiProviderNativeResponse {
    content: String,
}

fn is_private_ipv4_address(value: std::net::Ipv4Addr) -> bool {
    let [first, second, _, _] = value.octets();
    first == 10 || (first == 172 && (16..=31).contains(&second)) || (first == 192 && second == 168)
}

fn is_private_ipv6_address(value: std::net::Ipv6Addr) -> bool {
    value.octets()[0] & 0xfe == 0xfc
}

fn validate_http_endpoint(raw_url: &str, allow_private_http: bool) -> Result<url::Url, String> {
    if raw_url.len() > 2048 {
        return Err("ai-provider:invalid_config".to_string());
    }
    let endpoint =
        url::Url::parse(raw_url).map_err(|_| "ai-provider:invalid_config".to_string())?;
    if endpoint.scheme() != "http"
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.fragment().is_some()
    {
        return Err("ai-provider:invalid_config".to_string());
    }
    let is_loopback = match endpoint.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    };
    let is_private = match endpoint.host() {
        Some(url::Host::Ipv4(address)) => is_private_ipv4_address(address),
        Some(url::Host::Ipv6(address)) => is_private_ipv6_address(address),
        _ => false,
    };
    if is_loopback || (allow_private_http && is_private) {
        Ok(endpoint)
    } else {
        Err("ai-provider:invalid_config".to_string())
    }
}

fn validate_native_request(request: &AiProviderNativeRequest) -> Result<url::Url, String> {
    let endpoint = validate_http_endpoint(&request.url, request.allow_private_http)?;
    let api_key = request.api_key.trim();
    let model = request.model.trim();
    if api_key.is_empty()
        || api_key.chars().count() > 8192
        || api_key.chars().any(char::is_control)
        || model.is_empty()
        || model.chars().count() > 256
        || request.messages.is_empty()
        || request.messages.len() > AI_PROVIDER_MAX_MESSAGES
        || request
            .max_tokens
            .is_some_and(|value| value == 0 || value > AI_PROVIDER_MAX_TOKENS)
    {
        return Err("ai-provider:invalid_request".to_string());
    }
    for message in &request.messages {
        if !matches!(message.role.as_str(), "system" | "user" | "assistant")
            || message.content.chars().count() > AI_PROVIDER_MAX_MESSAGE_CHARS
        {
            return Err("ai-provider:invalid_request".to_string());
        }
    }
    Ok(endpoint)
}

async fn request_impl(
    request: AiProviderNativeRequest,
) -> Result<AiProviderNativeResponse, String> {
    let endpoint = validate_native_request(&request)?;
    let mut body = serde_json::json!({
        "model": request.model.trim(),
        "messages": request.messages,
        "temperature": 0.7,
        "stream": false,
    });
    if let Some(max_tokens) = request.max_tokens {
        body["max_tokens"] = serde_json::json!(max_tokens);
    }
    let encoded_body =
        serde_json::to_vec(&body).map_err(|_| "ai-provider:invalid_request".to_string())?;
    if encoded_body.len() > AI_PROVIDER_MAX_RESPONSE_BYTES {
        return Err("ai-provider:invalid_request".to_string());
    }

    let client = reqwest::Client::builder()
        .user_agent("ToolKnit/2.3.1 local-ai-provider")
        .connect_timeout(std::time::Duration::from_secs(8))
        .timeout(std::time::Duration::from_secs(45))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .map_err(|_| "ai-provider:network_error".to_string())?;
    let mut response = client
        .post(endpoint)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .bearer_auth(request.api_key.trim())
        .body(encoded_body)
        .send()
        .await
        .map_err(|_| "ai-provider:network_error".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "ai-provider:http_error:{}",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|value| value > AI_PROVIDER_MAX_RESPONSE_BYTES as u64)
    {
        return Err("ai-provider:response_too_large".to_string());
    }

    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "ai-provider:invalid_response".to_string())?
    {
        if bytes.len().saturating_add(chunk.len()) > AI_PROVIDER_MAX_RESPONSE_BYTES {
            return Err("ai-provider:response_too_large".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    let payload: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "ai-provider:invalid_response".to_string())?;
    let content = payload
        .get("choices")
        .and_then(|value| value.get(0))
        .and_then(|value| value.get("message"))
        .and_then(|value| value.get("content"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    Ok(AiProviderNativeResponse { content })
}

#[tauri::command]
pub async fn request_private_ai_completion(
    request: AiProviderNativeRequest,
) -> Result<AiProviderNativeResponse, String> {
    request_impl(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_http_requires_explicit_opt_in() {
        assert!(
            validate_http_endpoint("http://127.0.0.1:11434/v1/chat/completions", false).is_ok()
        );
        assert!(
            validate_http_endpoint("http://172.23.20.253:3001/v1/chat/completions", false).is_err()
        );
        assert!(
            validate_http_endpoint("http://172.23.20.253:3001/v1/chat/completions", true).is_ok()
        );
        assert!(validate_http_endpoint("http://192.168.1.20/v1/chat/completions", true).is_ok());
        assert!(validate_http_endpoint("http://8.8.8.8/v1/chat/completions", true).is_err());
        assert!(validate_http_endpoint("http://example.com/v1/chat/completions", true).is_err());
        assert!(
            validate_http_endpoint("https://api.example.com/v1/chat/completions", true).is_err()
        );
    }

    #[tokio::test]
    async fn loopback_native_request_returns_only_completion_content() {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request_bytes = [0_u8; 8192];
            let read = stream.read(&mut request_bytes).unwrap();
            let request_text = String::from_utf8_lossy(&request_bytes[..read]);
            assert!(request_text
                .to_ascii_lowercase()
                .contains("authorization: bearer test-key"));
            assert!(request_text.contains("POST /v1/chat/completions HTTP/1.1"));
            let body = r#"{"choices":[{"message":{"content":"native response"}}]}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });
        let result = request_impl(AiProviderNativeRequest {
            url: format!("http://{}/v1/chat/completions", address),
            api_key: "test-key".to_string(),
            model: "test-model".to_string(),
            messages: vec![AiProviderNativeMessage {
                role: "user".to_string(),
                content: "Hello".to_string(),
            }],
            max_tokens: Some(100),
            allow_private_http: false,
        })
        .await
        .unwrap();
        server.join().unwrap();
        assert_eq!(result.content, "native response");
    }
}
