class PcmCaptureProcessor extends AudioWorkletProcessor {
  // 초기 옵션을 읽어 타깃 샘플레이트, 프레임 크기, 내부 버퍼 상태를 설정한다.
  constructor(options) {
    super()
    const opts = (options && options.processorOptions) || {}
    this.targetSampleRate = opts.targetSampleRate || 16000
    this.inputSampleRate = sampleRate
    this.frameSamples = opts.frameSamples || 1600
    this.buffer = []
    this.bufferedLength = 0
  }

  // 입력 오디오를 목표 샘플레이트로 다운샘플링한다.
  downsample(input) {
    if (this.inputSampleRate === this.targetSampleRate) return input
    const ratio = this.inputSampleRate / this.targetSampleRate
    const output = new Float32Array(Math.max(1, Math.round(input.length / ratio)))
    let outIdx = 0
    let inIdx = 0
    while (outIdx < output.length) {
      const nextInIdx = Math.min(input.length, Math.round((outIdx + 1) * ratio))
      let sum = 0
      let count = 0
      for (let i = inIdx; i < nextInIdx; i++) {
        sum += input[i]
        count++
      }
      output[outIdx] = count ? (sum / count) : 0
      inIdx = nextInIdx
      outIdx++
    }
    return output
  }

  // Float32 오디오 샘플(-1~1)을 16비트 PCM 정수로 변환한다.
  toPcm16(floatData) {
    const pcm = new Int16Array(floatData.length)
    for (let i = 0; i < floatData.length; i++) {
      const sample = Math.max(-1, Math.min(1, floatData[i]))
      pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
    }
    return pcm
  }

  // 프레임 RMS를 계산해 음성 활동 여부를 대략 판정한다.
  getRms(floatData) {
    if (!floatData || floatData.length === 0) return 0
    let sumSquares = 0
    for (let i = 0; i < floatData.length; i++) {
      const sample = floatData[i]
      sumSquares += sample * sample
    }
    return Math.sqrt(sumSquares / floatData.length)
  }

  // 누적 버퍼에서 프레임 단위로 잘라 PCM으로 변환한 뒤 메인 스레드로 전송한다.
  flushFrames() {
    while (this.bufferedLength >= this.frameSamples) {
      const merged = new Float32Array(this.bufferedLength)
      let offset = 0
      for (const chunk of this.buffer) {
        merged.set(chunk, offset)
        offset += chunk.length
      }

      const frame = merged.slice(0, this.frameSamples)
      const rest = merged.slice(this.frameSamples)
      this.buffer = rest.length ? [rest] : []
      this.bufferedLength = rest.length

      const pcm = this.toPcm16(frame)
      const rms = this.getRms(frame)
      this.port.postMessage({
        pcmBuffer: pcm.buffer,
        rms,
      }, [pcm.buffer])
    }
  }

  // 워크렛 처리 루프에서 입력 채널을 받아 다운샘플링 후 프레임 버퍼링을 수행한다.
  process(inputs) {
    const channels = inputs[0]
    if (!channels || !channels[0]) return true
    const mono = channels[0]
    const downsampled = this.downsample(mono)
    this.buffer.push(downsampled)
    this.bufferedLength += downsampled.length
    this.flushFrames()
    return true
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor)
