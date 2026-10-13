'use client'

import ChatBubble from './ChatBubble'

interface Message {
  sender: string
  text: string
  timestamp?: string
}

interface ChatMessageProps {
  message: Message
  isSender: boolean
  /** 'clientScreen' 시 피상담자 화면 말풍선 스타일 */
  variant?: 'default' | 'clientScreen'
  /** 말풍선 글자 크기(px) */
  fontSize?: number
}

export default function ChatMessage({ message, isSender, variant = 'default', fontSize = 16 }: ChatMessageProps) {
  const { text, timestamp } = message
  const timeStr = timestamp
    ? new Date(timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    : undefined

  return (
    <ChatBubble
      text={text}
      isSender={isSender}
      timestamp={timeStr}
      variant={variant}
      fontSize={fontSize}
    />
  )
}
