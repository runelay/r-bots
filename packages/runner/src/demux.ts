export type DemuxSink = (stream: "stdout" | "stderr", chunk: Uint8Array) => void;

export class DockerDemuxer {
  private buffer = new Uint8Array(0);

  constructor(private readonly sink: DemuxSink) {}

  push(chunk: Uint8Array) {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
    while (this.buffer.length >= 8) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
      const size = view.getUint32(4);
      if (this.buffer.length < 8 + size) return;
      const payload = this.buffer.slice(8, 8 + size);
      const kind = this.buffer[0];
      this.buffer = this.buffer.slice(8 + size);
      if (kind === 1 || kind === 0) this.sink("stdout", payload);
      if (kind === 2) this.sink("stderr", payload);
    }
  }
}

export function muxFrame(kind: 1 | 2, payload: Uint8Array) {
  const frame = new Uint8Array(8 + payload.length);
  frame[0] = kind;
  new DataView(frame.buffer).setUint32(4, payload.length);
  frame.set(payload, 8);
  return frame;
}
