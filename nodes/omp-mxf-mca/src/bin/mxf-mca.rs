//! Entwickler-Werkzeug: `mxf-mca dump <datei.mxf>` gibt die MCA-Labels als JSON aus.

use std::path::Path;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.as_slice() {
        [_, cmd, file] if cmd == "dump" => match omp_mxf_mca::read::read_file(Path::new(file)) {
            Ok(mca) => println!("{}", serde_json::to_string_pretty(&mca.summarize()).unwrap()),
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        },
        [_, cmd, src, dst, plan] if cmd == "inject" => {
            let run = || -> Result<_, Box<dyn std::error::Error>> {
                let plan = omp_mxf_mca::inject::Plan::from_json(&std::fs::read_to_string(plan)?)?;
                Ok(omp_mxf_mca::inject::inject(Path::new(src), Path::new(dst), &plan)?)
            };
            match run() {
                Ok(r) => println!("{r:?}"),
                Err(e) => {
                    eprintln!("{e}");
                    std::process::exit(1);
                }
            }
        }
        _ => {
            eprintln!("Aufruf: mxf-mca dump <datei.mxf> | mxf-mca inject <quelle.mxf> <ziel.mxf> <plan.json>");
            std::process::exit(2);
        }
    }
}
