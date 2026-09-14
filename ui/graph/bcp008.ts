// AMWA BCP-008 — geteilte Helfer (Statusfarben, Param-Vokabular) für
// alle Stellen, die `monitor.*`-Werte darstellen: das Node-Statuspanel
// im Flow-Editor (flow-canvas.ts, Nachtrag 214) UND das systemweite
// Fleet-Dashboard (ui/shell/health-view.ts). Vorher lebte die
// Farbzuordnung/Erkennung nur in flow-canvas.ts — ausgelagert, damit
// beide Stellen exakt dasselbe Vokabular/dieselben Farben verwenden statt
// zweier Kopien, die auseinanderlaufen könnten.
import type { Descriptor } from "./controls.ts";

// Deckt das gesamte Vokabular aller vier Domains ab (Standard-Status,
// `link`s AllUp/SomeDown/AllDown, `externalSynchronizationStatus`s
// NotUsed) — funktional identische Stufen wie
// `omp_node_sdk::bcp008::HealthLevel`, hier nur auf Farben statt
// Enum-Varianten abgebildet.
export function bcp008StatusColor(status: string): string {
  switch (status) {
    case "Healthy":
    case "AllUp":
      return "#4caf50";
    case "PartiallyHealthy":
    case "SomeDown":
      return "#e0a030";
    case "Unhealthy":
    case "AllDown":
      return "#e74c3c";
    case "Inactive":
    case "NotUsed":
      return "#888";
    default:
      return "#555";
  }
}

// Ob `name` zum BCP-008-Monitor gehört (`omp_node_sdk::bcp008::
// Monitor::param_specs`s `monitor.`-Präfix).
export function isBcp008Param(name: string): boolean {
  return name.startsWith("monitor.");
}

// Erkennung node-typ-unabhängig über das Vorhandensein des
// charakteristischen Param-Namens, den `omp_node_sdk::bcp008::Monitor`
// auf jedem Node setzt, der ihn einbindet — kein Node-"type"-Vergleich.
export function hasBcp008Monitor(descriptor: Descriptor): boolean {
  return descriptor.parameters.some((p) => p.name === "monitor.overallStatus");
}

// Receiver- vs. Sender-Vokabular (`connectionStatus`/`streamStatus` vs.
// `transmissionStatus`/`essenceStatus`) wird am Vorhandensein von
// `monitor.transmissionStatus` erkannt, exakt wie `omp_node_sdk::
// bcp008::Monitor::activity_name`/`content_name` es serverseitig schon
// unterscheiden.
export function isBcp008Sender(descriptor: Descriptor): boolean {
  return descriptor.parameters.some((p) => p.name === "monitor.transmissionStatus");
}

export interface Bcp008Vocabulary {
  activityLabel: string;
  contentLabel: string;
  activityName: string;
  contentName: string;
}

export function bcp008Vocabulary(isSender: boolean): Bcp008Vocabulary {
  return {
    activityLabel: isSender ? "Transmission" : "Connection",
    contentLabel: isSender ? "Essence" : "Stream",
    activityName: isSender ? "transmissionStatus" : "connectionStatus",
    contentName: isSender ? "essenceStatus" : "streamStatus",
  };
}

// Vollständige Param-Namensliste für einen BCP-008-Node (13 Namen,
// unabhängig von Receiver/Sender-Vokabular) — einmal definiert statt an
// jeder Verbrauchsstelle erneut zusammengesetzt.
export function bcp008ParamNames(vocab: Bcp008Vocabulary): string[] {
  return [
    "monitor.overallStatus",
    "monitor.overallStatusMessage",
    "monitor.linkStatus",
    "monitor.linkStatusMessage",
    "monitor.externalSynchronizationStatus",
    "monitor.externalSynchronizationStatusMessage",
    "monitor.synchronizationSourceId",
    `monitor.${vocab.activityName}`,
    `monitor.${vocab.activityName}Message`,
    `monitor.${vocab.contentName}`,
    `monitor.${vocab.contentName}Message`,
    "monitor.statusReportingDelay",
    "monitor.autoResetCountersAndMessages",
  ];
}
