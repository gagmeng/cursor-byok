//! Restricts management HTTP requests to a local same-origin session.
use axum::{
    body::Body,
    extract::State,
    http::{header, Request, Response, StatusCode},
    middleware::Next,
    Router,
};

#[derive(Clone)]
pub(crate) struct ManagementSession(String);

impl Default for ManagementSession {
    fn default() -> Self {
        Self(uuid::Uuid::new_v4().to_string())
    }
}

pub(crate) fn protect(router: Router, session: ManagementSession) -> Router {
    router.layer(axum::middleware::from_fn_with_state(session, authorize))
}

async fn authorize(
    State(session): State<ManagementSession>,
    request: Request<Body>,
    next: Next,
) -> Response<Body> {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    let local = host
        .and_then(|host| url::Url::parse(&format!("http://{host}")).ok())
        .is_some_and(|url| {
            url.username().is_empty()
                && url.password().is_none()
                && url.path() == "/"
                && match url.host() {
                    Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
                    Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
                    _ => false,
                }
        });
    let origin_allowed = request.headers().get(header::ORIGIN).is_none_or(|value| {
        value
            .to_str()
            .ok()
            .zip(host)
            .is_some_and(|(origin, host)| origin == format!("http://{host}"))
    });
    let fetch_allowed = request
        .headers()
        .get("sec-fetch-site")
        .is_none_or(|value| value == "same-origin" || value == "none");
    if !local || !origin_allowed || !fetch_allowed {
        return denied(StatusCode::FORBIDDEN);
    }
    if request.uri().path() == "/__byok-api__/api/session" {
        if request.method() != axum::http::Method::GET
            || request
                .headers()
                .get("x-cursor-byok-session")
                .is_none_or(|value| value != "1")
        {
            return denied(StatusCode::UNAUTHORIZED);
        }
        return Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header(
                header::SET_COOKIE,
                format!(
                    "cursor_byok_session={}; HttpOnly; SameSite=Strict; Path=/__byok-api__/",
                    session.0
                ),
            )
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::empty())
            .expect("management session response");
    }
    let authenticated = request
        .headers()
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|cookie| {
            cookie
                .split(';')
                .any(|part| part.trim() == format!("cursor_byok_session={}", session.0))
        });
    if !authenticated {
        return denied(StatusCode::UNAUTHORIZED);
    }
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

fn denied(status: StatusCode) -> Response<Body> {
    let mut response = Response::builder().status(status);
    if status == StatusCode::UNAUTHORIZED {
        response = response.header("x-cursor-byok-session", "required");
    }
    response
        .body(Body::from(
            "management requests require a local same-origin session",
        ))
        .expect("management access response")
}
