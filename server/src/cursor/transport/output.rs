//! Buffers, replays, broadcasts, and atomically closes downstream output.

use crate::cursor::protocol::connect::{self, ConnectCode, ConnectStreamError};
use bytes::Bytes;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    sync::Arc,
};
use tokio::sync::watch;

const MEMORY_LIMIT: usize = 1024 * 1024;
const MEMORY_FRAME_LIMIT: usize = 512;

pub struct OutputHub {
    state: parking_lot::Mutex<OutputState>,
    changed: watch::Sender<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn slow_subscribers_replay_long_output_without_retaining_it_all_in_memory() {
        let hub = std::sync::Arc::new(OutputHub::default());
        let mut slow = hub.subscribe();
        let frame = Bytes::from(vec![7; 64 * 1024]);
        for _ in 0..128 {
            assert!(hub.emit(frame.clone()));
        }
        assert!(
            hub.state
                .lock()
                .history
                .iter()
                .map(Bytes::len)
                .sum::<usize>()
                <= 1024 * 1024,
            "replay history must spill to disk instead of growing the process heap"
        );
        hub.close();
        let mut reconnect = hub.subscribe();
        for _ in 0..128 {
            assert_eq!(slow.recv().await, Some(frame.clone()));
            assert_eq!(reconnect.recv().await, Some(frame.clone()));
        }
        assert_eq!(slow.recv().await, None);
        assert_eq!(reconnect.recv().await, None);
    }

    #[tokio::test]
    async fn subscribers_wake_for_new_output_and_storage_corruption_ends_with_an_error() {
        let hub = Arc::new(OutputHub::default());
        let mut subscriber = hub.subscribe();
        let producer = hub.clone();
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            producer.emit(Bytes::from_static(b"live"));
        });
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(1), subscriber.recv())
                .await
                .unwrap(),
            Some(Bytes::from_static(b"live"))
        );
        hub.emit(Bytes::from(vec![8; MEMORY_LIMIT]));
        hub.state.lock().spool.as_mut().unwrap().set_len(0).unwrap();
        let failure = subscriber.recv().await.unwrap();
        let frames = connect::decode_frames(&failure).unwrap();
        assert_ne!(frames[0].0 & connect::END_STREAM_FLAG, 0);
        assert!(String::from_utf8_lossy(&frames[0].1).contains("output replay storage failed"));
        assert_eq!(subscriber.recv().await, None);
        assert!(!hub.emit(Bytes::from_static(b"after failure")));
    }
}

#[derive(Default)]
struct OutputState {
    history: Vec<Bytes>,
    spool: Option<File>,
    bytes: u64,
    failed: bool,
    closed: bool,
}

impl Default for OutputHub {
    fn default() -> Self {
        Self {
            state: Default::default(),
            changed: watch::channel(0).0,
        }
    }
}

pub struct OutputSubscription {
    hub: Arc<OutputHub>,
    changed: watch::Receiver<u64>,
    offset: u64,
    finished: bool,
}

impl OutputSubscription {
    pub async fn recv(&mut self) -> Option<Bytes> {
        if self.finished {
            return None;
        }
        loop {
            self.changed.borrow_and_update();
            {
                let mut state = self.hub.state.lock();
                if state.failed {
                    self.finished = true;
                    return connect::encode_error_end_stream(&ConnectStreamError {
                        code: ConnectCode::Internal,
                        message: "output replay storage failed".into(),
                        details: Vec::new(),
                    })
                    .ok();
                }
                if self.offset < state.bytes {
                    let frame = read_frame(&mut state, self.offset);
                    match frame {
                        Ok(frame) => {
                            self.offset += 8 + frame.len() as u64;
                            return Some(frame);
                        }
                        Err(error) => {
                            tracing::error!(%error,"output replay read failed");
                            state.failed = true;
                            state.closed = true;
                            self.hub
                                .changed
                                .send_modify(|version| *version = version.wrapping_add(1));
                            continue;
                        }
                    }
                }
                if state.closed {
                    self.finished = true;
                    return None;
                }
            }
            if self.changed.changed().await.is_err() {
                self.finished = true;
                return None;
            }
        }
    }
}

fn read_frame(state: &mut OutputState, offset: u64) -> std::io::Result<Bytes> {
    if let Some(file) = &mut state.spool {
        file.seek(SeekFrom::Start(offset))?;
        let mut length = [0; 8];
        file.read_exact(&mut length)?;
        let length = u64::from_le_bytes(length);
        if length > state.bytes.saturating_sub(offset + 8) {
            return Err(std::io::Error::other(
                "output replay frame length exceeds recorded bytes",
            ));
        }
        let mut frame = vec![0; usize::try_from(length).map_err(std::io::Error::other)?];
        file.read_exact(&mut frame)?;
        Ok(Bytes::from(frame))
    } else {
        let mut position = 0;
        for frame in &state.history {
            if position == offset {
                return Ok(frame.clone());
            }
            position += 8 + frame.len() as u64;
        }
        Err(std::io::Error::other(
            "output replay cursor is outside the recorded frames",
        ))
    }
}

fn write_frame(file: &mut File, frame: &Bytes) -> std::io::Result<()> {
    file.write_all(&(frame.len() as u64).to_le_bytes())?;
    file.write_all(frame)
}

impl OutputHub {
    pub fn emit(&self, frame: Bytes) -> bool {
        let mut state = self.state.lock();
        if state.closed {
            return false;
        }
        let saved = (|| -> std::io::Result<()> {
            if state.spool.is_none()
                && (state.bytes + frame.len() as u64 + 8 > MEMORY_LIMIT as u64
                    || state.history.len() >= MEMORY_FRAME_LIMIT)
            {
                let mut file = tempfile::tempfile()?;
                for old in &state.history {
                    write_frame(&mut file, old)?;
                }
                state.spool = Some(file);
                state.history.clear();
                state.history.shrink_to_fit();
            }
            if let Some(file) = &mut state.spool {
                file.seek(SeekFrom::End(0))?;
                write_frame(file, &frame)?;
            } else {
                state.history.push(frame.clone());
            }
            state.bytes += 8 + frame.len() as u64;
            Ok(())
        })();
        if let Err(error) = saved {
            tracing::error!(%error,"output replay write failed");
            state.failed = true;
            state.closed = true;
        }
        self.changed
            .send_modify(|version| *version = version.wrapping_add(1));
        if state.failed {
            return false;
        }
        true
    }

    pub fn subscribe(self: &Arc<Self>) -> OutputSubscription {
        OutputSubscription {
            hub: self.clone(),
            changed: self.changed.subscribe(),
            offset: 0,
            finished: false,
        }
    }

    pub fn close(&self) -> bool {
        let mut state = self.state.lock();
        if state.closed {
            return false;
        }
        state.closed = true;
        self.changed
            .send_modify(|version| *version = version.wrapping_add(1));
        drop(state);
        true
    }
}
