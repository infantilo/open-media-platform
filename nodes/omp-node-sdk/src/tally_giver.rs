//! Tally-Geber für Nodes mit Receivern (z. B. ST2110-/Ausgangs-Gateways): ist der Node als
//! Tally-Geber aktiviert (`OMP_TALLY_GIVER=1`), gilt jede Quelle, die per IS-05 auf einen seiner
//! Receiver geschaltet ist, als "auf Sendung" — der Node veröffentlicht `omp.tally.<quell-node>`
//! (Absender = er selbst), solange die Verbindung besteht, und schaltet beim Trennen wieder ab.
//! Gleicher Bus wie Bildmischer/Switcher; Kacheln und Handy-Kameras reagieren identisch.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use crate::is04::RegistryClient;
use crate::node::NodeHandle;

pub struct TallyGiver {
    enabled: bool,
    registry: RegistryClient,
    attached: OnceLock<(NodeHandle, tokio::runtime::Handle)>,
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// Schlüssel (z. B. Receiver-ID) → gewünschte Sender-ID.
    wanted: HashMap<String, String>,
    /// Schlüssel → Quell-Node, für den gerade Tally "an" veröffentlicht ist.
    published: HashMap<String, String>,
}

impl TallyGiver {
    /// `OMP_TALLY_GIVER` (1/true/yes/on) schaltet die Funktion ein; sonst No-Op.
    pub fn from_env(registry_url: &str) -> Arc<Self> {
        let enabled = matches!(
            std::env::var("OMP_TALLY_GIVER").unwrap_or_default().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        );
        Arc::new(Self {
            enabled,
            registry: RegistryClient::new(registry_url.to_string()),
            attached: OnceLock::new(),
            inner: Mutex::new(Inner::default()),
        })
    }

    /// Nach `start()` aufrufen (aus dem tokio-Kontext); holt bereits gemerkte Verbindungen nach.
    pub fn attach(self: &Arc<Self>, handle: NodeHandle) {
        if !self.enabled {
            return;
        }
        let _ = self.attached.set((handle, tokio::runtime::Handle::current()));
        self.reconcile();
    }

    /// Verbindung `key` zeigt auf `sender_id` (`Some`) bzw. ist getrennt (`None`).
    pub fn set(self: &Arc<Self>, key: &str, sender_id: Option<&str>) {
        if !self.enabled {
            return;
        }
        {
            let mut i = self.inner.lock().expect("lock poisoned");
            match sender_id {
                Some(s) => i.wanted.insert(key.to_string(), s.to_string()),
                None => i.wanted.remove(key),
            };
        }
        self.reconcile();
    }

    fn reconcile(self: &Arc<Self>) {
        let Some((handle, rt)) = self.attached.get() else { return };
        let (this, handle) = (self.clone(), handle.clone());
        rt.spawn(async move {
            let wanted = this.inner.lock().expect("lock poisoned").wanted.clone();
            // Sender → Quell-Node auflösen (blockierende Registry-Abfrage, mit Zeitlimit).
            let mut desired: HashMap<String, String> = HashMap::new();
            for (key, sender_id) in wanted {
                let reg = this.registry.clone();
                let work = tokio::task::spawn_blocking(move || {
                    let sender = reg.get_sender(&sender_id).ok()?;
                    reg.get_device(&sender.device_id).ok().map(|d| d.node_id)
                });
                if let Ok(Ok(Some(node))) = tokio::time::timeout(std::time::Duration::from_secs(3), work).await {
                    desired.insert(key, node);
                }
            }
            let (offs, ons) = {
                let mut i = this.inner.lock().expect("lock poisoned");
                // Verbindung nur übernehmen, wenn sie inzwischen nicht verändert/entfernt wurde.
                let still: HashMap<String, String> =
                    desired.into_iter().filter(|(k, _)| i.wanted.contains_key(k)).collect();
                let old = std::mem::replace(&mut i.published, still.clone());
                let offs: Vec<String> = old
                    .values()
                    .filter(|n| !still.values().any(|m| m == *n))
                    .cloned()
                    .collect::<std::collections::BTreeSet<_>>()
                    .into_iter()
                    .collect();
                let ons: Vec<String> = still
                    .values()
                    .filter(|n| !old.values().any(|m| m == *n))
                    .cloned()
                    .collect::<std::collections::BTreeSet<_>>()
                    .into_iter()
                    .collect();
                (offs, ons)
            };
            for n in offs {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(3), handle.publish_tally(&n, false)).await;
            }
            for n in ons {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(3), handle.publish_tally(&n, true)).await;
            }
        });
    }
}
