//! Minimales Beispiel für `omp-node-sdk`: ein Node mit zwei Parametern
//! (`label`, `gain`) und einer Methode (`reset`) — bewusst identisch zum
//! Go-Mock-Node (`nodes/mock`), damit beide im Flow-Editor vergleichbar
//! sind. Verifikation von C1 (`UMSETZUNG.md`): startet, erscheint in
//! Registry + Flow-Editor, Parameter über das generische Panel änderbar.
//!
//! Start: `cargo run --example hello_node`
//! Env (alle optional): `OMP_LABEL`, `OMP_HOST`, `OMP_PORT`,
//! `OMP_REGISTRY_URL`, `OMP_NATS_URL`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use omp_node_sdk::{
    Descriptor, InvokeError, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, Range,
    SenderSpec, SetError,
};
use serde_json::Value;

struct HelloStore {
    values: Mutex<HashMap<String, Value>>,
}

impl HelloStore {
    fn new(label: &str) -> Self {
        let mut values = HashMap::new();
        values.insert("label".to_string(), Value::String(label.to_string()));
        values.insert("gain".to_string(), serde_json::json!(0.0));
        HelloStore {
            values: Mutex::new(values),
        }
    }
}

impl ParamStore for HelloStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            parameters: vec![
                ParamSpec {
                    name: "label".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: false,
                },
                ParamSpec {
                    name: "gain".to_string(),
                    kind: ParamType::Number,
                    unit: Some("dB".to_string()),
                    range: Some(Range::Number {
                        min: -96.0,
                        max: 12.0,
                    }),
                    readonly: false,
                },
            ],
            methods: vec![MethodSpec {
                name: "reset".to_string(),
                args: vec![],
            }],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        self.values
            .lock()
            .expect("lock poisoned")
            .get(name)
            .cloned()
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        let mut values = self.values.lock().expect("lock poisoned");
        if !values.contains_key(name) {
            return Err(SetError::Unknown);
        }
        values.insert(name.to_string(), value);
        Ok(())
    }

    fn invoke(
        &self,
        name: &str,
        _args: &serde_json::Map<String, Value>,
    ) -> Result<(), InvokeError> {
        if name != "reset" {
            return Err(InvokeError::Unknown);
        }
        let mut values = self.values.lock().expect("lock poisoned");
        values.insert("gain".to_string(), serde_json::json!(0.0));
        Ok(())
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Hello Node");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9101").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");

    let store: Arc<dyn ParamStore> = Arc::new(HelloStore::new(&label));

    omp_node_sdk::run(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url,
            senders: vec![SenderSpec::default()],
            receivers: vec![omp_node_sdk::ReceiverSpec::default()],
        },
        store,
    )
    .await
}
