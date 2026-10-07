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
        _ => {
            eprintln!("Aufruf: mxf-mca dump <datei.mxf>");
            std::process::exit(2);
        }
    }
}
