'use client'

import { useState, FormEvent } from 'react'

interface ChatInputProps {
  onSend: (text: string) => void
  disabled?: boolean
  placeholder?: string
  isRecording?: boolean
  onToggleRecording?: () => void
  /** Figma Component 스타일 적용 여부 (Prompt input: #d7d7d7, #8ab4df, #005cb9) */
  useFigmaStyle?: boolean
  /** 입력창 글자 크기(px). 미지정 시 16 */
  fontSize?: number
}

// Figma Prompt input 디자인 토큰
const FIGMA = {
  border: '#d7d7d7',
  borderFocus: '#8ab4df',
  placeholder: '#bababa',
  sendBg: '#005cb9',
  sendDisabled: '#e5e5e5',
  text: '#121212',
  inputBg: '#ffffff',
}

export default function ChatInput({
  onSend,
  disabled = false,
  placeholder = '무엇이든 물어보세요!',
  isRecording = false,
  onToggleRecording,
  useFigmaStyle = true,
  fontSize = 16,
}: ChatInputProps) {
  const [text, setText] = useState('')

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (text.trim() && !disabled) {
      onSend(text.trim())
      setText('')
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  if (useFigmaStyle) {
    return (
      <form
        onSubmit={handleSubmit}
        className="w-full flex items-center p-3 md:p-4"
        style={{ fontFamily: 'Pretendard, sans-serif' }}
      >
        {/* Figma: 하나의 둥근 입력창 안에 [더보기][입력][마이크][전송] - 높이는 폰트 크기에 비례 */}
        <div
          className="flex-1 flex items-center rounded-full border border-[#d7d7d7] bg-white pl-3 pr-1 gap-0 transition-colors focus-within:border-[#8ab4df]"
          style={{ minHeight: `${fontSize + 36}px` }}
        >
          <button
            type="button"
            className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-[#121212] hover:bg-[#f5f5f5]"
            title="첨부"
            aria-label="첨부"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" />
            </svg>
          </button>
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyPress}
            placeholder={placeholder}
            disabled={disabled}
            className="flex-1 min-w-0 bg-transparent outline-none disabled:cursor-not-allowed px-2 leading-6 placeholder:font-normal placeholder:text-[#bababa] placeholder:text-[20px]"
            style={{ color: FIGMA.text, caretColor: FIGMA.text, fontSize: `${fontSize}px` }}
          />
          {onToggleRecording && (
            <button
              type="button"
              onClick={onToggleRecording}
              className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${
                isRecording ? 'bg-white border border-[#d7d7d7]' : 'bg-transparent'
              }`}
              title={isRecording ? '녹음 중지' : '음성 입력'}
              aria-label={isRecording ? '녹음 중지' : '음성 입력'}
            >
              {isRecording ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" />
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12 14C13.66 14 15 12.66 15 11V5C15 3.34 13.66 2 12 2C10.34 2 9 3.34 9 5V11C9 12.66 10.34 14 12 14Z" fill="currentColor" />
                  <path d="M17 11C17 13.76 14.76 16 12 16C9.24 16 7 13.76 7 11H5C5 14.53 7.61 17.43 11 17.92V21H13V17.92C16.39 17.43 19 14.53 19 11H17Z" fill="currentColor" />
                </svg>
              )}
            </button>
          )}
          {/* 전송 버튼 - Figma: 입력창 안쪽 오른쪽, #005cb9 (원 크기 비율 약간 축소) */}
          <button
            type="submit"
            disabled={!text.trim() || disabled}
            className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-white transition-colors disabled:cursor-not-allowed hover:opacity-90 ml-0.5"
            style={{ backgroundColor: text.trim() ? FIGMA.sendBg : FIGMA.sendDisabled }}
            aria-label="전송"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
            </svg>
          </button>
        </div>
      </form>
    )
  }

  // 기존 스타일 (useFigmaStyle === false)
  const colorClasses = {
    indigo: {
      send: 'bg-indigo-500 hover:bg-indigo-600 focus:ring-indigo-500',
      mic: isRecording
        ? 'bg-red-500 hover:bg-red-600 focus:ring-red-500 animate-pulse'
        : 'bg-indigo-500 hover:bg-indigo-600 focus:ring-indigo-500',
    },
  }
  return (
    <form onSubmit={handleSubmit} className="flex items-end gap-2 p-4 bg-white border-t border-gray-200">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyPress={handleKeyPress}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        className="flex-1 resize-none rounded-xl border border-gray-300 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed"
        style={{ maxHeight: '120px', minHeight: '48px', fontSize: `${fontSize}px` }}
      />
      {onToggleRecording && (
        <button
          type="button"
          onClick={onToggleRecording}
          className={`text-white rounded-xl px-5 py-3 font-semibold focus:outline-none focus:ring-2 focus:ring-offset-2 ${colorClasses.indigo.mic}`}
          title={isRecording ? '녹음 중지' : '음성 녹음 시작'}
        >
          {isRecording ? (
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z" clipRule="evenodd" />
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z" clipRule="evenodd" />
            </svg>
          )}
        </button>
      )}
      <button
        type="submit"
        disabled={!text.trim() || disabled}
        className={`text-white rounded-xl px-6 py-3 font-semibold focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:bg-gray-300 disabled:cursor-not-allowed ${colorClasses.indigo.send}`}
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
          <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
        </svg>
      </button>
    </form>
  )
}
