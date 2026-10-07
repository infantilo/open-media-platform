//! Einfügen von MCA-Labels in bestehende MXF-Dateien (synthetisch und ffmpeg).

use std::path::PathBuf;
use std::process::Command;

use omp_mxf_mca::inject::{Plan, PlanChannel, PlanGroup, inject};
use omp_mxf_mca::keys::label_ul;
use omp_mxf_mca::read::read_file;
use omp_mxf_mca::testkit::{Spec, build};
use omp_mxf_mca::{McaItems, keys, model::SoundDescriptor};

fn tmp(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("omp-mxf-mca-inj-{}-{name}", std::process::id()))
}

fn plan_51() -> Plan {
    let names = [("chL", 1u8), ("chR", 2), ("chC", 3), ("chLFE", 4), ("chLs", 5), ("chRs", 6)];
    let mut plan = Plan::new();
    for (i, (sym, code)) in names.iter().enumerate() {
        plan.channels.push(PlanChannel { index: i, dictionary_id: label_ul(1, *code, 0, 0), symbol: (*sym).into(), name: None, items: McaItems::default(), soundfield_group: Some(0) });
    }
    plan.soundfield_groups.push(PlanGroup {
        dictionary_id: label_ul(2, 1, 0, 0),
        symbol: "sg51".into(),
        name: Some("5.1".into()),
        items: McaItems { content: Some("PRM".into()), use_class: Some("FCMP".into()), ..Default::default() },
        groups: vec![0],
    });
    plan.groups.push(PlanGroup {
        dictionary_id: label_ul(3, 0x20, 1, 0),
        symbol: "MPg".into(),
        name: None,
        items: McaItems { spoken_language: Some("de".into()), spoken_language_attribute: Some("ORIGINAL".into()), ..Default::default() },
        groups: vec![],
    });
    plan
}

fn bare_spec(channels: u32) -> Spec {
    Spec { descriptors: vec![SoundDescriptor { instance_uid: omp_mxf_mca::testkit::uid(0xD0), set_kind: keys::SET_WAVE_AUDIO_DESCRIPTOR, linked_track_id: Some(2), channel_count: channels, labels: vec![] }], ..Default::default() }
}

#[test]
fn injects_into_synthetic_file_and_reads_back_with_shifted_partitions() {
    let src = tmp("syn-src.mxf");
    let dst = tmp("syn-dst.mxf");
    let original = build(&bare_spec(6));
    std::fs::write(&src, &original).unwrap();
    let rep = inject(&src, &dst, &plan_51()).unwrap();
    assert!(!rep.in_place, "ohne Fill-Reserve muss die Datei wachsen");
    assert_eq!((rep.labels_written, rep.partitions_rewritten), (8, 2)); // Header + Footer tragen Metadaten
    let out = std::fs::read(&dst).unwrap();
    assert_eq!(out.len() as u64, original.len() as u64 + rep.bytes_added);
    assert_eq!(rep.bytes_added % 512, 0, "Wachstum in KAG-Vielfachen");
    // Essence-Bytes (alle 0x11) unverändert vorhanden
    let essence = vec![0x11u8; 1000];
    let find = |h: &[u8]| h.windows(1000).position(|w| w == essence.as_slice());
    assert!(find(&original).is_some() && find(&out).is_some(), "Essence-Block muss unverändert erhalten bleiben");
    // Alle Partitionen auffindbar und KAG-ausgerichtet, RIP konsistent
    let mut c = std::io::Cursor::new(out.clone());
    let offs = omp_mxf_mca::mxf::partition_offsets(&mut c, 0).unwrap();
    assert_eq!(offs.len(), 3);
    assert!(offs.iter().all(|o| o % 512 == 0), "{offs:?}");
    let sum = read_file(&dst).unwrap().summarize();
    assert!(sum.issues.is_empty(), "{:?}", sum.issues);
    assert_eq!(sum.channels.len(), 6);
    assert_eq!(sum.channels[3].label.symbol, "chLFE");
    assert_eq!(sum.channels[0].label.items.spoken_language.as_deref(), Some("de"));
    assert_eq!(sum.channels[0].soundfield_group.as_ref().unwrap().symbol, "sg51");
    // Footer-Partition trägt dieselben Link-IDs wie der Header (Wiederholung der Metadaten)
    let _ = (std::fs::remove_file(src), std::fs::remove_file(dst));
}

#[test]
fn second_injection_replaces_and_fits_in_place() {
    let a = tmp("re-a.mxf");
    let b = tmp("re-b.mxf");
    std::fs::write(&a, build(&bare_spec(6))).unwrap();
    inject(&a, &b, &plan_51()).unwrap();
    // Weniger Labels (nur Kanäle ohne Gruppen) → passt in den vorhandenen Platz
    let mut small = Plan::new();
    for i in 0..6 {
        small.channels.push(PlanChannel { index: i, dictionary_id: label_ul(1, (i + 1) as u8, 0, 0), symbol: format!("ch{i}"), name: None, items: McaItems::default(), soundfield_group: None });
    }
    let len_before = std::fs::metadata(&b).unwrap().len();
    let rep = inject(&b, &b, &small).unwrap();
    assert!(rep.in_place, "{rep:?}");
    assert_eq!(std::fs::metadata(&b).unwrap().len(), len_before);
    let sum = read_file(&b).unwrap().summarize();
    assert_eq!(sum.channels.len(), 6);
    assert!(sum.channels.iter().all(|c| c.soundfield_group.is_none()), "alte Gruppen müssen weg sein");
    assert_eq!(sum.channels[5].label.symbol, "ch5");
    let _ = (std::fs::remove_file(a), std::fs::remove_file(b));
}

#[test]
fn invalid_plans_are_rejected_with_clear_messages() {
    let a = tmp("bad.mxf");
    std::fs::write(&a, build(&bare_spec(2))).unwrap();
    let e = inject(&a, &a, &plan_51()).unwrap_err().to_string();
    assert!(e.contains("Kanal 3 existiert nicht"), "{e}");
    let mut p = Plan::new();
    p.channels.push(PlanChannel { index: 0, dictionary_id: label_ul(1, 1, 0, 0), symbol: "5.1".into(), name: None, items: McaItems::default(), soundfield_group: None });
    assert!(inject(&a, &a, &p).unwrap_err().to_string().contains("Tag Symbol"));
    let mut p = Plan::new();
    p.channels.push(PlanChannel { index: 0, dictionary_id: label_ul(1, 1, 0, 0), symbol: "chL".into(), name: None, items: McaItems { content: Some("DX".into()), use_class: Some("FCMP".into()), ..Default::default() }, soundfield_group: None });
    assert!(inject(&a, &a, &p).unwrap_err().to_string().contains("erlaubt nur"));
    let _ = std::fs::remove_file(a);
}

fn have_ffmpeg() -> bool {
    Command::new("ffmpeg").arg("-version").output().is_ok()
}

#[test]
fn ffmpeg_file_stays_decodable_after_injection() {
    if !have_ffmpeg() {
        eprintln!("ffmpeg fehlt — übersprungen");
        return;
    }
    let src = tmp("ff-src.mxf");
    let dst = tmp("ff-dst.mxf");
    let st = Command::new("ffmpeg")
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", "-ac", "6"])
        .args(["-c:v", "mpeg2video", "-c:a", "pcm_s24le", "-f", "mxf"])
        .arg(&src)
        .status()
        .unwrap();
    assert!(st.success());
    let rep = inject(&src, &dst, &plan_51()).unwrap();
    eprintln!("{rep:?}");
    // 1) eigener Parser
    let sum = read_file(&dst).unwrap().summarize();
    assert!(sum.issues.is_empty(), "{:?}", sum.issues);
    assert_eq!(sum.channels.len(), 6);
    // 2) ffmpeg dekodiert die ganze Datei ohne Fehlermeldung, gleiche Frames/Samples wie vorher
    let decode = |p: &PathBuf| {
        let o = Command::new("ffmpeg").args(["-v", "error", "-i"]).arg(p).args(["-f", "framecrc", "-"]).output().unwrap();
        assert!(o.status.success(), "ffmpeg: {}", String::from_utf8_lossy(&o.stderr));
        assert!(o.stderr.is_empty(), "ffmpeg meldet: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).lines().filter(|l| !l.starts_with('#')).map(str::to_string).collect::<Vec<_>>()
    };
    let before = decode(&src);
    let after = decode(&dst);
    assert!(!before.is_empty());
    assert_eq!(before, after, "Essence-Daten müssen bitgleich bleiben (framecrc)");
    // 3) ffprobe liest Streams
    let pr = Command::new("ffprobe").args(["-v", "error", "-show_entries", "stream=codec_name,channels", "-of", "csv=p=0"]).arg(&dst).output().unwrap();
    let txt = String::from_utf8_lossy(&pr.stdout).to_string();
    assert!(txt.contains("pcm_s24le,6"), "{txt}");
    let _ = (std::fs::remove_file(src), std::fs::remove_file(dst));
}
