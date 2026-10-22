class OpenFlowCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.armed = false;
    this.pending = new Float32Array(2048);
    this.used = 0;
    this.port.onmessage = (event) => {
      if (event.data === "start") {
        this.armed = true;
        this.used = 0;
        return;
      }
      if (event.data === "stop") {
        this.armed = false;
        this.flush();
        this.port.postMessage("done");
      }
    };
  }

  flush() {
    if (!this.used) return;
    const frame = this.pending.slice(0, this.used);
    this.used = 0;
    this.port.postMessage(frame);
  }

  process(inputs) {
    if (!this.armed) return true;
    const channel = inputs[0] && inputs[0][0];
    if (!channel || !channel.length) return true;
    let offset = 0;
    while (offset < channel.length) {
      const space = this.pending.length - this.used;
      const take = Math.min(space, channel.length - offset);
      this.pending.set(channel.subarray(offset, offset + take), this.used);
      this.used += take;
      offset += take;
      if (this.used === this.pending.length) this.flush();
    }
    return true;
  }
}

registerProcessor("openflow-capture", OpenFlowCapture);
