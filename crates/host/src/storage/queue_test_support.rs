//! 暂停真实writer并占满实际有界队列；不替换request的Full判断或容量。
use super::*;
use std::time::Duration;

pub(crate) struct WriterSaturation {
    release: Option<mpsc::SyncSender<()>>,
    drained: mpsc::Receiver<()>,
    _writer: Arc<Writer>,
}
impl WriterSaturation {
    pub(crate) fn release(&mut self) {
        if let Some(release) = self.release.take() {
            let _ = release.try_send(());
            self.drained
                .recv_timeout(Duration::from_secs(5))
                .expect("Real storage queue did not drain");
        }
    }
}
impl Drop for WriterSaturation {
    fn drop(&mut self) {
        if let Some(release) = self.release.take() {
            let _ = release.try_send(());
        }
    }
}
impl Store {
    pub(crate) fn saturate_writer_for_test(&self) -> WriterSaturation {
        let (entered, waiting) = mpsc::sync_channel(1);
        let (release, resume) = mpsc::sync_channel(1);
        let (done, drained) = mpsc::sync_channel(1);
        let guard = WriterSaturation {
            release: Some(release),
            drained,
            _writer: self.writer.clone(),
        };
        assert!(
            self.writer
                .sender
                .try_send(WriterMessage::Run(Box::new(move |_| {
                    let _ = entered.send(());
                    resume
                        .recv_timeout(Duration::from_secs(5))
                        .expect("Storage pause was not released");
                })))
                .is_ok()
        );
        waiting
            .recv_timeout(Duration::from_secs(5))
            .expect("Real storage writer did not pause");
        for index in 0..WRITER_QUEUE_CAPACITY {
            let done = done.clone();
            assert!(
                self.writer
                    .sender
                    .try_send(WriterMessage::Run(Box::new(move |_| {
                        if index + 1 == WRITER_QUEUE_CAPACITY {
                            let _ = done.send(());
                        }
                    })))
                    .is_ok()
            );
        }
        guard
    }
}
