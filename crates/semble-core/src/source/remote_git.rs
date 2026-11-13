//! Restricted HTTPS Git acquisition for explicitly requested remote repositories.

const GIT_STEP_TIMEOUT: Duration = Duration::from_secs(30);
/// fetch, reset, rev-parse, and worktree add can each hold the cache lock.
const MAX_GIT_STEPS_UNDER_LOCK: u32 = 4;
const LOCK_WAIT: Duration =
    Duration::from_secs(GIT_STEP_TIMEOUT.as_secs() * MAX_GIT_STEPS_UNDER_LOCK as u64);

use std::{
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use sha2::{Digest, Sha256};
use url::Url;

use crate::{Error, Result};

pub struct RemoteRepository {
    pub path: PathBuf,
    pub identity: String,
}

impl RemoteRepository {
    pub fn acquire(url: &str, cache_root: &Path) -> Result<Self> {
        Self::resolve(url, cache_root, false)
    }

    pub fn refresh(url: &str, cache_root: &Path) -> Result<Self> {
        Self::resolve(url, cache_root, true)
    }

    fn resolve(url: &str, cache_root: &Path, refresh: bool) -> Result<Self> {
        let parsed = Url::parse(url).map_err(|_| Error::UnsupportedUrl(url.to_owned()))?;
        if parsed.scheme() != "https" || parsed.host_str().is_none() {
            return Err(Error::UnsupportedUrl(url.to_owned()));
        }
        Self::acquire_validated(url, cache_root, refresh)
    }

    fn acquire_validated(url: &str, cache_root: &Path, refresh: bool) -> Result<Self> {
        let key = hex::encode(Sha256::digest(url.as_bytes()));
        let repos = cache_root.join("repos");
        std::fs::create_dir_all(&repos).map_err(|error| Error::io(&repos, error))?;
        let lock_path = repos.join(format!("{key}.lock"));
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)
            .map_err(|error| Error::io(&lock_path, error))?;
        let deadline = Instant::now() + LOCK_WAIT;
        loop {
            match lock.try_lock() {
                Ok(()) => break,
                Err(std::fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                Err(error) => {
                    return Err(Error::Git(format!(
                        "remote repository cache lock unavailable: {error}"
                    )))
                }
            }
        }
        let path = repos.join(&key);
        let mut cloned = false;
        if !path.join(".git").is_dir() {
            let temporary =
                repos.join(format!(".clone-{}-{}", std::process::id(), random_suffix()));
            let result = run_git(
                Command::new("git")
                    .args(["clone", "--depth", "1", "--", url])
                    .arg(&temporary),
            );
            if let Err(error) = result {
                let _ = std::fs::remove_dir_all(&temporary);
                return Err(error);
            }
            std::fs::rename(&temporary, &path).map_err(|error| Error::io(&path, error))?;
            cloned = true;
        }
        if refresh && !cloned {
            run_git(
                Command::new("git")
                    .arg("-C")
                    .arg(&path)
                    .args(["fetch", "--depth", "1", "origin", "HEAD"]),
            )?;
            run_git(Command::new("git").arg("-C").arg(&path).args([
                "reset",
                "--hard",
                "FETCH_HEAD",
            ]))?;
        }
        let revision = run_git(
            Command::new("git")
                .args(["-C"])
                .arg(&path)
                .args(["rev-parse", "HEAD"]),
        )?
        .trim()
        .to_owned();
        // A refresh must not rewrite files while another search is indexing them.
        let snapshots = cache_root.join("snapshots").join(&key);
        std::fs::create_dir_all(&snapshots).map_err(|error| Error::io(&snapshots, error))?;
        let snapshot = snapshots.join(&revision);
        if !snapshot.join(".git").is_file() {
            run_git(
                Command::new("git")
                    .arg("-C")
                    .arg(&path)
                    .args(["worktree", "add", "--detach", "--force"])
                    .arg(&snapshot)
                    .arg(&revision),
            )?;
        }
        Ok(Self {
            path: snapshot,
            identity: format!("{url}@{revision}"),
        })
    }
}

fn run_git(command: &mut Command) -> Result<String> {
    run_bounded(command, GIT_STEP_TIMEOUT)
}

fn run_bounded(command: &mut Command, timeout: Duration) -> Result<String> {
    let mut stdout = tempfile::tempfile().map_err(|error| Error::Git(error.to_string()))?;
    let mut stderr = tempfile::tempfile().map_err(|error| Error::Git(error.to_string()))?;
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .stdin(Stdio::null())
        .stdout(
            stdout
                .try_clone()
                .map_err(|error| Error::Git(error.to_string()))?,
        )
        .stderr(
            stderr
                .try_clone()
                .map_err(|error| Error::Git(error.to_string()))?,
        );
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|error| Error::Git(error.to_string()))?;
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            outcome => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Error::Git(match outcome {
                    Err(error) => error.to_string(),
                    _ => format!(
                        "Git operation exceeded {} milliseconds",
                        timeout.as_millis()
                    ),
                }));
            }
        }
    };
    let file = if status.success() {
        &mut stdout
    } else {
        &mut stderr
    };
    file.seek(SeekFrom::Start(0))
        .map_err(|error| Error::Git(error.to_string()))?;
    let mut text = String::new();
    file.take(1024 * 1024)
        .read_to_string(&mut text)
        .map_err(|error| Error::Git(error.to_string()))?;
    if !status.success() {
        return Err(Error::Git(text.trim().into()));
    }
    Ok(text)
}

fn random_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |value| value.as_nanos())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(root: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    #[ignore = "subprocess fixture for a stalled Git operation"]
    fn stalled_process_child() {
        std::thread::sleep(Duration::from_secs(10));
    }

    #[test]
    fn stalled_git_operations_stop_at_the_deadline() {
        let started = Instant::now();
        let result = run_bounded(
            Command::new(std::env::current_exe().unwrap()).args([
                "--exact",
                "source::remote_git::tests::stalled_process_child",
                "--ignored",
            ]),
            Duration::from_millis(80),
        );
        assert!(result.unwrap_err().to_string().contains("exceeded"));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "a hung child must be reaped within the command deadline"
        );
    }

    #[test]
    fn refreshing_a_remote_checkout_reads_the_new_default_branch_and_serializes_clones() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        std::fs::create_dir(&source).unwrap();
        git(&source, &["init", "-b", "main"]);
        git(&source, &["config", "user.name", "Regression"]);
        git(
            &source,
            &["config", "user.email", "regression@example.invalid"],
        );
        std::fs::write(source.join("code.rs"), "first").unwrap();
        git(&source, &["add", "."]);
        git(&source, &["commit", "-m", "first"]);
        let url = source.to_str().unwrap();
        let cache = directory.path().join("cache");
        let original = RemoteRepository::acquire_validated(url, &cache, false).unwrap();
        git(&source, &["checkout", "-b", "new-default"]);
        std::fs::write(source.join("code.rs"), "second").unwrap();
        git(&source, &["add", "."]);
        git(&source, &["commit", "-m", "second"]);
        let refreshed = RemoteRepository::acquire_validated(url, &cache, true).unwrap();
        assert_ne!(
            original.identity, refreshed.identity,
            "refresh must fetch the remote HEAD rather than keep the old cache"
        );
        assert_eq!(
            std::fs::read_to_string(refreshed.path.join("code.rs")).unwrap(),
            "second"
        );
        assert_eq!(
            std::fs::read_to_string(original.path.join("code.rs")).unwrap(),
            "first",
            "refresh must preserve a snapshot already being indexed"
        );
        let cache = directory.path().join("concurrent");
        std::thread::scope(|scope| {
            let tasks = (0..4)
                .map(|_| {
                    scope.spawn(|| {
                        RemoteRepository::acquire_validated(url, &cache, false)
                            .unwrap()
                            .identity
                    })
                })
                .collect::<Vec<_>>();
            for task in tasks {
                assert_eq!(task.join().unwrap(), refreshed.identity);
            }
        });
    }

    #[test]
    fn lock_wait_covers_every_git_step_that_can_hold_it() {
        assert!(LOCK_WAIT >= GIT_STEP_TIMEOUT * MAX_GIT_STEPS_UNDER_LOCK);
    }

    #[test]
    fn remote_sources_reject_non_https_urls_before_git_runs() {
        let directory = tempfile::tempdir().unwrap();
        assert!(matches!(
            RemoteRepository::acquire("file:///tmp/repository", directory.path()),
            Err(Error::UnsupportedUrl(_))
        ));
        assert!(matches!(
            RemoteRepository::acquire("git@github.com:owner/repo.git", directory.path()),
            Err(Error::UnsupportedUrl(_))
        ));
        assert!(matches!(
            RemoteRepository::acquire("http://example.com/repo.git", directory.path()),
            Err(Error::UnsupportedUrl(_))
        ));
    }
}
