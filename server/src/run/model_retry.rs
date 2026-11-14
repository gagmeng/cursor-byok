//! Defines retry policy for one logical model call.

use std::time::Duration;

use super::ModelCycleFailure;

pub(super) const MAX_MODEL_RETRIES: u32 = 8;
pub(super) const MODEL_RETRY_DELAY: Duration = Duration::from_secs(5);

/// Rate limits without a `Retry-After` start here and double each time. A flat
/// five-second retry against a limit that lasts minutes spends the whole retry
/// budget in under a minute and turns a wait into a failure.
const RATE_LIMIT_BACKOFF_FLOOR: Duration = Duration::from_secs(60);
const RATE_LIMIT_BACKOFF_CEILING: Duration = Duration::from_secs(30 * 60);

pub(super) fn should_retry(failure: &ModelCycleFailure, retries: u32) -> bool {
    failure.retryable && retries < MAX_MODEL_RETRIES
}

/// Uses Retry-After when the provider sent one. A wait longer than the
/// remaining request budget is not started.
///
/// `retries` is the attempt number that is about to be retried (1 for the
/// first retry), and only rates the backoff schedule for rate-limited calls;
/// other retryable failures keep the fixed delay.
pub(super) fn retry_wait(
    message: &str,
    default: Duration,
    remaining: Duration,
    retries: u32,
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
        .unwrap_or_else(|| {
            if is_rate_limited(message) {
                rate_limit_backoff(retries)
            } else {
                default
            }
        });
    (requested <= remaining).then_some(requested)
}

/// A provider that answered 429 without `Retry-After` says only "later"; this
/// schedule starts at a minute and doubles, so eight retries span over an hour
/// instead of under a minute.
fn rate_limit_backoff(retries: u32) -> Duration {
    let doublings = retries.saturating_sub(1).min(8);
    RATE_LIMIT_BACKOFF_FLOOR
        .saturating_mul(1 << doublings)
        .min(RATE_LIMIT_BACKOFF_CEILING)
}

fn is_rate_limited(message: &str) -> bool {
    message
        .split(|character: char| !character.is_ascii_digit())
        .any(|token| token == "429")
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
                Duration::from_secs(10),
                1
            ),
            Some(Duration::from_secs(4))
        );
        assert_eq!(
            retry_wait(
                "retry_after_seconds=9; provider 429: wait",
                Duration::from_secs(5),
                Duration::from_secs(8),
                1
            ),
            None
        );
        assert_eq!(
            retry_wait(
                "provider 503: down",
                Duration::from_secs(5),
                Duration::from_secs(10),
                3
            ),
            Some(Duration::from_secs(5))
        );
    }

    /// A 429 with no Retry-After must not be retried five seconds later: the
    /// limit outlasts that, so every retry in the budget burns on the same
    /// closed door. The wait doubles instead, and the budget still cuts it off.
    #[test]
    fn a_rate_limit_without_retry_after_backs_off_exponentially() {
        let budget = Duration::from_secs(60 * 60);
        let waits: Vec<u64> = (1..=4)
            .map(|retries| {
                retry_wait(
                    "provider 429: slow down",
                    Duration::from_secs(5),
                    budget,
                    retries,
                )
                .expect("a wait inside the budget is always available")
                .as_secs()
            })
            .collect();
        assert_eq!(waits, vec![60, 120, 240, 480]);

        assert_eq!(
            retry_wait(
                "provider 429: slow down",
                Duration::from_secs(5),
                Duration::from_secs(30),
                1
            ),
            None,
            "a wait longer than the remaining budget is never started"
        );
    }

    #[test]
    fn the_backoff_stops_growing_at_the_ceiling() {
        assert_eq!(
            rate_limit_backoff(20),
            Duration::from_secs(30 * 60),
            "a long-lived rate limit must not schedule a wait hours long"
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
