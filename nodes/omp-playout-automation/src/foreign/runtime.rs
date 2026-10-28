//! Laufzeit der Fremdplaylist-Plugins: Watchfolder-Thread (Schattenliste), Statusanzeige, manueller Import und
//! Übernahme („Havarie ziehen“). Hängt an `AutomationStore` nur über die öffentlichen Methoden `append`/`updateItem`/`load`,
//! damit alle bestehenden Prüfungen gelten.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use omp_node_sdk::{ParamStore, PluginRegistry};
use serde_json::{json, Map, Value};

use super::map::{self, MapConfig, Plan, PlanItem};
use super::sync::{self, Diff};
use super::{adapter, adapters, ForeignList, ParseCtx};

pub const PLUGIN_PREFIX: &str = "foreign-";

fn default_config() -> Value {
    json!({
        "watchDir": "",
        "channelKey": "",
        "maxAgeSec": 120,
        "pollSec": 5,
        "settleMs": 1500,
        "autoSync": true,
        "mediaTemplate": "{name}",
        "liveMap": {},
        "childMap": {},
        "skipDone": true,
        "requireRelease": false,
    })
}

/// Trägt jeden Adapter als Plugin `foreign-<id>` ein (Standard aus).
pub fn register(plugins: &PluginRegistry) {
    for a in adapters() {
        plugins.register(format!("{PLUGIN_PREFIX}{}", a.id()), format!("Fremdplaylist: {}", a.label()), default_config());
    }
}

struct Shadow {
    file: String,
    order: u64,
    list: Arc<ForeignList>,
    plan: Arc<Plan>,
    loaded_ms: i64,
    last_diff: Diff,
    files_loaded: u64,
    bad: HashMap<u64, u64>,
    rejected: Vec<String>,
    error: Option<String>,
    checked_ms: i64,
}

static SHADOWS: OnceLock<Mutex<BTreeMap<String, Shadow>>> = OnceLock::new();
static LAST_IMPORT: OnceLock<Mutex<Value>> = OnceLock::new();

fn shadows() -> std::sync::MutexGuard<'static, BTreeMap<String, Shadow>> {
    SHADOWS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Ein Durchlauf für einen Adapter. Gibt `true` zurück, wenn eine neue Liste geladen wurde.
fn tick_one(id: &str, cfg: &Value, now: i64) -> bool {
    let Some(fmt) = adapter(id) else { return false };
    let dir = cfg.get("watchDir").and_then(Value::as_str).unwrap_or("").trim();
    if dir.is_empty() {
        return false;
    }
    let key = cfg.get("channelKey").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let settle = cfg.get("settleMs").and_then(Value::as_u64).unwrap_or(1500).min(60_000);
    let (after, bad) = {
        let g = shadows();
        g.get(id).map(|s| (s.order, s.bad.clone())).unwrap_or_default()
    };
    let res = sync::scan(std::path::Path::new(dir), &key, fmt.as_ref(), after, settle, &bad);
    let mut g = shadows();
    match res {
        Err(e) => {
            let s = g.entry(id.to_string()).or_insert_with(|| empty_shadow(now));
            s.error = Some(format!("Ordner nicht lesbar: {e}"));
            s.checked_ms = now;
            false
        }
        Ok(out) => {
            let s = g.entry(id.to_string()).or_insert_with(|| empty_shadow(now));
            s.error = None;
            s.checked_ms = now;
            s.rejected = out.rejected.clone();
            for (o, sz) in &out.bad {
                s.bad.insert(*o, *sz);
            }
            let Some((path, bytes, order)) = out.file else { return false };
            let list = match fmt.parse(&bytes, &ParseCtx::default()) {
                Ok(l) => l,
                Err(e) => {
                    s.error = Some(format!("{}: {e}", path.display()));
                    s.bad.insert(order, bytes.len() as u64);
                    return false;
                }
            };
            let plan = map::plan(&list, &MapConfig::from_json(cfg));
            s.last_diff = sync::diff(&s.plan.items, &plan.items);
            s.file = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            s.order = order;
            s.list = Arc::new(list);
            s.plan = Arc::new(plan);
            s.loaded_ms = now;
            s.files_loaded += 1;
            true
        }
    }
}

fn empty_shadow(now: i64) -> Shadow {
    Shadow {
        file: String::new(),
        order: 0,
        list: Arc::new(ForeignList {
            format: String::new(),
            channel: String::new(),
            fps: super::Fps::PAL,
            house_time_ms: None,
            local_offset_ms: 0,
            list_state: String::new(),
            focus_index: None,
            events: vec![],
            warnings: vec![],
        }),
        plan: Arc::new(Plan::default()),
        loaded_ms: 0,
        last_diff: Diff::default(),
        files_loaded: 0,
        bad: HashMap::new(),
        rejected: vec![],
        error: None,
        checked_ms: now,
    }
}

/// Startet den Watchfolder-Thread (ein Thread für alle Adapter; kostet im Leerlauf nur einen Verzeichnisscan je Takt).
pub fn start(plugins: Arc<PluginRegistry>) {
    std::thread::Builder::new()
        .name("omp-foreign-watch".into())
        .spawn(move || {
            let mut last: HashMap<String, i64> = HashMap::new();
            loop {
                std::thread::sleep(Duration::from_millis(500));
                let now = now_ms();
                for a in adapters() {
                    let pid = format!("{PLUGIN_PREFIX}{}", a.id());
                    let Some(p) = plugins.get(&pid).filter(|p| p.enabled) else { continue };
                    let poll = p.config.get("pollSec").and_then(Value::as_u64).unwrap_or(5).clamp(1, 600) as i64 * 1000;
                    if now - last.get(&pid).copied().unwrap_or(0) < poll {
                        continue;
                    }
                    last.insert(pid, now);
                    tick_one(a.id(), &p.config, now);
                }
            }
        })
        .expect("foreign watcher thread");
}

fn group(notes: &[String]) -> Vec<Value> {
    let mut m: BTreeMap<String, (usize, String)> = BTreeMap::new();
    for n in notes {
        let reason = n.split_once("\u{201c}: ").or_else(|| n.split_once(": ")).map(|x| x.1).unwrap_or(n).to_string();
        let e = m.entry(reason).or_insert((0, n.clone()));
        e.0 += 1;
    }
    let mut v: Vec<_> = m.into_iter().collect();
    v.sort_by(|a, b| b.1.0.cmp(&a.1.0));
    v.into_iter().take(12).map(|(r, (c, ex))| json!({"reason": r, "count": c, "example": ex})).collect()
}

fn report_json(plan: &Plan) -> Value {
    json!({
        "items": plan.items.len(),
        "skippedDone": plan.skipped_done,
        "approximated": {"count": plan.approximated.len(), "groups": group(&plan.approximated)},
        "dropped": {"count": plan.dropped.len(), "groups": group(&plan.dropped)},
    })
}

/// Anzeige für Parameter `foreignStatus`.
pub fn status_json(plugins: &PluginRegistry) -> Value {
    let now = now_ms();
    let g = shadows();
    let mut out = Vec::new();
    for a in adapters() {
        let pid = format!("{PLUGIN_PREFIX}{}", a.id());
        let Some(p) = plugins.get(&pid) else { continue };
        let max_age = p.config.get("maxAgeSec").and_then(Value::as_i64).unwrap_or(120) * 1000;
        let mut o = json!({"id": a.id(), "pluginId": pid, "label": a.label(), "enabled": p.enabled,
            "watchDir": p.config.get("watchDir"), "channelKey": p.config.get("channelKey")});
        if let Some(s) = g.get(a.id()).filter(|s| s.files_loaded > 0 || s.error.is_some() || !s.rejected.is_empty()) {
            let age = sync::age_ms(&s.list, now);
            // Maßgeblich ist das Alter der neuesten brauchbaren Datei (Hausuhr der Datei), nicht der Prüfzeitpunkt.
            let stale = age.map(|a| a > max_age).unwrap_or(s.files_loaded == 0);
            let on_air = sync::on_air(&s.list, now).map(|e| json!({"uid": e.uid, "title": e.title, "mediaName": e.media_name, "startMs": e.start_ms, "endMs": e.end_ms}));
            if let Some(m) = o.as_object_mut() {
                m.extend(
                    json!({
                        "file": s.file, "channel": s.list.channel, "listState": s.list.list_state,
                        "houseTimeMs": s.list.house_time_ms, "ageMs": age, "stale": stale && p.enabled,
                        "loadedMs": s.loaded_ms, "checkedMs": s.checked_ms, "filesLoaded": s.files_loaded,
                        "onAir": on_air, "events": s.list.count_all(),
                        "diff": {"added": s.last_diff.added.len(), "removed": s.last_diff.removed.len(), "changed": s.last_diff.changed.len()},
                        "rejected": s.rejected, "error": s.error, "warnings": s.list.warnings.len(),
                        "report": report_json(&s.plan),
                    })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
                );
            }
        }
        out.push(o);
    }
    json!({"adapters": out, "import": LAST_IMPORT.get().map(|m| m.lock().unwrap_or_else(|e| e.into_inner()).clone())})
}

/// Wendet Plan-Items über die öffentlichen Methoden an. `first_fixtime` setzt beim ersten Item eine Fixzeit.
pub fn apply(store: &crate::AutomationStore, items: &[PlanItem], first_fixtime: Option<i64>) -> (usize, Vec<String>) {
    let mut ok = 0;
    let mut errors = Vec::new();
    for (n, it) in items.iter().enumerate() {
        let mut args = it.append.clone();
        if let Err(e) = store.invoke("append", &args) {
            errors.push(format!("{} „{}“: {}", it.uid, it.title, err_text(&e)));
            continue;
        }
        args.clear();
        let id = format!("item{}", store.state.lock().expect("lock poisoned").next_item_seq);
        let mut patch = it.patch.clone();
        if n == 0 && let Some(ms) = first_fixtime {
            patch.insert("startType".into(), json!("fixtime"));
            patch.insert("startAt".into(), json!(crate::schedule::format_start_at(ms)));
        }
        if !patch.is_empty() {
            let mut a = Map::new();
            a.insert("itemId".into(), json!(id));
            a.insert("patchJson".into(), json!(Value::Object(patch).to_string()));
            if let Err(e) = store.invoke("updateItem", &a) {
                errors.push(format!("{} „{}“: Feinangaben nicht übernommen: {}", it.uid, it.title, err_text(&e)));
            }
        }
        ok += 1;
    }
    (ok, errors)
}

fn err_text(e: &omp_node_sdk::InvokeError) -> String {
    match e {
        omp_node_sdk::InvokeError::Message(m) => m.clone(),
        other => format!("{other:?}"),
    }
}

fn set_last_import(v: Value) {
    *LAST_IMPORT.get_or_init(|| Mutex::new(Value::Null)).lock().unwrap_or_else(|e| e.into_inner()) = v;
}

/// Methode `foreign.import`: `text` (Dateiinhalt), `format` (leer = erkennen), `mode` = preview|append|replace.
pub fn import(store: &crate::AutomationStore, args: &Map<String, Value>) -> Result<(), String> {
    let text = args.get("text").and_then(Value::as_str).unwrap_or("");
    if text.trim().is_empty() {
        return Err("text fehlt (Inhalt der Liste)".into());
    }
    let want = args.get("format").and_then(Value::as_str).unwrap_or("");
    let fmt = if want.is_empty() {
        adapters().into_iter().find(|a| a.sniff(text.as_bytes())).ok_or("Format nicht erkannt")?
    } else {
        adapter(want).ok_or_else(|| format!("Format „{want}“ unbekannt"))?
    };
    if !fmt.is_complete(text.as_bytes()) {
        return Err("Die Liste ist unvollständig oder kein gültiges XML".into());
    }
    let cfg = store.plugins.get(&format!("{PLUGIN_PREFIX}{}", fmt.id())).map(|p| p.config).unwrap_or_else(default_config);
    let list = fmt.parse(text.as_bytes(), &ParseCtx::default())?;
    let plan = map::plan(&list, &MapConfig::from_json(&cfg));
    let mode = args.get("mode").and_then(Value::as_str).unwrap_or("preview");
    let mut rep = report_json(&plan);
    rep["format"] = json!(fmt.id());
    rep["channel"] = json!(list.channel);
    rep["mode"] = json!(mode);
    rep["warnings"] = json!(list.warnings);
    match mode {
        "preview" => {}
        "append" | "replace" => {
            if mode == "replace" {
                let mut a = Map::new();
                a.insert("itemsJson".into(), json!("[]"));
                store.invoke("load", &a).map_err(|e| format!("Liste leeren: {}", err_text(&e)))?;
            }
            let (ok, errors) = apply(store, &plan.items, None);
            rep["applied"] = json!(ok);
            rep["errors"] = json!(errors);
        }
        o => return Err(format!("mode „{o}“ unbekannt (preview|append|replace)")),
    }
    set_last_import(rep);
    Ok(())
}

/// Methode `foreign.takeover` („Havarie ziehen“): die Schattenliste ab dem Event NACH dem laufenden in die echte
/// Playlist übernehmen. Das erste Event bekommt seine geplante Fixzeit (liegt sie schon hinter uns: Folgestart).
pub fn takeover(store: &crate::AutomationStore, args: &Map<String, Value>) -> Result<(), String> {
    let id = args.get("adapter").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("mpl3").to_string();
    let include_current = args.get("includeCurrent").and_then(Value::as_bool).unwrap_or(false);
    let (list, plan) = {
        let g = shadows();
        let s = g.get(&id).filter(|s| s.files_loaded > 0).ok_or("keine Schattenliste geladen")?;
        (s.list.clone(), s.plan.clone())
    };
    let now = now_ms();
    let cur = sync::on_air(&list, now).ok_or("kein laufendes Event in der Schattenliste erkennbar")?;
    let pos = plan.items.iter().position(|i| i.uid == cur.uid).ok_or("laufendes Event ist kein Sendeevent im Plan")?;
    let from = if include_current { pos } else { pos + 1 };
    let items = &plan.items[from.min(plan.items.len())..];
    if items.is_empty() {
        return Err("nach dem laufenden Event folgt nichts".into());
    }
    let mut a = Map::new();
    a.insert("itemsJson".into(), json!("[]"));
    store.invoke("load", &a).map_err(|e| format!("Liste leeren: {}", err_text(&e)))?;
    let first_fix = items[0].start_ms.filter(|ms| *ms > now + 2000);
    let (ok, errors) = apply(store, items, first_fix);
    set_last_import(json!({"mode": "takeover", "from": cur.title, "applied": ok, "errors": errors, "firstFixtimeMs": first_fix}));
    if ok == 0 {
        return Err(format!("nichts übernommen: {}", errors.first().cloned().unwrap_or_default()));
    }
    Ok(())
}

/// Methode `foreign.rescan`: sofort neu prüfen (statt auf den Takt zu warten).
pub fn rescan(store: &crate::AutomationStore) {
    let now = now_ms();
    for a in adapters() {
        if let Some(p) = store.plugins.get(&format!("{PLUGIN_PREFIX}{}", a.id())).filter(|p| p.enabled) {
            tick_one(a.id(), &p.config, now);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINI: &str = include_str!("fixtures/mini.mpl");

    #[test]
    fn watchfolder_laedt_diff_und_alarm() {
        let d = std::env::temp_dir().join(format!("omp-foreign-rt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let plugins = PluginRegistry::new();
        register(&plugins);
        assert!(plugins.get("foreign-mpl3").is_some_and(|p| !p.enabled));
        let cfg = json!({"watchDir": d.to_string_lossy(), "channelKey": "5000", "settleMs": 0, "childMap": {"LogoHD": {"type": "GRAPHICS"}}});
        // Nichts im Ordner.
        assert!(!tick_one("mpl3", &cfg, 1000));
        // Halb geschriebene Datei wird nie geladen.
        std::fs::write(d.join("Autosaved_5000_09-00-00-00_28-10-2026.mpl"), &MINI.as_bytes()[..MINI.len() / 2]).unwrap();
        assert!(!tick_one("mpl3", &cfg, 2000));
        plugins.set_enabled("foreign-mpl3", true);
        plugins.set_config("foreign-mpl3", cfg.clone());
        let st = status_json(&plugins);
        assert_eq!(st["adapters"][0]["rejected"].as_array().unwrap().len(), 1);
        // Gültige Datei → geladen.
        std::fs::write(d.join("Autosaved_5000_08-00-00-00_28-10-2026.mpl"), MINI).unwrap();
        // Die halbe ist neuer (09:00) und bleibt abgelehnt, die ältere gültige gewinnt.
        assert!(tick_one("mpl3", &cfg, 3000));
        let st = status_json(&plugins);
        let a = &st["adapters"][0];
        assert_eq!(a["file"], "Autosaved_5000_08-00-00-00_28-10-2026.mpl");
        assert_eq!(a["filesLoaded"], 1);
        assert_eq!(a["channel"], "TxX-A");
        assert_eq!(a["diff"]["added"], 2);
        // Die Beispieldatei ist von 2026 → gemessen an der echten Uhr längst veraltet → Alarm.
        assert_eq!(a["stale"], true);
        assert_eq!(a["report"]["items"], 2);
        // Unveränderte Wiederholung lädt nichts.
        assert!(!tick_one("mpl3", &cfg, 4000));
        // Neuere gültige Datei mit Änderung → Diff.
        std::fs::write(d.join("Autosaved_5000_10-00-00-00_28-10-2026.mpl"), MINI.replace("Beispielsendung", "Neu")).unwrap();
        assert!(tick_one("mpl3", &cfg, 5000));
        let a = &status_json(&plugins)["adapters"][0];
        assert_eq!(a["diff"]["changed"], 1);
        assert_eq!(a["filesLoaded"], 2);
        std::fs::remove_dir_all(d).unwrap();
    }
}
