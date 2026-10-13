/**
 * 브라우저 Web Speech API를 사용한 실시간 음성 인식
 */

interface SpeechRecognitionResult {
  transcript: string
  isFinal: boolean
}

declare global {
  interface Window {
    SpeechRecognition: any
    webkitSpeechRecognition: any
  }
}

export class BrowserSTT {
  private recognition: any
  private isListening: boolean
  private handlers: {
    onResult: ((result: SpeechRecognitionResult) => void) | null
    onError: ((error: string) => void) | null
    onEnd: (() => void) | null
  }

  constructor() {
    this.recognition = null
    this.isListening = false
    this.handlers = {
      onResult: null,
      onError: null,
      onEnd: null,
    }
  }

  isSupported() {
    return (
      typeof window !== 'undefined' &&
      ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)
    )
  }

  initialize(language = 'ko-KR') {
    if (!this.isSupported()) {
      throw new Error('이 브라우저는 음성 인식을 지원하지 않습니다.')
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    this.recognition = new SpeechRecognition()

    // 설정
    this.recognition.continuous = true // 계속 듣기
    this.recognition.interimResults = true // 중간 결과 받기
    this.recognition.lang = language
    this.recognition.maxAlternatives = 1

    console.log('🎤 브라우저 STT 초기화 완료:', language)

    // 이벤트 핸들러
    this.recognition.onresult = (event: any) => {
      let interimTranscript = ''
      let finalTranscript = ''

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript
        if (event.results[i].isFinal) {
          finalTranscript += transcript
        } else {
          interimTranscript += transcript
        }
      }

      const content = (finalTranscript || interimTranscript).trim()
      if (content.length > 0 && this.handlers.onResult) {
        this.handlers.onResult({
          transcript: finalTranscript || interimTranscript,
          isFinal: finalTranscript.length > 0,
        })
      }
    }

    this.recognition.onerror = (event: any) => {
      console.error('🎤 음성 인식 오류:', event.error)
      if (this.handlers.onError) {
        this.handlers.onError(event.error)
      }
    }

    this.recognition.onend = () => {
      console.log('🎤 음성 인식 종료')
      this.isListening = false
      if (this.handlers.onEnd) {
        this.handlers.onEnd()
      }
    }
  }

  start(language = 'ko-KR') {
    if (!this.recognition) {
      this.initialize(language)
    }

    if (this.isListening) {
      console.log('⚠️ 이미 음성 인식 중')
      return
    }

    try {
      // 언어 변경
      if (this.recognition.lang !== language) {
        this.recognition.lang = language
        console.log('🌍 언어 변경:', language)
      }

      this.recognition.start()
      this.isListening = true
      console.log('🔴 음성 인식 시작')
    } catch (error: any) {
      const msg = error?.message ?? String(error)
      if (msg.includes('already started') || msg.includes('InvalidStateError')) {
        this.isListening = true
        return
      }
      console.error('음성 인식 시작 실패:', error)
    }
  }

  stop() {
    if (this.recognition && this.isListening) {
      this.recognition.stop()
      this.isListening = false
      console.log('⏹️ 음성 인식 중지')
    }
  }

  onResult(callback: (result: SpeechRecognitionResult) => void) {
    this.handlers.onResult = callback
  }

  onError(callback: (error: string) => void) {
    this.handlers.onError = callback
  }

  onEnd(callback: () => void) {
    this.handlers.onEnd = callback
  }
}
