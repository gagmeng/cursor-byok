//! Defines retry policy for one logical model call.

use std::time::Duration;

use super::ModelCycleFailure;

pub(super) const MAX_MODEL_RETRIES: u32 = 8;
pub(super) const MODEL_RETRY_DELAY: Duration = Duration::from_secs(5);

pub(super) fn should_retry(failure: &ModelCycleFailure, retries: u32) -> bool {
    failure.retryable && retries < MAX_MODEL_RETRIES
}

/// Uses Retry-After when the provider sent one. A wait longer than the
/// remaining request budget is not started.
pub(super) fn retry_wait(
    message: &str,
    default: Duration,
    remaining: Duration,
) -> Option<Duration> {
    if remaining.is_zero() {
        return None;
    }
    let requested = message
        .split_whitespace()
        .find_map(|token| {
            token
                .trim_end_matches(';')
                .strip_prefix("retry_after_seconds=")
                .and_then(|value| value.parse::<u64>().ok())
        })
        .map(Duration::from_secs)
        .unwrap_or(default);
    (requested <= remaining).then_some(requested)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::{ModelCycleFailure, RunFailure};
    use std::time::Duration;

    fn failure(retryable: bool) -> ModelCycleFailure {
        ModelCycleFailure {
            failure: RunFailure::Provider("failed".into()),
            partial_text: String::new(),
            partial_reasoning: String::new(),
            usage: None,
            retryable,
            emitted_tool: false,
            terminal: false,
        }
    }

    #[test]
    fn retry_after_is_used_until_the_budget_runs_out() {
        assert_eq!(
            retry_wait(
                "retry_after_seconds=4; provider 429: wait",
                Duration::from_secs(5),
                Duration::from_secs(10)
            ),
            Some(Duration::from_secs(4))
        );
        assert_eq!(
            retry_wait(
                "retry_after_seconds=9; provider 429: wait",
                Duration::from_secs(5),
                Duration::from_secs(8)
            ),
            None
        );
        assert_eq!(
            retry_wait(
                "provider 503: down",
                Duration::from_secs(5),
                Duration::from_secs(10)
            ),
            Some(Duration::from_secs(5))
        );
    }

    #[test]
    fn permits_eight_retries_after_the_initial_attempt() {
        let retryable = failure(true);
        for retries in 0..MAX_MODEL_RETRIES {
            assert!(should_retry(&retryable, retries));
        }
        assert!(!should_retry(&retryable, MAX_MODEL_RETRIES));
    }

    #[test]
    fn terminal_failures_never_retry() {
        assert!(!should_retry(&failure(false), 0));
    }
}
