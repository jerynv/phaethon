//! Stopping an import part way: one flag the person's Cancel sets, which every
//! step of an import looks at. Network reads race it (the request is dropped),
//! the text reader and text recognition children are killed when they see it,
//! and the importer then records only what it finished, so the next import
//! picks up from there.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::Notify;

#[derive(Debug, Default)]
struct Inner {
    flag: AtomicBool,
    notify: Notify,
}

/// A shared "stop now" flag. Clones share it; the default one is never set.
#[derive(Debug, Clone, Default)]
pub struct Cancel(Arc<Inner>);

/// The words an operation stopped by [`Cancel`] gives back as its error.
pub const CANCELLED: &str = "cancelled";

impl Cancel {
    pub fn new() -> Cancel {
        Cancel::default()
    }

    /// Ask everything watching to stop. Idempotent.
    pub fn cancel(&self) {
        self.0.flag.store(true, Ordering::SeqCst);
        self.0.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.flag.load(Ordering::SeqCst)
    }

    /// The flag itself, for blocking code (child process supervisors) that polls it.
    pub fn flag(&self) -> &AtomicBool {
        &self.0.flag
    }

    /// Resolves once [`Cancel::cancel`] has been called (at once if it already was).
    pub async fn cancelled(&self) {
        loop {
            // Registered before the check, so a cancel between the two isn't missed.
            let n = self.0.notify.notified();
            if self.is_cancelled() {
                return;
            }
            n.await;
        }
    }

    /// `fut`, unless cancelled first: then `Err(CANCELLED)` and `fut` is dropped
    /// (an HTTP request in it is abandoned).
    pub async fn run<F: std::future::Future>(&self, fut: F) -> Result<F::Output, &'static str> {
        if self.is_cancelled() {
            return Err(CANCELLED);
        }
        tokio::select! {
            biased;
            _ = self.cancelled() => Err(CANCELLED),
            v = fut => Ok(v),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn a_cancel_interrupts_a_pending_future_and_later_ones() {
        let c = Cancel::new();
        let c2 = c.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            c2.cancel();
        });
        let started = std::time::Instant::now();
        let r = c.run(tokio::time::sleep(Duration::from_secs(30))).await;
        assert_eq!(r, Err(CANCELLED));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(c.is_cancelled());
        assert_eq!(c.run(async { 1 }).await, Err(CANCELLED));
        assert_eq!(Cancel::new().run(async { 2 }).await, Ok(2));
    }
}
