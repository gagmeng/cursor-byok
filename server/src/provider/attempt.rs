//! Sends one Provider HTTP attempt without applying retry policy.

use tokio_util::sync::CancellationToken;

use crate::{Error, Result};

use super::CallRecorder;

#[derive(Debug)]
pub(crate) enum Attempt {
    Response(reqwest::Response),
    Cancelled,
}

pub(crate) async fn send_once<F>(
    label: &str,
    build: F,
    cancellation: &CancellationToken,
    recorder: Option<&CallRecorder>,
) -> Result<Attempt>
where
    F: FnOnce() -> reqwest::RequestBuilder,
{
    let response = tokio::select! {
        _ = cancellation.cancelled() => return Ok(Attempt::Cancelled),
        response = build().send() => response,
    }?;
    if let Some(recorder) = recorder {
        recorder
            .response_headers(response.status().as_u16())
            .await?;
    }
    if response.status().is_success() {
        return Ok(Attempt::Response(response));
    }
    let status = response.status();
    let retry_after = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_retry_after);
    let bytes = tokio::select! {
        _ = cancellation.cancelled() => return Ok(Attempt::Cancelled),
        bytes = response.bytes() => bytes,
    }?;
    let retry_after = retry_after
        .map(|seconds| format!("retry_after_seconds={seconds}; "))
        .unwrap_or_default();
    Err(Error::Provider(format!(
        "{retry_after}{label} {status}: {}",
        String::from_utf8_lossy(&bytes)
    )))
}

fn parse_retry_after(value: &str) -> Option<u64> {
    let value = value.trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(seconds);
    }
    let date = chrono::DateTime::parse_from_rfc2822(value).ok()?;
    let wait = date.timestamp() - chrono::Utc::now().timestamp();
    Some(wait.max(0) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn server(response: &'static [u8]) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await;
            socket.write_all(response).await.unwrap();
        });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn non_success_status_is_one_failed_attempt() {
        let url =
            server(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 4\r\n\r\ndown").await;
        let client = reqwest::Client::new();
        let error = send_once("test", || client.get(&url), &CancellationToken::new(), None)
            .await
            .unwrap_err();
        assert!(
            matches!(error, Error::Provider(message) if message.contains("503") && message.contains("down"))
        );
    }

    #[tokio::test]
    async fn rate_limit_keeps_retry_after_on_the_error() {
        let url = server(
            b"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 3\r\nContent-Length: 4\r\n\r\nwait",
        )
        .await;
        let client = reqwest::Client::new();
        let error = send_once("test", || client.get(&url), &CancellationToken::new(), None)
            .await
            .unwrap_err();
        let Error::Provider(message) = error else {
            panic!("expected provider error");
        };
        assert!(message.contains("retry_after_seconds=3"), "{message}");
        assert!(message.contains("429"), "{message}");
    }

    #[tokio::test]
    async fn response_body_transport_failure_is_one_failed_attempt() {
        let url =
            server(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 100\r\n\r\nshort").await;
        let client = reqwest::Client::new();
        let error = send_once("test", || client.get(&url), &CancellationToken::new(), None)
            .await
            .unwrap_err();
        assert!(matches!(error, Error::Http(_)));
    }

    #[tokio::test]
    async fn request_transport_failure_is_one_failed_attempt() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let url = format!("http://{address}");
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let error = send_once("test", || client.get(&url), &CancellationToken::new(), None)
            .await
            .unwrap_err();
        assert!(
            matches!(error, Error::Http(_)),
            "connection failure stays one HTTP attempt: {error}"
        );
    }
}
