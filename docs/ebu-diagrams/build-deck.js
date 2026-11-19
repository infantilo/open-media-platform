// Builds the EBU presentation (dark corporate design) from the dark diagram PNGs.
//
//   THEME=dark python3 generate.py                      -> dark/*.svg
//   (render each dark/*.svg to PNG at 3840x2160 into $DECK_IMG, plus the three screenshots, hero bg "bg-title.png")
//   npm install pptxgenjs ; DECK_IMG=... DECK_OUT=... node build-deck.js
//
// Slide text is native (editable); the diagrams are full-slide pictures with alt text.
const path = require("path");
const pptxgen = require("pptxgenjs");
const IMG = process.env.DECK_IMG || path.join(__dirname, "deck-img");
const OUT = process.env.DECK_OUT || path.join(__dirname, "OMP-EBU-Presentation.pptx");
const SKILL = process.env.PPTX_SKILL_DIR; // directory of the pptx skill (for applyTheme)

const THEME = {
  name: "OMP Studio Dark",
  headFontFace: "Calibri",
  bodyFontFace: "Calibri",
  colors: {
    dk1: "080C16", lt1: "EAF0FA", dk2: "172033", lt2: "93A1BA",
    accent1: "19D3F3", accent2: "A45CFF", accent3: "4D9BFF", accent4: "19C3B0", accent5: "FB8C00", accent6: "EF5350",
    hlink: "19D3F3", folHlink: "A45CFF",
  },
};

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.333 x 7.5 in
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
pres.title = "OpenMediaPlatform: an open proof of concept for the EBU Dynamic Media Facility";
pres.author = "OpenMediaPlatform";
const C = pres.SchemeColor; // text1 = dk1 (dark), background1 = lt1 (light): a dark theme uses text1 as the page colour
const BG = C.text1, FG = C.background1, DIM = C.background2, SURF = C.text2;

pres.defineSlideMaster({
  title: "CONTENT",
  background: { color: BG },
  objects: [
    { text: { text: "OpenMediaPlatform  ·  open proof of concept for the EBU Dynamic Media Facility", options: { x: 0.6, y: 7.03, w: 9, h: 0.3, fontSize: 10, color: DIM, margin: 0 } } },
    { placeholder: { options: { name: "title", type: "title", x: 0.6, y: 0.4, w: 12.1, h: 0.85, fontSize: 36, bold: true, color: FG, align: "left", valign: "middle", margin: 0 }, text: "" } },
  ],
  slideNumber: { x: 12.1, y: 7.03, w: 0.7, h: 0.3, fontSize: 10, color: DIM, align: "right" },
});
pres.defineSlideMaster({ title: "FULL", background: { color: BG } });

const SECTIONS = {};
function section(title) { if (!SECTIONS[title]) { pres.addSection({ title }); SECTIONS[title] = 1; } return title; }

function diagram(file, alt, notes, sec) {
  const s = pres.addSlide({ masterName: "FULL", sectionTitle: section(sec) });
  s.addImage({ path: path.join(IMG, file), x: 0, y: 0, w: 13.333, h: 7.5, altText: alt, objectName: "Diagram" });
  s.addNotes(notes);
  return s;
}
function content(title, sec, notes) {
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: section(sec) });
  s.addText(title, { placeholder: "title" });
  s.addNotes(notes);
  return s;
}
function card(s, x, y, w, h, accent, name) {
  s.addShape(pres.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.12, fill: { color: SURF }, line: { color: accent, width: 1.25, transparency: 40 }, objectName: name || "Card" });
}

// screenshot slide: framed picture on the left (width w, aspect ar), explanation on the right
function shotSlide(title, sec, notes, file, ar, w, acc, alt, name, head, points) {
  const s = content(title, sec, notes);
  const h = w / ar, x0 = 0.6, y0 = 1.5;
  s.addShape(pres.ShapeType.roundRect, { x: x0, y: y0, w: w + 0.1, h: h + 0.1, rectRadius: 0.06, fill: { color: SURF }, line: { color: acc, width: 1, transparency: 50 } });
  s.addImage({ path: path.join(IMG, file), x: x0 + 0.05, y: y0 + 0.05, w, h, altText: alt, objectName: name });
  const tx = x0 + w + 0.4, tw = 13.333 - 0.6 - tx;
  s.addText(head, { isTextBox: true, x: tx, y: y0, w: tw, h: 0.9, fontSize: 22, bold: true, color: acc, margin: 0, valign: "top" });
  s.addText(points.map((t, k) => ({ text: t, options: { bullet: true, breakLine: k < points.length - 1 } })),
    { isTextBox: true, x: tx, y: y0 + 1.0, w: tw, h: 4.3, fontSize: 15, color: FG, margin: 0, valign: "top", paraSpaceAfter: 8 });
  return s;
}

// ---------------------------------------------------------------- 1 title
{
  const s = pres.addSlide({ masterName: "FULL", sectionTitle: section("Opening") });
  s.addImage({ path: path.join(IMG, "bg-title.png"), x: 0, y: 0, w: 13.333, h: 7.5, altText: "", objectName: "Background" });
  s.addText("OPEN MEDIA PLATFORM", { isTextBox: true, x: 0.8, y: 0.75, w: 8, h: 0.4, fontSize: 14, bold: true, color: C.accent1, charSpacing: 8, margin: 0 });
  s.addText([
    { text: "Open", options: { color: FG } }, { text: " · ", options: { color: DIM } },
    { text: "Modular", options: { color: C.accent1 } }, { text: " · ", options: { color: DIM } },
    { text: "Interoperable", options: { color: C.accent2 } },
  ], { isTextBox: true, x: 0.8, y: 2.0, w: 11.8, h: 1.3, fontSize: 48, bold: true, margin: 0, valign: "middle", objectName: "Title" });
  s.addText("An open proof of concept for the EBU Dynamic Media Facility: software-defined, standards-based, and verifiable step by step.",
    { isTextBox: true, x: 0.8, y: 3.55, w: 9.2, h: 1.2, fontSize: 22, color: DIM, margin: 0, valign: "top" });
  const tags = ["EBU DMF", "MXL", "AMWA NMOS", "SMPTE ST 2110"];
  tags.forEach((t, i) => {
    const x = 0.8 + i * 2.35;
    s.addShape(pres.ShapeType.roundRect, { x, y: 5.45, w: 2.15, h: 0.6, rectRadius: 0.1, fill: { color: SURF }, line: { color: C.accent1, width: 1, transparency: 50 } });
    s.addText(t, { isTextBox: true, x, y: 5.45, w: 2.15, h: 0.6, fontSize: 16, bold: true, color: FG, align: "center", valign: "middle", margin: 0 });
  });
  s.addText("Presentation to the EBU  ·  November 2026", { isTextBox: true, x: 0.8, y: 6.6, w: 8, h: 0.35, fontSize: 14, color: DIM, margin: 0 });
  s.addNotes("Opening. This is a working proof of concept, not a product. It shows that the open building blocks (EBU DMF as the blueprint, MXL for media exchange, AMWA NMOS for control, SMPTE ST 2110 for IP media) can be assembled into a running facility, and it is honest about where it stops. Everything on the following slides is backed by a check that can be repeated.");
}

// ---------------------------------------------------------------- 2 agenda
{
  const s = content("What we will show", "Opening", "Six parts. We start with the idea and the building bricks, then the architecture, then how it behaves when things fail. After that come the proof points (numbers, screens, standards and how each was checked), an honest look at scope and at the Kubernetes question, and how the project is built. We end with open points and what we would like from this community. The deck can be shortened by skipping the Kubernetes and process slides.");
  const rows = [
    ["Vision and building bricks", "Why a dynamic facility, and how open standards fit together like bricks"],
    ["Architecture", "Control plane and media plane, choosing the media path, joining third-party products"],
    ["Resilience", "Failure handling and make-before-break migration of a live function"],
    ["Proof points", "Numbers, operator consoles, and the standards with their checks"],
    ["Honest scope", "What it is and is not, Kubernetes comparison, how it is built"],
    ["Open points and asks", "What is still open and where we would like your help"],
  ];
  rows.forEach(([a, b], i) => {
    const y = 1.55 + i * 0.88;
    const acc = i % 2 ? C.accent2 : C.accent1;
    s.addShape(pres.ShapeType.ellipse, { x: 0.6, y: y + 0.06, w: 0.62, h: 0.62, fill: { color: SURF }, line: { color: acc, width: 1.5 } });
    s.addText(String(i + 1), { isTextBox: true, x: 0.6, y: y + 0.06, w: 0.62, h: 0.62, fontSize: 20, bold: true, color: acc, align: "center", valign: "middle", margin: 0 });
    s.addText(a, { isTextBox: true, x: 1.5, y: y, w: 4.6, h: 0.74, fontSize: 22, bold: true, color: FG, valign: "middle", margin: 0 });
    s.addText(b, { isTextBox: true, x: 6.2, y: y, w: 6.5, h: 0.74, fontSize: 16, color: DIM, valign: "middle", margin: 0 });
  });
}

// ---------------------------------------------------------------- 3 why
{
  const s = content("Why this proof of concept", "Vision and building bricks", "Broadcast facilities are still built as chains of appliances: one function per box, fixed capacity, vendor-specific control, and 1+1 hardware for every redundancy. The DMF vision replaces that with functions that start where capacity exists and share media over open interfaces. Our question was practical: can the published open standards alone carry a whole working facility, and what is missing when they do? Adapt the wording of the question to your own motivation.");
  const cols = [
    ["Today", C.accent6, "Appliance chains", ["One function per box", "Fixed capacity, SDI cabling", "Vendor-specific control", "1+1 hardware for every redundancy"]],
    ["The idea", C.accent1, "Dynamic media facility", ["Functions start where capacity exists", "Media shared in memory or over IP", "One control model for all", "Redundancy by software where it matters"]],
    ["Our question", C.accent2, "Do the standards carry it?", ["MXL, NMOS and ST 2110 as the only contracts", "Find and document the gaps", "Everything runnable and checkable", "Open source, no lock-in"]],
  ];
  cols.forEach(([tag, acc, head, items], i) => {
    const x = 0.6 + i * 4.15;
    card(s, x, 1.55, 3.95, 5.1, acc);
    s.addText(tag.toUpperCase(), { isTextBox: true, x: x + 0.3, y: 1.8, w: 3.4, h: 0.35, fontSize: 14, bold: true, color: acc, charSpacing: 4, margin: 0 });
    s.addText(head, { isTextBox: true, x: x + 0.3, y: 2.2, w: 3.4, h: 0.9, fontSize: 24, bold: true, color: FG, valign: "top", margin: 0 });
    s.addText(items.map((t, k) => ({ text: t, options: { bullet: true, breakLine: k < items.length - 1 } })),
      { isTextBox: true, x: x + 0.3, y: 3.3, w: 3.4, h: 3.1, fontSize: 16, color: FG, valign: "top", margin: 0, paraSpaceAfter: 8 });
  });
}

diagram("6-why-open-contract.png", "From appliance chains to orchestrated functions: what broadcasters and vendors gain from a common contract", "What a broadcaster and a vendor each gain from the common contract. Open exchange, self-describing nodes, replaceable parts and elastic resources. The point for vendors: one integration surface instead of one per customer, and they can start small.", "Vision and building bricks");
diagram("1-architecture-overview.png", "Layered architecture: operator layer, control plane, media functions, media exchange", "The whole system in four layers. The orchestrator knows no vendor and no node type, only standards. Media never passes through the control plane. Media exchange is MXL on one host, MXL Fabrics over RDMA between hosts, ST 2110 on the LAN, and SRT or RIST for wide-area links.", "Vision and building bricks");
diagram("13-standards-as-bricks.png", "Standards as building bricks: EBU, AMWA, MXL, SMPTE and open-source parts, plus our own bricks for the gaps", "The core method: we do not invent what a standard already defines. Blue are EBU parts, teal AMWA NMOS, pink the MXL project, violet SMPTE, IEEE and AES, grey other open specifications and libraries. The amber bricks are ours, and they sit exactly where no standard covers the need: operating, orchestrating, bridging and hosting.", "Vision and building bricks");

diagram("2-control-vs-media-plane.png", "Control plane with three orchestrators and replicated state, separate from media flowing between hosts", "Control and media are separate. Three orchestrators with one leader and replicated state steer the system. Media flows node to node on the hosts. Losing an orchestrator never interrupts a picture, because nodes keep running and are re-adopted.", "Architecture");
diagram("7-media-path-selection.png", "Decision flow for choosing the media path between two functions", "One rule set, applied at placement time: same host uses MXL shared memory, same RDMA-capable segment uses MXL Fabrics, same LAN with multicast and PTP uses ST 2110, otherwise SRT or RIST through a gateway. The fallback is soft: if acceleration is not available the connection falls back automatically. The RDMA path is implemented on the software provider; validation on RoCEv2 hardware is still planned.", "Architecture");
diagram("5-third-party-integration.png", "How a third-party MXL or DMF-compatible product joins with the same contract", "A third-party product joins with the same contract as our own nodes: register through NMOS IS-04, describe itself through IS-12 and IS-14, and exchange media over MXL or ST 2110. Three levels of depth, A to C. Level A already appears in the registry and can be routed. Level C adds state hand-over and a media-ready signal so the product can be moved and failed over without a gap.", "Architecture");

diagram("3-failure-handling.png", "Failure handling for node crash, hot standby, planned move and host failure", "Four cases: a node crash is restarted with back-off and state re-applied, a hot standby switches near-instantly, a planned move is make-before-break, and a host failure relocates roles by placement rules after the telemetry has been silent. The principle is to move work rather than stop the programme.", "Resilience");
diagram("4-make-before-break.png", "Timeline of a make-before-break migration of a live node", "The old instance keeps producing until the new one reports media-ready. Only then is the connection switched, and the old instance stopped last. If any step fails the new instance is torn down and the old one carries on, so there is never a half-state on air.", "Resilience");

// ---------------------------------------------------------------- numbers
{
  const s = content("The proof points in numbers", "Proof points", "These are measured from the repository, not estimates. Lines of code include tests and are counted without vendored third-party code. The test count is the number of test functions across Go, Rust and Deno. The IS-05 figure is the result of the official AMWA NMOS test tool, which runs in continuous integration on every push. The commit count runs from the start on 3 July 2026.");
  const st = [
    ["45", "node types in the catalog", C.accent1],
    ["430k", "lines of code, including tests", C.accent2],
    ["3.9k", "automated tests (Go, Rust, Deno)", C.accent3],
    ["17", "standards and recommendations implemented", C.accent4],
    ["62 / 62", "official AMWA IS-05 test checks, no accepted exceptions", C.accent1],
    ["1,385", "commits since 3 July 2026", C.accent2],
  ];
  st.forEach(([n, l, acc], i) => {
    const x = 0.6 + (i % 3) * 4.15, y = 1.55 + Math.floor(i / 3) * 2.6;
    card(s, x, y, 3.95, 2.4, acc);
    s.addText(n, { isTextBox: true, x: x + 0.3, y: y + 0.3, w: 3.35, h: 1.1, fontSize: 48, bold: true, color: acc, margin: 0, valign: "middle" });
    s.addText(l, { isTextBox: true, x: x + 0.3, y: y + 1.45, w: 3.35, h: 0.8, fontSize: 16, color: FG, margin: 0, valign: "top" });
  });
}

// ---------------------------------------------------------------- screenshots
shotSlide("Flow editor: the facility as a graph", "Proof points",
  "The flow editor is the engineering view: a catalogue of node types on the left, the running nodes on the canvas, with their live picture. Workflows group nodes into one startable object. This view is for engineers; operators work in the console instead. Shown for a small workflow with three test-pattern sources and a video mixer.",
  "flow-editor-live.png", 1600 / 1000, 7.9, C.accent3,
  "Flow editor with a node catalogue and the nodes of a running workflow with live pictures", "Screenshot flow editor",
  "Engineering view",
  ["Catalogue of node types, searchable, with resource hints", "Running nodes with live picture and their ports", "Workflows group nodes and start or stop them as one", "Engineers wire and configure; operators only operate"]);
shotSlide("One console, several nodes", "Proof points",
  "The operator console for one workflow: video mixer, audio mixer, playout automation with its playlist, recorder and two players, each as a movable and resizable tile. The operator sees only the nodes the role bindings allow, and has no graph or wiring. Each node brings its own console fragment, so a new function adds its own control surface without changing the shell. The red row in the playlist is a test item whose file is missing; the system flags it as a warning instead of hiding it.",
  "operator-console-multi.png", 1920 / 1080, 8.6, C.accent1,
  "Operator console with video mixer, players, playout automation, recorder and audio mixer as tiles", "Screenshot operator console",
  "Operator console: workflow as tiles",
  ["Video mixer, audio mixer, playout automation, recorder and players side by side", "Rights per role: the operator sees only what is assigned", "Each node ships its own console, loaded at runtime", "Playlist with live status; a missing file is flagged in red"]);
{
  const s = content("Audio: the studio mixer in the browser", "Proof points", "The operator consoles are web pages. Each node ships its own console fragment and the shell loads them at runtime, so a new function brings its own control surface. This is the studio audio mixer console with dynamics, equaliser, aux and routing. These are working screens from the proof of concept, shown on a lab system.");
  s.addShape(pres.ShapeType.roundRect, { x: 0.6, y: 1.5, w: 12.13, h: 4.95, rectRadius: 0.08, fill: { color: SURF }, line: { color: C.accent1, width: 1, transparency: 50 } });
  s.addImage({ path: path.join(IMG, "audiomischer-konsole2.png"), x: 0.915, y: 1.62, w: 11.5, h: 11.5 * 792 / 1920, altText: "Studio audio mixer console in the browser with channel strips, gate, compressor, equaliser and routing", objectName: "Screenshot audio mixer" });
  s.addText("Studio audio mixer: dynamic channels, gate, compressor, four-band equaliser, aux and routing", { isTextBox: true, x: 0.6, y: 6.55, w: 12.1, h: 0.35, fontSize: 14, color: DIM, margin: 0 });
}
shotSlide("Live control: the video mixer", "Proof points",
  "The video mixer bank with programme and preview buses. With thumbnails switched on, every source button shows a live preview picture, here from three test-pattern sources. Cut and auto transitions with selectable durations, transition types, paternoster, PIP scenes and presets. It is a node like any other: it describes its own parameters through the control framework, and its console is loaded into the shell at runtime. Shown on a lab system with test-pattern sources.",
  "videomixer-thumbnails.png", 940 / 472, 8.4, C.accent2,
  "Video mixer console with live thumbnails on every source button, programme and preview buses, cut and auto, transition types and PIP scenes", "Screenshot video mixer",
  "Video mixer with live thumbnails",
  ["Programme and preview buses; each source shows a live picture", "Cut and auto with 6, 12, 25 or 50 frames", "Mix, wipe, slide, push and paternoster transitions", "PIP scenes, keyer (DSK) and saved presets", "Lab system with three test-pattern sources"]);
shotSlide("Planning: workflows against host capacity", "Proof points",
  "The scheduler plans workflows on a day, week or month view against the measured capacity of each host. Planned demand comes from measured profiles per node type; bottlenecks are marked before they happen, and workflows without a fixed host are placed automatically on the host with the most headroom, excluding hosts in maintenance. This is the planning side of the same control plane.",
  "scheduler-woche.png", 1400 / 837, 8.0, C.accent1,
  "Weekly scheduler with workflows and planned resource use per host", "Screenshot scheduler",
  "Scheduler",
  ["Day, week and month view; drag to plan or move a workflow", "Planned CPU, RAM and network per host from measured profiles", "Bottlenecks shown in red before they happen", "Workflows without a fixed host are placed automatically", "Hosts in maintenance are left out"]);
shotSlide("File intake: check before air", "Proof points",
  "File intake control is the front door for material. A file is imported, checked automatically against a QC profile, and then reviewed by a person who accepts, assigns or rejects it. The report lists every finding with its severity; here a loudness error and a duration mismatch are flagged against the broadcast profile, while 17 other checks pass. The same module offers review and conform, and a separate stream ingest schedules live recordings against recorder capacity. The screenshot is from a lab system with a test file.",
  "file-intake-qc.png", 1500 / 1050, 6.9, C.accent4,
  "File intake control: QC report with loudness error, duration mismatch and passed checks", "Screenshot file intake",
  "Automatic QC, human decision",
  ["Import, then automatic QC against a selectable profile", "21 checks: container, video, audio, sync, loudness, black, freeze, silence", "Findings filterable by category and severity; export as JSON or CSV", "Take over or assign, then review and conform", "Stream ingest: scheduled live recordings against recorder capacity"]);
// monitoring
{
  const s = content("Monitoring, support and diagnosis", "Proof points", "Operating tools are part of the platform, not an add-on. The self-test lights up amber or red and lists each problem with a code and a plain what-to-do. The health page shows media availability per node over 24 hours, with outages and measured rates, and reports AMWA BCP-008 status where nodes support it. The signal path page follows a chain backwards from any destination and names the first fault. A support bundle collects logs, versions and measurements into one file, with trend curves and snapshots for later analysis. Screens show a lab system; the red and amber entries come from offline demo hosts.");
  const iw = 5.95;
  const items = [["support-selftest.png", 920, 415, 0.6, C.accent6, "Self-test with error codes and what to do"], ["health-availability.png", 1010, 310, 6.78, C.accent4, "Media availability per node over 24 hours"]];
  items.forEach(([f, w, h, x, acc, cap]) => {
    const ih = iw * h / w;
    s.addShape(pres.ShapeType.roundRect, { x: x - 0.05, y: 1.45, w: iw + 0.1, h: ih + 0.1, rectRadius: 0.05, fill: { color: SURF }, line: { color: acc, width: 1, transparency: 50 } });
    s.addImage({ path: path.join(IMG, f), x, y: 1.5, w: iw, h: ih, altText: cap, objectName: "Screenshot " + cap });
    s.addText(cap, { isTextBox: true, x, y: 1.5 + ih + 0.12, w: iw, h: 0.3, fontSize: 12, color: DIM, margin: 0 });
  });
  const cards = [
    ["Self-test", "Traffic light with codes and plain what-to-do steps", C.accent6],
    ["Signal path", "Follows the chain backwards and names the first fault", C.accent1],
    ["Health", "Availability, outages and measured rates; AMWA BCP-008", C.accent4],
    ["Support bundle", "Logs, versions, trends and snapshots in one file", C.accent2],
  ];
  cards.forEach(([h, t, acc], i) => {
    const x = 0.6 + i * 3.07;
    card(s, x, 5.5, 2.95, 1.3, acc);
    s.addText(h, { isTextBox: true, x: x + 0.2, y: 5.6, w: 2.6, h: 0.35, fontSize: 16, bold: true, color: acc, margin: 0 });
    s.addText(t, { isTextBox: true, x: x + 0.2, y: 5.98, w: 2.6, h: 0.75, fontSize: 13, color: FG, margin: 0, valign: "top" });
  });
}

// ---------------------------------------------------------------- standards table
{
  const s = content("Standards and how each was checked", "Proof points", "Each row names the check that was run. Only the AMWA rows with the official test tool are a third-party verification. For the others we say exactly what was done, and what was not: for example, ST 2110 has been checked against real traffic but not by an external conformance test, and the cybersecurity recommendation is an honest assessment, not a certification.");
  const H = (t) => ({ text: t, options: { bold: true, color: C.accent1, fill: { color: SURF }, fontSize: 14 } });
  const cell = (t, b) => ({ text: t, options: { color: FG, bold: !!b, fontSize: 14 } });
  const rows = [
    [H("Standard"), H("What it is used for"), H("How it was checked")],
    ["NMOS IS-04 / IS-05", "Discovery, connection management", "Official AMWA test tool in CI; IS-05: 62 of 62 checks"],
    ["NMOS IS-12 / IS-14", "Self-described control", "Every node describes itself; no node-type code in the orchestrator"],
    ["BCP-007-03", "MXL as an NMOS transport", "Own schema checks (specification too new for an official suite)"],
    ["MXL v1.1.0", "Zero-copy media exchange on one host", "Run against MXL's own reference tools, down to pixels"],
    ["ST 2110-20/30, AES67", "Video and audio over IP", "SDP per specification, live against real RTP; no external conformance test"],
    ["EBU R 128, R 37, R 103", "Loudness, lip-sync, signal gamut", "Live measurement with alarms; shared test vectors"],
    ["EBU R 143", "Cybersecurity of vendor products", "Own assessment: 8 met, 17 partly, 2 open of 28; not a certification"],
  ].map((r, i) => i === 0 ? r : r.map((t, k) => cell(t, k === 0)));
  s.addTable(rows, { x: 0.6, y: 1.5, w: 12.13, colW: [2.9, 3.7, 5.53], fontFace: "Calibri", border: { type: "solid", color: SURF, pt: 1 }, fill: { color: BG }, valign: "middle", margin: [0.06, 0.1, 0.06, 0.1], rowH: [0.45, 0.62, 0.62, 0.62, 0.62, 0.62, 0.62, 0.62] });
}

// ---------------------------------------------------------------- scope
diagram("11-poc-scope-vs-commercial.png", "What this proof of concept is and is not, compared with large commercial products", "Where we stand, honestly. It is strong for learning, experiments and development with MXL, NMOS and ST 2110, and for small productions and lab set-ups. It is not a drop-in replacement for a certified 24/7 plant: there is no vendor behind it, no support or indemnity, and several paths have not yet been run on real hardware. Commercial products are ahead in breadth, maturity and support. We are ahead in openness and in how easy it is to experiment.", "Honest scope");
diagram("8-kubernetes-question-gap.png", "Kubernetes and a media facility ask different questions", "Why we do not simply adopt Kubernetes. Its scheduler asks about CPU, memory, readiness and replicas. A live facility has to know who exchanges media with whom, what is on air, and whether the replacement can take over without a visible glitch. Three ways to close the gap: Kubernetes as is, Kubernetes plus our own media layer, or a media-aware orchestrator. We chose the third, and keep Kubernetes possible as a runner.", "Honest scope");
diagram("9-kubernetes-comparison.png", "Honest comparison of Kubernetes and the OpenMediaPlatform approach", "An honest comparison. Kubernetes is clearly ahead in general scheduling, ecosystem and maturity, and in scale and elasticity. We are ahead in media awareness, in moving a running function without a gap, in same-host media exchange and, modestly, in operating effort for a small facility. For networks with multicast, PTP and RDMA the answer is: Kubernetes can do it, with effort.", "Honest scope");
diagram("10-kubernetes-outlook.png", "What our choice costs, the triggers to revisit it, and how the design keeps the door open", "What our choice costs: we maintain scheduler, updater and hardening ourselves, and large-scale behaviour is unproven. Triggers that would make us revisit: dozens of cloud hosts with autoscaling, a customer standardising on Kubernetes, or pods sharing memory and media devices as a routine feature. The node contract stays identical, only the runner below it changes.", "Honest scope");
diagram("12-how-it-is-built.png", "How the project is built: documents, one step per session, verification, and scale", "How it is built. The development is AI-assisted under written rules: the owner decides, the assistant implements, and every step must be checkable. The rules, the architecture, the step plan with its checks and the decision log live in separate documents, because a model reads a limited window and because they change at different speeds. One step per session, and nothing counts as done until the listed checks pass.", "Honest scope");

// ---------------------------------------------------------------- Sender POC
{
  const s = content("Next: the broadcaster proof of concept, Q1 2027", "Open points and asks", "The next step is a proof of concept with a broadcaster, planned for the first quarter of 2027. The set-up is two clusters of three machines each: three control servers, three virtualised media hosts and bare-metal gateways, connected by two 100G switches and a GNSS-locked PTP grandmaster. It runs on Rocky Linux and without internet access. The aim is to show ST 2110 without SDI cards, one time chain from the grandmaster down to virtual hosts, RDMA between hosts with an ST 2110 fallback, and ST 2022-7 redundancy. Be honest about the status: Rocky, real RoCEv2 hardware, ST 2110 on the real network cards and the time accuracy inside virtual machines have not been verified yet; switch PTP support and card drivers are still to be confirmed in writing. The ten phases are planned so that each ends with a measurable check. Confirm the year and the scope with the Sender contact before presenting.");
  const cols = [
    ["Planned set-up", C.accent1, ["2 clusters of 3 machines: control, virtualised media hosts, bare-metal gateways", "Two 100G switches, GNSS-locked PTP grandmaster", "Rocky Linux, no internet: offline installation", "Sources and sinks: ST 2110, NDI, MADI"]],
    ["What it should show", C.accent2, ["ST 2110 without SDI cards, in software on 100G network cards", "One time chain from the grandmaster to virtual hosts", "RDMA between hosts, with ST 2110 as fallback", "ST 2022-7 red/blue redundancy"]],
    ["Not yet verified", C.accent5, ["Rocky Linux with the full stack", "RoCEv2 on real hardware, ST 2110 on real cards", "Time accuracy inside virtual machines", "Switch PTP support and drivers: to be confirmed in writing"]],
  ];
  cols.forEach(([h, acc, items], i) => {
    const x = 0.6 + i * 4.15;
    card(s, x, 1.5, 3.95, 3.55, acc);
    s.addText(h, { isTextBox: true, x: x + 0.25, y: 1.62, w: 3.5, h: 0.45, fontSize: 20, bold: true, color: acc, margin: 0 });
    s.addText(items.map((t, k) => ({ text: t, options: { bullet: true, breakLine: k < items.length - 1 } })),
      { isTextBox: true, x: x + 0.25, y: 2.15, w: 3.5, h: 2.8, fontSize: 14, color: FG, margin: 0, valign: "top", paraSpaceAfter: 6 });
  });
  const ph = ["Rocky reference", "Offline hardening", "Time lab", "Sync monitoring", "ST 2110 spike", "2110 \u2194 MXL gateway", "ST 2022-7", "MADI and NDI audio", "Virtual media hosts", "On-site preparation"];
  s.addText("TEN PHASES, EACH WITH A MEASURABLE CHECK", { isTextBox: true, x: 0.6, y: 5.25, w: 8, h: 0.3, fontSize: 12, bold: true, color: DIM, charSpacing: 3, margin: 0 });
  ph.forEach((t, i) => {
    const x = 0.6 + (i % 5) * 2.45, y = 5.65 + Math.floor(i / 5) * 0.65;
    s.addShape(pres.ShapeType.roundRect, { x, y, w: 2.33, h: 0.52, rectRadius: 0.08, fill: { color: SURF }, line: { color: C.accent1, width: 1, transparency: 60 } });
    s.addText([{ text: "P" + (i + 1) + "  ", options: { bold: true, color: C.accent1 } }, { text: t, options: { color: FG } }], { isTextBox: true, x, y, w: 2.33, h: 0.52, fontSize: 12, align: "center", valign: "middle", margin: 0 });
  });
}

// ---------------------------------------------------------------- open points
{
  const s = content("Open points and next steps", "Open points and asks", "We would rather name the gaps ourselves. Hardware: several paths, including RDMA over real RoCEv2 and the capture cards, have been verified only in software. Certification: no formal conformance or security certification yet. Legal review of patents, trademarks and licence obligations is pending. The right-hand column is the intention: it stays a proof of concept and an open test bed. There is no plan for a product release, and it is not meant to replace professional products.");
  const L = ["Real hardware: RDMA over RoCEv2 and capture cards verified in software only", "No formal conformance or security certification yet", "Legal review pending: patents, trademarks, licence obligations", "Scale: sized for tens of hosts, no long soak test", "Gaps: no NDI gateway, no proprietary audio-over-IP"];
  const R = ["Stay a proof of concept: no product release is planned, and it is not meant to replace professional products", "Serve as an open test bed for MXL, NMOS and ST 2110 experiments", "Validate RDMA and capture paths on real hardware with partners", "Interop session with other MXL and NMOS implementations", "Feed findings and gaps back to the DMF community"];
  [["Open today", C.accent5, L], ["Where we go from here", C.accent1, R]].forEach(([head, acc, items], i) => {
    const x = 0.6 + i * 6.15;
    card(s, x, 1.55, 5.98, 5.1, acc);
    s.addText(head, { isTextBox: true, x: x + 0.35, y: 1.8, w: 5.3, h: 0.5, fontSize: 24, bold: true, color: acc, margin: 0 });
    s.addText(items.map((t, k) => ({ text: t, options: { bullet: true, breakLine: k < items.length - 1 } })),
      { isTextBox: true, x: x + 0.35, y: 2.5, w: 5.3, h: 3.9, fontSize: 18, color: FG, valign: "top", margin: 0, paraSpaceAfter: 12 });
  });
}
{
  const s = content("What we would like from this community", "Open points and asks", "Four concrete asks. Review: does the architecture match the intent of the DMF, and where does it diverge? Test: an interoperability session between independent MXL and NMOS implementations. Host: partners with real hardware to validate the paths we could only check in software. Shape: help define what a conformance profile for a DMF node could look like. These are suggestions to be adjusted before the talk.");
  const asks = [
    ["Review", "Does the architecture match the intent of the DMF, and where does it differ?", C.accent1],
    ["Test", "Interop sessions between independent MXL and NMOS implementations", C.accent2],
    ["Host", "Partners with RoCEv2 networks and capture hardware for real validation", C.accent3],
    ["Shape", "Help define a conformance profile for a DMF node and its integration levels", C.accent4],
  ];
  asks.forEach(([h, t, acc], i) => {
    const x = 0.6 + (i % 2) * 6.15, y = 1.55 + Math.floor(i / 2) * 2.7;
    card(s, x, y, 5.98, 2.5, acc);
    s.addText(h, { isTextBox: true, x: x + 0.35, y: y + 0.3, w: 5.3, h: 0.7, fontSize: 32, bold: true, color: acc, margin: 0 });
    s.addText(t, { isTextBox: true, x: x + 0.35, y: y + 1.1, w: 5.3, h: 1.2, fontSize: 18, color: FG, margin: 0, valign: "top" });
  });
}

// ---------------------------------------------------------------- closing
{
  const s = pres.addSlide({ masterName: "FULL", sectionTitle: section("Open points and asks") });
  s.addImage({ path: path.join(IMG, "bg-title.png"), x: 0, y: 0, w: 13.333, h: 7.5, altText: "", objectName: "Background" });
  s.addText("OPEN MEDIA PLATFORM", { isTextBox: true, x: 0.8, y: 0.75, w: 8, h: 0.4, fontSize: 14, bold: true, color: C.accent1, charSpacing: 8, margin: 0 });
  s.addText([{ text: "Thank you", options: { color: FG } }], { isTextBox: true, x: 0.8, y: 2.2, w: 11.8, h: 1.2, fontSize: 56, bold: true, margin: 0, valign: "middle", objectName: "Title" });
  s.addText("Questions and discussion", { isTextBox: true, x: 0.8, y: 3.5, w: 9, h: 0.6, fontSize: 24, color: C.accent1, margin: 0 });
  s.addText("Open source under the Apache License 2.0. Built on EBU DMF, MXL, AMWA NMOS and SMPTE ST 2110. Not affiliated with or endorsed by any standards body or vendor.",
    { isTextBox: true, x: 0.8, y: 4.5, w: 9.5, h: 1.2, fontSize: 16, color: DIM, margin: 0, valign: "top" });
  s.addNotes("Close with the three messages: it works and is checkable, it is open, and it is honest about its limits. Then the asks. Add contact details and the repository address here before presenting; they were left out on purpose.");
}

(async () => {
  await pres.writeFile({ fileName: OUT });
  if (SKILL) { const { applyTheme } = require(path.join(SKILL, "scripts/apply_theme.js")); await applyTheme(OUT, THEME); }
  console.log("written", OUT);
})();
