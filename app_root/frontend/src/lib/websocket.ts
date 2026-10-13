/**
 * WebSocket 클라이언트 서비스
 * Backend WebSocket과 통신
 */

export class WebSocketService {
  private url: string
  private ws: WebSocket | null
  private reconnectAttempts: number
  private maxReconnectAttempts: number
  private reconnectInterval: number
  private heartbeatInterval: NodeJS.Timeout | null
  private clientId: string
  private pingSeq: number
  private pendingPings: Map<number, number>
  private latencySamples: number[]
  private handlers: {
    onOpen: (() => void) | null
    onClose: (() => void) | null
    onError: ((error: Event) => void) | null
    onMessage: ((data: any) => void) | null
    onLatency: ((snapshot: {
      currentMs: number
      avgMs: number
      p95Ms: number
      sampleCount: number
    }) => void) | null
    onReconnect: ((snapshot: {
      attempt: number
      maxAttempts: number
      atMs: number
    }) => void) | null
  }

  constructor(url: string) {
    this.url = url
    this.ws = null
    this.reconnectAttempts = 0
    this.maxReconnectAttempts = 5
    this.reconnectInterval = 3000
    this.heartbeatInterval = null
    this.clientId = Math.random().toString(36).slice(2, 10)
    this.pingSeq = 0
    this.pendingPings = new Map()
    this.latencySamples = []
    this.handlers = {
      onOpen: null,
      onClose: null,
      onError: null,
      onMessage: null,
      onLatency: null,
      onReconnect: null,
    }
  }

  connect() {
    try {
      this.ws = new WebSocket(this.url)

      this.ws.onopen = () => {
        console.log('✅ WebSocket 연결됨')
        this.reconnectAttempts = 0
        if (this.handlers.onOpen) {
          this.handlers.onOpen()
        }

        // Keepalive ping
        this.startHeartbeat()
      }

      this.ws.onclose = () => {
        console.log('❌ WebSocket 연결 끊김')
        this.stopHeartbeat()

        if (this.handlers.onClose) {
          this.handlers.onClose()
        }

        // 자동 재연결
        this.attemptReconnect()
      }

      this.ws.onerror = (error) => {
        console.error('WebSocket 오류:', error)
        if (this.handlers.onError) {
          this.handlers.onError(error)
        }
      }

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          console.log('📨 메시지 수신:', data.type)

          if (data.type === 'pong') {
            this.handlePong(data)
            return
          }

          if (this.handlers.onMessage) {
            this.handlers.onMessage(data)
          }
        } catch (err) {
          console.error('메시지 파싱 오류:', err)
        }
      }
    } catch (err) {
      console.error('WebSocket 연결 실패:', err)
      this.attemptReconnect()
    }
  }

  disconnect() {
    this.stopHeartbeat()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  sendMessage(data: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
      console.log('📤 메시지 전송:', data.type)
    } else {
      console.error('WebSocket이 연결되지 않았습니다')
    }
  }

  attemptReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++
      console.log(
        `🔄 재연결 시도 ${this.reconnectAttempts}/${this.maxReconnectAttempts}...`
      )
      if (this.handlers.onReconnect) {
        this.handlers.onReconnect({
          attempt: this.reconnectAttempts,
          maxAttempts: this.maxReconnectAttempts,
          atMs: Date.now(),
        })
      }

      setTimeout(() => {
        this.connect()
      }, this.reconnectInterval)
    } else {
      console.error('최대 재연결 시도 횟수 초과')
    }
  }

  startHeartbeat() {
    this.sendPing()
    this.heartbeatInterval = setInterval(() => {
      this.sendPing()
    }, 5000) // 5초마다 ping
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
  }

  // 이벤트 핸들러 등록
  onOpen(callback: () => void) {
    this.handlers.onOpen = callback
  }

  onClose(callback: () => void) {
    this.handlers.onClose = callback
  }

  onError(callback: (error: Event) => void) {
    this.handlers.onError = callback
  }

  onMessage(callback: (data: any) => void) {
    this.handlers.onMessage = callback
  }

  onLatency(callback: (snapshot: {
    currentMs: number
    avgMs: number
    p95Ms: number
    sampleCount: number
  }) => void) {
    this.handlers.onLatency = callback
  }

  onReconnect(callback: (snapshot: {
    attempt: number
    maxAttempts: number
    atMs: number
  }) => void) {
    this.handlers.onReconnect = callback
  }

  // 연결 상태 확인
  isConnected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN
  }

  private sendPing() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const seq = ++this.pingSeq
    const sentAtMs = Date.now()
    this.pendingPings.set(seq, sentAtMs)
    this.ws.send(JSON.stringify({
      type: 'ping',
      seq,
      client_id: this.clientId,
      sent_at_ms: sentAtMs,
    }))
  }

  private handlePong(data: any) {
    if (typeof data?.client_id === 'string' && data.client_id !== this.clientId) return
    const seq = Number(data?.seq)
    if (!Number.isFinite(seq)) return
    const sentAtMs = this.pendingPings.get(seq)
    if (!sentAtMs) return
    this.pendingPings.delete(seq)

    const currentMs = Math.max(0, Date.now() - sentAtMs)
    this.latencySamples.push(currentMs)
    if (this.latencySamples.length > 60) {
      this.latencySamples.shift()
    }
    const sorted = [...this.latencySamples].sort((a, b) => a - b)
    const avgMs = Math.round(sorted.reduce((acc, value) => acc + value, 0) / Math.max(1, sorted.length))
    const p95Index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.95))
    const p95Ms = Math.round(sorted[p95Index] ?? currentMs)
    if (this.handlers.onLatency) {
      this.handlers.onLatency({
        currentMs,
        avgMs,
        p95Ms,
        sampleCount: sorted.length,
      })
    }
  }
}
