// Schmale Schnittstelle zu einem MIDI-Anschluss (ein Ein-/Ausgangspaar). Web MIDI, Simulator und Tests erfüllen sie.

export interface MidiPort {
  readonly name: string;
  /** Bytes zum Gerät. Muss nie werfen (Gerät weg → still verwerfen). */
  send(bytes: number[]): void;
  /** Bytes vom Gerät (ganze Pakete des Transports, nicht notwendig ganze Nachrichten). Liefert die Abmeldefunktion. */
  onData(cb: (bytes: number[]) => void): () => void;
  close(): void;
}
