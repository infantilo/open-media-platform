//! MXL-native Fabrics/RDMA-Transport (`docs/END-GOAL-FEATURES.md` §16.4
//! Teil 1, Kapitel 16 Teil 0 live verifiziert per `mxl-fabrics-demo`,
//! `docs/decisions.md` Nachtrag 41-43) — Feature-Flag `fabrics`.
//!
//! **Fundament-Ebene (Teil 1):** FFI-Bindings + sicherer Rust-Wrapper um
//! MXLs vendorte `lib/fabrics/ofi`-Bibliothek, live über zwei unabhängige
//! MXL-Domains verifiziert (s. Test unten, gleiches Muster wie der
//! manuelle Teil-0-Test: zwei Domains simulieren zwei Hosts).
//!
//! **Grain-Relay (Teil 2, `relay_incoming_grains`/`relay_outgoing_grains`
//! unten):** Teil 1s Moduldoku nahm ursprünglich an, dass dieser Schritt
//! eine `Output`-Trait-/GStreamer-`appsink`/`appsrc`-Anbindung analog
//! `mxl.rs` bräuchte (wie C4→C5) — **das war falsch, korrigiert beim
//! tatsächlichen Umsetzen:** Fabrics operiert unterhalb der GStreamer-
//! Ebene, direkt auf bereits offenen `mxlFlowWriter`/`mxlFlowReader`-
//! Handles. Ein Target schreibt per RDMA direkt in die Speicherregion
//! eines lokalen, ganz normalen MXL-Flows — für jeden **anderen**
//! MXL-Konsumenten (z. B. ein `MxlVideoInput` in einer GStreamer-
//! Pipeline auf demselben Host) ist das von einem lokal geschriebenen
//! Flow nicht unterscheidbar. Es gibt deshalb keinen GStreamer-Bezug in
//! diesem Modul und braucht auch keinen — die "Brücke" ist rein auf
//! MXL-Grain-Ebene (`mxlFlowWriterOpenGrain`/`CommitGrain` auf der
//! Ziel-Seite, `mxlFlowReaderGetGrain` auf der Initiator-Seite), exakt
//! das Muster aus `third_party/mxl/tools/mxl-fabrics-demo/demo.cpp`s
//! `runDiscrete()`. **Bewusste Vereinfachung ggü. dem Referenz-
//! Werkzeug:** immer volle Grains in einem `transfer_grain`-Aufruf,
//! kein Slice-weises Batching über mehrere Aufrufe (s. Doku an
//! `FabricsInitiator::relay_outgoing_grains`).
//!
//! `libmxl.so` wird — wie in [`crate::mxl`] — zur Laufzeit per `dlopen`
//! geladen, hier aber über eine **eigene** bindgen-Anbindung
//! (`build.rs`), nicht über die vendorte `mxl-sys`: deren Wrapper-Header
//! deckt nur `mxl.h`/`flow.h`/... ab, kein `fabrics.h`. Ein zweites
//! `dlopen` derselben `.so` ist unproblematisch (das Betriebssystem
//! cacht/referenzzählt denselben Pfad). Die vendorte `mxl`/`mxl-sys`-
//! Sicherheitsschicht kapselt ihre rohen Handles bewusst privat (kein
//! öffentlicher Zugriff auf `mxlInstance`/`mxlFlowWriter`/`mxlFlowReader`)
//! — dieses Modul öffnet deshalb seine **eigene**, unabhängige
//! `mxlInstance` auf derselben Domain statt eine vom `mxl`-Crate zu
//! teilen; mehrere Instanzen auf derselben Domain sind ein normaler,
//! unterstützter Anwendungsfall (jedes MXL-Werkzeug tut das, z. B.
//! `mxl-info`).
//!
//! **Zwei getrennte `.so`s** (live entdeckt, `build.rs` dort ausführlich
//! begründet): `mxlFabrics*`-Symbole liegen in einer eigenen
//! `libmxl-fabrics.so`, die nicht einmal gegen `libmxl.so` linkt — dieses
//! Modul lädt deshalb `libmxl.so` (Instanz-/Flow-Verwaltung, `core_sys`)
//! und `libmxl-fabrics.so` (Fabrics-API, `sys`) getrennt und castet die
//! opaken Zeigertypen (`mxlInstance`/`mxlFlowWriter`/`mxlFlowReader`) an
//! den Aufrufstellen zwischen beiden bindgen-Durchläufen — sicher, weil
//! beide Seiten exakt denselben zugrundeliegenden C-Zeiger aus derselben
//! Bibliotheksfamilie sehen, nur mit zwei unabhängig generierten
//! (nominell verschiedenen, aber layoutgleichen) Rust-Typen.

mod core_sys {
    #![allow(
        non_camel_case_types,
        non_snake_case,
        non_upper_case_globals,
        dead_code,
        unused_imports,
        unsafe_op_in_unsafe_fn,
        clippy::all
    )]
    include!(concat!(env!("OUT_DIR"), "/mxl_core_bindings.rs"));
}

mod sys {
    #![allow(
        non_camel_case_types,
        non_snake_case,
        non_upper_case_globals,
        dead_code,
        unused_imports,
        unsafe_op_in_unsafe_fn,
        clippy::all
    )]
    include!(concat!(env!("OUT_DIR"), "/fabrics_bindings.rs"));
}

use std::ffi::CString;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// `MXL_FABRICS_API_VERSION` aus `mxl/fabrics.h` (aktuell `0`) — als
/// Rust-Konstante nachgebildet statt per bindgen gezogen: das
/// `#define` ist an keine Funktionssignatur gebunden, `build.rs`s
/// `.allowlist_function`-Einschränkung (nötig, um die beiden getrennten
/// `.so`-Bindings sauber zu trennen, s. Moduldoku) zieht deshalb keine
/// freistehenden Makros mehr automatisch mit.
const FABRICS_API_VERSION: i32 = 0;

/// Provider-Auswahl (`mxlFabricsProvider`) — eigenes Rust-Enum statt der
/// C-API-String-Helfer (`mxlFabricsProviderFromString`), da der Aufrufer
/// hier ohnehin typisiert entscheidet, kein CLI-Parsing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Tcp,
    Verbs,
    Efa,
    Shm,
}

impl Provider {
    fn to_sys(self) -> sys::FabricsProvider {
        match self {
            Provider::Tcp => sys::MXL_FABRICS_PROVIDER_TCP,
            Provider::Verbs => sys::MXL_FABRICS_PROVIDER_VERBS,
            Provider::Efa => sys::MXL_FABRICS_PROVIDER_EFA,
            Provider::Shm => sys::MXL_FABRICS_PROVIDER_SHM,
        }
    }
}

fn status_ok(status: sys::Status) -> Result<(), String> {
    if status == sys::MXL_STATUS_OK {
        Ok(())
    } else {
        Err(format!("MXL-Fabrics-Status {status}"))
    }
}

/// Gegenstück zu [`status_ok`] für `core_sys`-Statuscodes — zwei
/// getrennte Funktionen statt einer generischen, weil `sys::Status` und
/// `core_sys::Status` trotz gleichem C-`mxlStatus`-Ursprungs zwei
/// nominell verschiedene Rust-Typen sind (s. Moduldoku, zwei getrennte
/// bindgen-Durchläufe).
fn status_ok_core(status: core_sys::Status) -> Result<(), String> {
    if status == core_sys::MXL_STATUS_OK {
        Ok(())
    } else {
        Err(format!("MXL-Status {status}"))
    }
}

fn endpoint_config(provider: Provider, node: &str, service: &str) -> (sys::FabricsInterfaceConfig, CString, CString) {
    // `node`/`service` müssen laut fabrics.h mindestens bis zum
    // jeweiligen `setup()`-Aufruf leben ("internally cloned") — die
    // CStrings werden deshalb an den Aufrufer zurückgegeben, der sie bis
    // nach dem setup()-Aufruf am Leben hält (RAII-Falle sonst: ein
    // Rust-Temporary würde vor dem eigentlichen FFI-Aufruf freigegeben).
    let node_c = CString::new(node).expect("node darf kein NUL enthalten");
    let service_c = CString::new(service).expect("service darf kein NUL enthalten");
    let config = sys::FabricsInterfaceConfig {
        version: FABRICS_API_VERSION,
        provider: provider.to_sys(),
        caps: sys::FabricsInterfaceCaps::default(),
        address: sys::FabricsEndpointAddress { node: node_c.as_ptr(), service: service_c.as_ptr() },
        attr: std::ptr::null(),
    };
    (config, node_c, service_c)
}

/// Geladene Fabrics-API + geöffnete `mxlInstance` + `mxlFabricsInstance`
/// für eine Domain — Gegenstück zu [`crate::mxl::MxlContext`], aber für
/// den Fabrics-Pfad. Ein `FabricsRuntime` pro Prozess reicht, Targets und
/// Initiatoren teilen sich dieselbe Instanz (gleiche Begründung wie bei
/// `MxlContext`).
pub struct FabricsRuntime {
    core_api: core_sys::libmxlcore,
    api: sys::libmxlfabrics,
    instance: core_sys::Instance,
    fabrics: sys::FabricsInstance,
}

// Die MXL-API ist auf Instanz-Ebene thread-sicher dokumentiert (gleiche
// Annahme wie `mxl::MxlInstance`, s. dortiger Kommentar) — Target-/
// Initiator-Objekte selbst sind es nicht (s. `FabricsTarget`/
// `FabricsInitiator` unten, analog `FlowWriter`/`FlowReader`).
unsafe impl Send for FabricsRuntime {}
unsafe impl Sync for FabricsRuntime {}

impl FabricsRuntime {
    /// Lädt `libmxl.so` (Instanz-/Flow-Verwaltung) **und** `libmxl-
    /// fabrics.so` (Fabrics-API selbst, eigene Bibliothek, s. Moduldoku)
    /// — beide Namen reichen, sofern über `LD_LIBRARY_PATH` auffindbar,
    /// wie `MxlContext::new` — und öffnet/erstellt sowohl die
    /// `mxlInstance` als auch die darauf aufsetzende `mxlFabricsInstance`
    /// für `domain`.
    pub fn new(domain: &str) -> Result<Arc<Self>, String> {
        let core_api = unsafe { core_sys::libmxlcore::new("libmxl.so") }
            .map_err(|e| format!("libmxl.so laden (fabrics-core): {e}"))?;
        let api = unsafe { sys::libmxlfabrics::new("libmxl-fabrics.so") }
            .map_err(|e| format!("libmxl-fabrics.so laden: {e}"))?;

        let domain_c = CString::new(domain).map_err(|e| format!("Domain-Pfad: {e}"))?;
        let options_c = CString::new("").unwrap();
        let instance = unsafe { core_api.create_instance(domain_c.as_ptr(), options_c.as_ptr()) };
        if instance.is_null() {
            return Err("MXL-Instanz (fabrics): create_instance lieferte NULL".to_string());
        }

        let mut fabrics: sys::FabricsInstance = std::ptr::null_mut();
        let status =
            unsafe { api.fabrics_create_instance(instance as sys::Instance, options_c.as_ptr(), &mut fabrics) };
        if let Err(e) = status_ok(status) {
            unsafe { core_api.destroy_instance(instance) };
            return Err(format!("mxlFabricsCreateInstance: {e}"));
        }

        Ok(Arc::new(FabricsRuntime { core_api, api, instance, fabrics }))
    }

    /// Erstellt einen Fabrics-Target (Empfänger): legt/öffnet einen Flow
    /// per `flow_def` (JSON-Flow-Definition, gleiche Form wie
    /// `mxlCreateFlowWriter`), bindet einen lokalen Endpunkt
    /// (`node`/`service`, providerabhängig — bei `Provider::Tcp` eine
    /// IP+Port-artige Adresse) und liefert neben dem Target dessen
    /// serialisierte Zieladresse (`TargetInfo`-String), die einem
    /// entfernten Initiator übergeben werden muss
    /// ([`FabricsInitiator::add_target`]).
    pub fn create_target(
        self: &Arc<Self>,
        flow_def: &str,
        provider: Provider,
        node: &str,
        service: &str,
    ) -> Result<(FabricsTarget, String), String> {
        let flow_def_c = CString::new(flow_def).map_err(|e| format!("flow_def: {e}"))?;
        let options_c = CString::new("").unwrap();

        let mut writer: core_sys::FlowWriter = std::ptr::null_mut();
        let status = unsafe {
            self.core_api.create_flow_writer(
                self.instance,
                flow_def_c.as_ptr(),
                options_c.as_ptr(),
                &mut writer,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        status_ok(status).map_err(|e| format!("mxlCreateFlowWriter: {e}"))?;
        if writer.is_null() {
            return Err("mxlCreateFlowWriter lieferte NULL".to_string());
        }

        let mut target: sys::FabricsTarget = std::ptr::null_mut();
        let status = unsafe { self.api.fabrics_create_target(self.fabrics, &mut target) };
        if let Err(e) = status_ok(status) {
            unsafe { self.core_api.release_flow_writer(self.instance, writer) };
            return Err(format!("mxlFabricsCreateTarget: {e}"));
        }

        let (interface, _node_c, _service_c) = endpoint_config(provider, node, service);
        let config = sys::FabricsTargetConfig {
            version: FABRICS_API_VERSION,
            interface,
            writer: writer as sys::FlowWriter,
        };

        let mut info: sys::FabricsTargetInfo = std::ptr::null_mut();
        let status = unsafe { self.api.fabrics_target_setup(target, &config, options_c.as_ptr(), &mut info) };
        if let Err(e) = status_ok(status) {
            unsafe {
                self.api.fabrics_destroy_target(self.fabrics, target);
                self.core_api.release_flow_writer(self.instance, writer);
            }
            return Err(format!("mxlFabricsTargetSetup: {e}"));
        }

        let info_string = self.target_info_to_string(info)?;

        Ok((FabricsTarget { runtime: self.clone(), writer, target, info }, info_string))
    }

    /// Erstellt einen Fabrics-Initiator (Sender): öffnet den Flow
    /// `flow_id` zum Lesen, bindet einen lokalen Endpunkt. Ziele werden
    /// danach per [`FabricsInitiator::add_target`] hinzugefügt.
    pub fn create_initiator(
        self: &Arc<Self>,
        flow_id: &str,
        provider: Provider,
        node: &str,
        service: &str,
    ) -> Result<FabricsInitiator, String> {
        let flow_id_c = CString::new(flow_id).map_err(|e| format!("flow_id: {e}"))?;
        let options_c = CString::new("").unwrap();

        let mut reader: core_sys::FlowReader = std::ptr::null_mut();
        let status = unsafe {
            self.core_api
                .create_flow_reader(self.instance, flow_id_c.as_ptr(), options_c.as_ptr(), &mut reader)
        };
        status_ok(status).map_err(|e| format!("mxlCreateFlowReader: {e}"))?;
        if reader.is_null() {
            return Err("mxlCreateFlowReader lieferte NULL".to_string());
        }

        let mut initiator: sys::FabricsInitiator = std::ptr::null_mut();
        let status = unsafe { self.api.fabrics_create_initiator(self.fabrics, &mut initiator) };
        if let Err(e) = status_ok(status) {
            unsafe { self.core_api.release_flow_reader(self.instance, reader) };
            return Err(format!("mxlFabricsCreateInitiator: {e}"));
        }

        let (interface, _node_c, _service_c) = endpoint_config(provider, node, service);
        let config = sys::FabricsInitiatorConfig {
            version: FABRICS_API_VERSION,
            interface,
            reader: reader as sys::FlowReader,
        };

        let status = unsafe { self.api.fabrics_initiator_setup(initiator, &config, options_c.as_ptr()) };
        if let Err(e) = status_ok(status) {
            unsafe {
                self.api.fabrics_destroy_initiator(self.fabrics, initiator);
                self.core_api.release_flow_reader(self.instance, reader);
            }
            return Err(format!("mxlFabricsInitiatorSetup: {e}"));
        }

        Ok(FabricsInitiator { runtime: self.clone(), reader, initiator })
    }

    /// Zwei-Schritt-Größenabfrage, exakt wie `demo.cpp::AppTarget::printInfo`
    /// (bewusst nachgebildet statt neu geraten, s. Moduldoku): erster
    /// Aufruf mit `nullptr` liefert die nötige Puffergröße in
    /// `out_string_size`, zweiter Aufruf füllt den Puffer. Der von der
    /// C-API mitgelieferte NUL-Terminator wird abgeschnitten (`pop_back()`
    /// im C++-Original).
    fn target_info_to_string(&self, info: sys::FabricsTargetInfo) -> Result<String, String> {
        let mut size: usize = 0;
        let status = unsafe { self.api.fabrics_target_info_to_string(info, std::ptr::null_mut(), &mut size) };
        status_ok(status).map_err(|e| format!("mxlFabricsTargetInfoToString (Größe): {e}"))?;

        let mut buf = vec![0u8; size];
        let status =
            unsafe { self.api.fabrics_target_info_to_string(info, buf.as_mut_ptr() as *mut i8, &mut size) };
        status_ok(status).map_err(|e| format!("mxlFabricsTargetInfoToString: {e}"))?;

        if buf.last() == Some(&0) {
            buf.pop();
        }
        String::from_utf8(buf).map_err(|e| format!("TargetInfo ist kein gültiges UTF-8: {e}"))
    }
}

impl Drop for FabricsRuntime {
    fn drop(&mut self) {
        unsafe {
            self.api.fabrics_destroy_instance(self.fabrics);
            self.core_api.destroy_instance(self.instance);
        }
    }
}

/// Empfangsseite (analog `mxl::FlowWriter`, aber remote per RDMA
/// beschrieben statt lokal). Nicht `Sync` (gleiche Begründung wie
/// `mxl::FlowWriter`/`FlowReader`: die MXL-Reader/Writer-Objekte selbst
/// sind nicht thread-sicher), wohl aber `Send`.
pub struct FabricsTarget {
    runtime: Arc<FabricsRuntime>,
    writer: core_sys::FlowWriter,
    target: sys::FabricsTarget,
    info: sys::FabricsTargetInfo,
}

unsafe impl Send for FabricsTarget {}

impl FabricsTarget {
    /// Nicht-blockierende Abfrage: liefert den Grain-Index, falls seit
    /// dem letzten Aufruf ein neuer Grain per RDMA eingetroffen ist.
    pub fn try_read_grain(&self) -> Result<Option<u64>, String> {
        let mut grain_index: u64 = 0;
        let status = unsafe { self.runtime.api.fabrics_target_read_grain_non_blocking(self.target, &mut grain_index) };
        if status == sys::MXL_ERR_NOT_READY {
            return Ok(None);
        }
        status_ok(status).map_err(|e| format!("mxlFabricsTargetReadGrainNonBlocking: {e}"))?;
        Ok(Some(grain_index))
    }

    /// Blockierende Abfrage (Timeout in ms) — treibt zusätzlich
    /// anstehende Verbindungsaufbau-/Fortschritts-Operationen auf der
    /// Target-Seite voran (live entdeckt: `mxl-fabrics-demo`s eigener
    /// Target-Loop nutzt ausschließlich diese Variante, nie die
    /// nicht-blockierende — der Verbindungsaufbau kam in einem Test mit
    /// dieser Methode nie zustande, ohne sie erst gar nicht; die
    /// Initiator-seitigen `make_progress*`-Aufrufe allein reichen nicht,
    /// die Zielseite muss ebenfalls aktiv pollen). `Ok(None)` bei
    /// `MXL_ERR_NOT_READY`/`MXL_ERR_TIMEOUT` (beide "weiter versuchen",
    /// gleiche Behandlung wie in `demo.cpp::runDiscrete`).
    pub fn read_grain(&self, timeout_ms: u16) -> Result<Option<u64>, String> {
        let mut grain_index: u64 = 0;
        let status = unsafe { self.runtime.api.fabrics_target_read_grain(self.target, timeout_ms, &mut grain_index) };
        if status == sys::MXL_ERR_NOT_READY || status == sys::MXL_ERR_TIMEOUT {
            return Ok(None);
        }
        status_ok(status).map_err(|e| format!("mxlFabricsTargetReadGrain: {e}"))?;
        Ok(Some(grain_index))
    }

    /// Treibt die Ziel-Seite dauerhaft an (blockierend — für einen
    /// eigenen Thread gedacht): wartet auf per RDMA eingetroffene Grains
    /// ([`Self::read_grain`]) und macht sie im lokalen Flow für normale
    /// MXL-Leser sichtbar (`OpenGrain`+`CommitGrain`, exakt das Muster
    /// aus `mxl-fabrics-demo`s `runDiscrete`) — danach ist der Grain für
    /// jeden anderen Konsumenten dieses Flows (z. B. ein `MxlVideoInput`)
    /// nicht mehr von einem lokal geschriebenen zu unterscheiden. Endet,
    /// sobald `stop` gesetzt wird oder ein echter (nicht Not-Ready/
    /// Timeout-)Fehler auftritt.
    pub fn relay_incoming_grains(&self, stop: &AtomicBool) -> Result<(), String> {
        while !stop.load(Ordering::Relaxed) {
            if let Some(index) = self.read_grain(200)? {
                self.commit_relayed_grain(index)?;
            }
        }
        Ok(())
    }

    fn commit_relayed_grain(&self, index: u64) -> Result<(), String> {
        let mut grain_info = core_sys::GrainInfo::default();
        let mut payload: *mut u8 = std::ptr::null_mut();
        let status = unsafe {
            self.runtime.core_api.flow_writer_open_grain(self.writer, index, &mut grain_info, &mut payload)
        };
        status_ok_core(status).map_err(|e| format!("mxlFlowWriterOpenGrain({index}): {e}"))?;

        let status = unsafe { self.runtime.core_api.flow_writer_commit_grain(self.writer, &grain_info) };
        status_ok_core(status).map_err(|e| format!("mxlFlowWriterCommitGrain({index}): {e}"))
    }
}

impl Drop for FabricsTarget {
    fn drop(&mut self) {
        unsafe {
            self.runtime.api.fabrics_free_target_info(self.info);
            self.runtime.api.fabrics_destroy_target(self.runtime.fabrics, self.target);
            self.runtime.core_api.release_flow_writer(self.runtime.instance, self.writer);
        }
    }
}

/// Sendeseite (analog `mxl::FlowReader`, aber die gelesenen Grains werden
/// per RDMA an registrierte Ziele geschrieben statt lokal zurückgegeben).
pub struct FabricsInitiator {
    runtime: Arc<FabricsRuntime>,
    reader: core_sys::FlowReader,
    initiator: sys::FabricsInitiator,
}

unsafe impl Send for FabricsInitiator {}

impl FabricsInitiator {
    /// Fügt ein per [`FabricsRuntime::create_target`] erhaltenes
    /// `TargetInfo` als Übertragungsziel hinzu (nicht-blockierend, s.
    /// fabrics.h-Doku — tatsächlicher Verbindungsaufbau passiert erst bei
    /// einem der `make_progress*`-Aufrufe). Das geparste `TargetInfo`
    /// wird sofort nach dem Hinzufügen wieder freigegeben (die C-API
    /// beschreibt keine Übernahme der Eigentümerschaft durch
    /// `AddTarget`, s. `mxlFabricsRemoveTarget`-Doku: Vergleich "das
    /// gleiche" TargetInfo, kein Hinweis auf geteilte Eigentümerschaft).
    pub fn add_target(&self, target_info: &str) -> Result<(), String> {
        let target_info_c = CString::new(target_info).map_err(|e| format!("target_info: {e}"))?;
        let mut info: sys::FabricsTargetInfo = std::ptr::null_mut();
        let status = unsafe { self.runtime.api.fabrics_target_info_from_string(target_info_c.as_ptr(), &mut info) };
        status_ok(status).map_err(|e| format!("mxlFabricsTargetInfoFromString: {e}"))?;

        let status = unsafe { self.runtime.api.fabrics_initiator_add_target(self.initiator, info) };
        let result = status_ok(status).map_err(|e| format!("mxlFabricsInitiatorAddTarget: {e}"));
        unsafe { self.runtime.api.fabrics_free_target_info(info) };
        result
    }

    /// Reiht eine Übertragung für `grain_index` (Slice-Bereich
    /// `[start_slice, end_slice)`) bei allen hinzugefügten Zielen ein —
    /// nicht-blockierend, s. `make_progress_blocking` für den
    /// tatsächlichen Fortschritt.
    pub fn transfer_grain(&self, grain_index: u64, start_slice: u16, end_slice: u16) -> Result<(), String> {
        let status = unsafe {
            self.runtime
                .api
                .fabrics_initiator_transfer_grain(self.initiator, grain_index, start_slice, end_slice)
        };
        status_ok(status).map_err(|e| format!("mxlFabricsInitiatorTransferGrain: {e}"))
    }

    /// Treibt anstehende Übertragungs-/Verbindungsoperationen voran.
    /// `Ok(true)` = alles abgeschlossen, `Ok(false)` = noch Fortschritt
    /// nötig (weiter aufrufen), `Err` = echter Fehler.
    pub fn make_progress_blocking(&self, timeout_ms: u16) -> Result<bool, String> {
        let status = unsafe { self.runtime.api.fabrics_initiator_make_progress_blocking(self.initiator, timeout_ms) };
        if status == sys::MXL_ERR_NOT_READY {
            return Ok(false);
        }
        status_ok(status).map_err(|e| format!("mxlFabricsInitiatorMakeProgressBlocking: {e}"))?;
        Ok(true)
    }

    /// Treibt die Sende-Seite dauerhaft an (blockierend — für einen
    /// eigenen Thread gedacht): liest fortlaufend neue Grains aus dem
    /// lokalen Quell-Flow (blockierendes `GetGrain`, startend bei der
    /// aktuellen Zeit über `GetCurrentIndex`/die Grain-Rate aus
    /// `GetConfigInfo` — exakt das Muster aus `mxl-fabrics-demo`s
    /// `runDiscrete`) und überträgt jeden vollständig per RDMA.
    ///
    /// **Bewusste Vereinfachung ggü. dem Referenz-Werkzeug:** immer der
    /// volle Grain in einem `transfer_grain`-Aufruf (`0..totalSlices`),
    /// kein Slice-weises Batching über mehrere Aufrufe (das
    /// Referenz-Werkzeug staffelt große Grains in
    /// `maxSyncBatchSizeHint`-große Häppchen für niedrigere Latenz bei
    /// sehr großen Payloads). Für moderate Auflösungen/Kanalzahlen
    /// (`docs/END-GOAL-FEATURES.md` §19.3d — Kernel-Bypass wird erst bei
    /// Multi-UHD/hohen Kanalzahlen nötig, dieselbe Grenze gilt hier)
    /// ausreichend; echtes Slice-Batching bleibt ein möglicher, nicht
    /// begonnener Folgeschritt, keine geratene Vereinfachung.
    pub fn relay_outgoing_grains(&self, stop: &AtomicBool) -> Result<(), String> {
        let mut config_info = core_sys::FlowConfigInfo::default();
        let status = unsafe { self.runtime.core_api.flow_reader_get_config_info(self.reader, &mut config_info) };
        status_ok_core(status).map_err(|e| format!("mxlFlowReaderGetConfigInfo: {e}"))?;
        let rate = config_info.common.grainRate;

        let mut index = unsafe { self.runtime.core_api.get_current_index(&rate) };

        while !stop.load(Ordering::Relaxed) {
            let mut grain_info = core_sys::GrainInfo::default();
            let mut payload: *mut u8 = std::ptr::null_mut();
            // 20ms statt der ursprünglich angenommenen 200ms (live
            // entdeckt, nicht geraten): der Test-Flow hat einen
            // Ring-Puffer von nur 5 Grains (`Grain count: 5`, per
            // `mxl-info` schon in früheren Schritten beobachtet) — bei
            // 25 Grains/s deckt ein einziger 200ms-Blockieraufruf exakt
            // die gesamte Ring-Puffer-Tiefe ab. Ein Aufruf, der so lange
            // wartet, sieht seinen angefragten Index deshalb fast
            // zwangsläufig zwischen TOO_EARLY (beim Reinschauen noch
            // nicht committed) und TOO_LATE (beim erneuten Versuch schon
            // aus dem Ring-Puffer verdrängt) hin- und herpendeln, ohne
            // je den schmalen dazwischenliegenden Moment zu treffen —
            // live per Debug-Log bestätigt (ständiges TOO_LATE→TOO_EARLY
            // ohne einen einzigen erfolgreichen Read). Ein kurzer
            // Timeout pro Versuch (deutlich unter einer Grain-Periode)
            // lässt die äußere `while`-Schleife stattdessen mehrfach
            // erneut mit demselben Index anklopfen, bis er bereit ist.
            let status = unsafe {
                self.runtime.core_api.flow_reader_get_grain(self.reader, index, 20_000_000, &mut grain_info, &mut payload)
            };
            if status == core_sys::MXL_ERR_OUT_OF_RANGE_TOO_LATE {
                // Zu weit hinter der Live-Kante zurück — Zeitsprung,
                // exakt wie im Referenz-Werkzeug behandelt.
                index = unsafe { self.runtime.core_api.get_current_index(&rate) };
                continue;
            }
            if status == core_sys::MXL_ERR_OUT_OF_RANGE_TOO_EARLY || status == core_sys::MXL_ERR_TIMEOUT {
                continue;
            }
            if status == core_sys::MXL_ERR_FLOW_INVALID {
                // Dokumentiertes, erwartetes Ereignis (`flow.h`): "the
                // flow's data file has been replaced, for example if a
                // writer restarted and recreated the flow" — kein
                // Programmfehler, sondern "die Quelle ist gerade weg".
                // Sauber beenden statt hart zu scheitern; der Aufrufer
                // (Node-`main.rs`) entscheidet, ob/wann neu gestartet
                // wird, gleiche Verantwortungsteilung wie überall sonst
                // im Node-Contract (kein Selbstheilungsversuch hier).
                return Ok(());
            }
            status_ok_core(status).map_err(|e| format!("mxlFlowReaderGetGrain({index}): {e}"))?;

            self.transfer_grain(index, 0, grain_info.totalSlices)
                .map_err(|e| format!("transfer_grain({index}): {e}"))?;
            loop {
                match self.make_progress_blocking(50) {
                    Ok(true) => break,
                    Ok(false) => {
                        if stop.load(Ordering::Relaxed) {
                            return Ok(());
                        }
                    }
                    Err(e) => return Err(format!("make_progress_blocking nach transfer_grain({index}): {e}")),
                }
            }

            index += 1;
        }
        Ok(())
    }
}

impl Drop for FabricsInitiator {
    fn drop(&mut self) {
        unsafe {
            self.runtime.api.fabrics_destroy_initiator(self.runtime.fabrics, self.initiator);
            self.runtime.core_api.release_flow_reader(self.runtime.instance, self.reader);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Rust-Pendant zum manuellen Kapitel-16-Teil-0-Test
    /// (`docs/decisions.md` Nachtrag 43): zwei unabhängige MXL-Domains
    /// simulieren zwei Hosts, ein echter Flow wird per RDMA über den
    /// `tcp`-Provider von Domain A nach Domain B übertragen — hier ohne
    /// GStreamer, rein auf FFI-Ebene, als Fundament-Nachweis für Teil 1.
    #[test]
    fn transfers_a_real_grain_between_two_domains_over_tcp() {
        let domain_a = std::env::temp_dir().join(format!("omp-fabrics-test-a-{}", std::process::id()));
        let domain_b = std::env::temp_dir().join(format!("omp-fabrics-test-b-{}", std::process::id()));
        std::fs::create_dir_all(&domain_a).unwrap();
        std::fs::create_dir_all(&domain_b).unwrap();

        let flow_id = "5fbec3b1-1b0f-417d-9059-8b94a47197ed";
        // Von Hand statt per serde_json gebaut: Feature `fabrics` bleibt
        // bewusst unabhängig von Feature `mxl` (das `serde_json` erst
        // mitbringt) — echte Video/Audio-Flow-Definitionen für eine
        // spätere GStreamer-Anbindung (Teil 2) werden ohnehin analog
        // `mxl.rs::video_flow_def` gebaut, nicht hier dupliziert.
        // Struktur 1:1 nach third_party/mxl/lib/tests/data/data_flow.json
        // (offizielles MXL-Beispiel für format:data), nur Werte
        // ausgetauscht — kein Rätselraten über MXLs Flow-JSON-Schema
        // (gleiches Vorgehen wie `mxl.rs::video_flow_def`).
        let flow_def = format!(
            r#"{{"id":"{flow_id}","format":"urn:x-nmos:format:data","label":"fabrics-test","media_type":"video/smpte291","grain_rate":{{"numerator":25,"denominator":1}},"tags":{{"urn:x-nmos:tag:grouphint/v1.0":["omp-fabrics-test:Data"]}}}}"#
        );

        let runtime_a = FabricsRuntime::new(domain_a.to_str().unwrap()).expect("runtime A");
        let runtime_b = FabricsRuntime::new(domain_b.to_str().unwrap()).expect("runtime B");

        // Source-Flow in Domain A anlegen (Initiator liest daraus) — ein
        // echter Writer über die reguläre (nicht Fabrics-) API reicht,
        // Fabrics selbst braucht nur einen FlowReader zum Lesen.
        let source_api = unsafe { core_sys::libmxlcore::new("libmxl.so") }.unwrap();
        let domain_a_c = CString::new(domain_a.to_str().unwrap()).unwrap();
        let opts_c = CString::new("").unwrap();
        let source_instance = unsafe { source_api.create_instance(domain_a_c.as_ptr(), opts_c.as_ptr()) };
        assert!(!source_instance.is_null());
        let flow_def_c = CString::new(flow_def.clone()).unwrap();
        let mut source_writer: core_sys::FlowWriter = std::ptr::null_mut();
        let status = unsafe {
            source_api.create_flow_writer(
                source_instance,
                flow_def_c.as_ptr(),
                opts_c.as_ptr(),
                &mut source_writer,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        assert_eq!(status, core_sys::MXL_STATUS_OK, "source flow writer");

        let (target, target_info) = runtime_b
            .create_target(&flow_def, Provider::Tcp, "127.0.0.1", "0")
            .expect("create_target");

        let initiator = runtime_a
            .create_initiator(flow_id, Provider::Tcp, "127.0.0.1", "0")
            .expect("create_initiator");
        initiator.add_target(&target_info).expect("add_target");

        // `mxl-fabrics-demo` läuft Initiator und Target als zwei
        // getrennte Prozesse, jeder mit seiner eigenen Poll-Schleife
        // (Kapitel 16 Teil 0, `docs/decisions.md` Nachtrag 43). Live
        // entdeckt: die Initiator-seitigen `make_progress*`-Aufrufe
        // allein bringen die Verbindung nicht zustande — die Zielseite
        // muss ebenso aktiv pollen (`FabricsTarget::read_grain`, s.
        // dortiger Kommentar), sonst bleibt ihr Endpunkt untätig. Ein
        // Thread pro Seite bildet das nach, statt eine (fehleranfällige)
        // Verschachtelung in einem Single-Thread-Loop zu raten.
        let target_thread = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(20);
            while std::time::Instant::now() < deadline {
                if let Some(idx) = target.read_grain(200).expect("read_grain") {
                    return Some(idx);
                }
            }
            None
        });

        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        let mut connected = false;
        while std::time::Instant::now() < deadline {
            if initiator.make_progress_blocking(100).expect("make_progress (connect)") {
                connected = true;
                break;
            }
        }
        assert!(connected, "Fabrics-Verbindung sollte innerhalb von 15s zustande kommen");

        initiator.transfer_grain(0, 0, 1).expect("transfer_grain");
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while std::time::Instant::now() < deadline {
            if initiator.make_progress_blocking(100).expect("make_progress (transfer)") {
                break;
            }
        }

        let received = target_thread.join().expect("target thread panicked");
        assert_eq!(received, Some(0), "Grain 0 sollte per Fabrics in Domain B angekommen sein");

        unsafe {
            source_api.release_flow_writer(source_instance, source_writer);
            source_api.destroy_instance(source_instance);
        }
        let _ = std::fs::remove_dir_all(&domain_a);
        let _ = std::fs::remove_dir_all(&domain_b);
    }

    /// Kapitel 16 Teil 2 (`docs/decisions.md`): das eigentliche
    /// Grain-Relay statt eines einzelnen manuell übertragenen Grains —
    /// eine echte, extern laufende GStreamer-Quelle (`mxl-gst-testsrc`,
    /// dasselbe bereits für Kapitel 16 Teil 0 manuell verifizierte
    /// Werkzeug, `docs/decisions.md` Nachtrag 43) speist einen Quell-Flow
    /// in Domain A mit echtem, GStreamer-getaktetem Timing. Ein
    /// synthetischer Rust-Produzent-Thread (`get_current_index` +
    /// `OpenGrain`/`CommitGrain` + `sleep(40ms)` in einer Schleife) wurde
    /// zuerst versucht und live verworfen: der reine FFI-Aufrufaufwand
    /// oben auf `sleep` gestapelt drifted gegenüber dem
    /// wall-clock-abgeleiteten "aktuellen Index" spürbar genug, dass der
    /// schmale 5-Grain-Ringpuffer (≈200ms bei 25fps, per `mxl-info`
    /// beobachtet) den Versatz nie absorbieren konnte — jeder Leseversuch
    /// traf `MXL_ERR_OUT_OF_RANGE_TOO_LATE`, nie das schmale
    /// Zeitfenster dazwischen, egal wie kurz der Blockier-Timeout pro
    /// Versuch war. `FabricsInitiator::relay_outgoing_grains`/
    /// `FabricsTarget::relay_incoming_grains` laufen dauerhaft auf
    /// eigenen Threads (genau die Nutzungsweise, für die sie gedacht
    /// sind) und übertragen fortlaufend; ein unabhängiger dritter
    /// `FlowReader` in Domain B (kein Fabrics-Bezug, ein ganz normaler
    /// MXL-Leser — der eigentliche Beweis, dass der relayte Flow von
    /// einem lokal geschriebenen nicht zu unterscheiden ist) bestätigt,
    /// dass Grains ankommen. `#[ignore]`, weil er `mxl-gst-testsrc`
    /// per `$MXL_GST_TESTSRC_BIN` voraussetzt (gleiches Muster wie
    /// `st2110::tests::real_ffmpeg_sends_aes67_audio`); gezielt aufrufen
    /// mit (nach `source deploy/dev/mxl.env`) `cargo test -p
    /// omp-mediaio --features fabrics
    /// fabrics::tests::relays_multiple_grains_continuously_between_two_domains
    /// -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn relays_multiple_grains_continuously_between_two_domains() {
        let testsrc_bin = std::env::var("MXL_GST_TESTSRC_BIN")
            .expect("MXL_GST_TESTSRC_BIN nicht gesetzt (deploy/dev/mxl.env sourcen)");

        let domain_a =
            std::env::temp_dir().join(format!("omp-fabrics-relay-test-a-{}", std::process::id()));
        let domain_b =
            std::env::temp_dir().join(format!("omp-fabrics-relay-test-b-{}", std::process::id()));
        std::fs::create_dir_all(&domain_a).unwrap();
        std::fs::create_dir_all(&domain_b).unwrap();

        // Echte MXL-Beispiel-Flow-Definition (video/v210, 30000/1001fps)
        // statt einer handgebauten `data`-Definition wie im Test oben —
        // `mxl-gst-testsrc` bringt seine eigene Flow-Erzeugung mit und
        // erwartet exakt diese Datei als `-v`-Argument.
        let flow_def_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../third_party/mxl/lib/tests/data/v210_flow.json");
        let flow_def = std::fs::read_to_string(&flow_def_path)
            .unwrap_or_else(|e| panic!("{}: {e}", flow_def_path.display()));
        let flow_id = "5fbec3b1-1b0f-417d-9059-8b94a47197ed";
        let rate = core_sys::Rational { numerator: 30000, denominator: 1001 };

        let runtime_a = FabricsRuntime::new(domain_a.to_str().unwrap()).expect("runtime A");
        let runtime_b = FabricsRuntime::new(domain_b.to_str().unwrap()).expect("runtime B");

        let mut testsrc = std::process::Command::new(&testsrc_bin)
            .args([
                "-d",
                domain_a.to_str().unwrap(),
                "-v",
                flow_def_path.to_str().unwrap(),
                "-p",
                "smpte",
            ])
            .spawn()
            .unwrap_or_else(|e| panic!("spawn {testsrc_bin}: {e}"));

        let (target, target_info) = runtime_b
            .create_target(&flow_def, Provider::Tcp, "127.0.0.1", "0")
            .expect("create_target");

        // `mxl-gst-testsrc` braucht einen Moment, um den Flow anzulegen,
        // bevor ein Initiator ihn zum Lesen öffnen kann — Retry statt
        // einer geratenen festen Wartezeit.
        let initiator = {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            loop {
                match runtime_a.create_initiator(flow_id, Provider::Tcp, "127.0.0.1", "0") {
                    Ok(i) => break i,
                    Err(e) if std::time::Instant::now() < deadline => {
                        let _ = e;
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    Err(e) => {
                        let _ = testsrc.kill();
                        panic!("create_initiator (lief mxl-gst-testsrc an?): {e}");
                    }
                }
            }
        };
        initiator.add_target(&target_info).expect("add_target");

        // Verbindung aufbauen — gleiches Muster wie oben (beide Seiten
        // müssen aktiv pollen, s. `FabricsTarget::read_grain`-Doku): der
        // Zielseiten-Thread läuft nur für ein kurzes, festes Fenster
        // (Teil-1-Test brauchte empirisch <1s, hier großzügig 3s statt
        // erneut 15s, damit ein bereits abgeschlossener Verbindungsaufbau
        // nicht unnötig lange auf diesen Thread wartet).
        let connect_target_thread = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            while std::time::Instant::now() < deadline {
                let _ = target.read_grain(50);
            }
            target
        });

        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        let mut connected = false;
        while std::time::Instant::now() < deadline {
            if initiator.make_progress_blocking(100).expect("make_progress (connect)") {
                connected = true;
                break;
            }
        }
        assert!(connected, "Fabrics-Verbindung sollte innerhalb von 15s zustande kommen");

        let target = connect_target_thread.join().expect("connect thread panicked");

        // Ab hier übernehmen die eigentlichen Relay-Methoden — nicht
        // mehr die manuelle Poll-Schleife der vorherigen Tests.
        let stop_relay = Arc::new(AtomicBool::new(false));
        let initiator_thread = {
            let stop_relay = stop_relay.clone();
            std::thread::spawn(move || initiator.relay_outgoing_grains(&stop_relay))
        };
        let target_thread = {
            let stop_relay = stop_relay.clone();
            std::thread::spawn(move || target.relay_incoming_grains(&stop_relay))
        };

        std::thread::sleep(Duration::from_millis(1500));

        // Unabhängiger dritter Leser in Domain B — ganz normale MXL-API,
        // kein Fabrics-Bezug, exakt das, was z. B. ein `MxlVideoInput`
        // in einer echten Pipeline auf diesem Flow täte.
        let opts_c = CString::new("").unwrap();
        let consumer_api = unsafe { core_sys::libmxlcore::new("libmxl.so") }.unwrap();
        let domain_b_c = CString::new(domain_b.to_str().unwrap()).unwrap();
        let consumer_instance = unsafe { consumer_api.create_instance(domain_b_c.as_ptr(), opts_c.as_ptr()) };
        assert!(!consumer_instance.is_null());
        let flow_id_c = CString::new(flow_id).unwrap();
        let mut consumer_reader: core_sys::FlowReader = std::ptr::null_mut();
        let status = unsafe {
            consumer_api.create_flow_reader(consumer_instance, flow_id_c.as_ptr(), opts_c.as_ptr(), &mut consumer_reader)
        };
        assert_eq!(status, core_sys::MXL_STATUS_OK, "consumer flow reader");

        let now_index = unsafe { consumer_api.get_current_index(&rate) };
        let mut found_recent_grain = false;
        for back in 0..40u64 {
            let idx = now_index.saturating_sub(back);
            let mut grain_info = core_sys::GrainInfo::default();
            let mut payload: *mut u8 = std::ptr::null_mut();
            let status = unsafe {
                consumer_api.flow_reader_get_grain(consumer_reader, idx, 50_000_000, &mut grain_info, &mut payload)
            };
            if status == core_sys::MXL_STATUS_OK {
                found_recent_grain = true;
                break;
            }
        }

        // Reihenfolge bewusst: Relay zuerst stoppen und fertig abwarten,
        // bevor `mxl-gst-testsrc` beendet wird — sonst kann ein gerade
        // noch laufender `flow_reader_get_grain`-Aufruf den Schreiber
        // mitten im Lesen verschwinden sehen (`MXL_ERR_FLOW_INVALID`,
        // oben jetzt zwar sauber statt fatal behandelt, aber die
        // realistischere Reihenfolge ist trotzdem: ein Fabrics-Relay
        // wird beendet, bevor die lokale Quelle abgebaut wird, nicht
        // umgekehrt).
        stop_relay.store(true, Ordering::Relaxed);
        initiator_thread.join().expect("initiator relay thread panicked").expect("relay_outgoing_grains");
        target_thread.join().expect("target relay thread panicked").expect("relay_incoming_grains");
        let _ = testsrc.kill();
        let _ = testsrc.wait();

        unsafe {
            consumer_api.release_flow_reader(consumer_instance, consumer_reader);
            consumer_api.destroy_instance(consumer_instance);
        }

        assert!(
            found_recent_grain,
            "ein unabhängiger dritter Leser sollte mindestens einen kürzlich relayten Grain in Domain B lesen können"
        );

        let _ = std::fs::remove_dir_all(&domain_a);
        let _ = std::fs::remove_dir_all(&domain_b);
    }
}
