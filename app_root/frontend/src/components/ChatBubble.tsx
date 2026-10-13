'use client'

/**
 * Figma Component 섹션 Chat bubble 스타일
 * - default: 발신 #005cb9/흰색, 수신 #ffffff+#d7d7d7
 * - clientScreen (시안_260205 피상담자): 발신 흰색+#d7d7d7+#323232, 수신 #eff2fe
 * - 최대 너비 500px (Figma chat frame)
 */

export interface ChatBubbleProps {
  /** 메시지 내용 */
  text: string
  /** true: 발신(오른쪽), false: 수신(왼쪽) */
  isSender?: boolean
  /** 타임스탬프 (선택) */
  timestamp?: string
  /** 번역/보조 텍스트 (Figma 135px variant 등) */
  subText?: string
  /** 추가 className */
  className?: string
  /** 'clientScreen' 시 피상담자 화면 스타일 적용 */
  variant?: 'default' | 'clientScreen'
  /** 말풍선 글자 크기(px) */
  fontSize?: number
}

// 발신/수신 말풍선 색상 통일 (상담원·피상담원 동일)
const FIGMA = {
  senderBg: '#005cb9',
  senderText: '#ffffff',
  receiverBg: '#c8cef0',
  text: '#121212',
  subText: '#8f8f8f',
}

export default function ChatBubble({
  text,
  isSender = false,
  timestamp,
  subText,
  className = '',
  variant = 'default',
  fontSize = 16,
}: ChatBubbleProps) {
  const bubbleStyle = {
    backgroundColor: isSender ? FIGMA.senderBg : FIGMA.receiverBg,
    border: 'none',
    color: isSender ? FIGMA.senderText : FIGMA.text,
  }

  return (
    <div
      className={`flex ${isSender ? 'justify-end' : 'justify-start'} mb-4 ${className}`}
      style={{ fontFamily: 'Pretendard, sans-serif' }}
    >
      <div
        className={`flex flex-col max-w-[500px] min-w-0 ${isSender ? 'items-end' : 'items-start'}`}
        style={{ maxWidth: 500 }}
      >
        {/* 말풍선 */}
        <div
          className="relative px-4 py-3 rounded-2xl shadow-sm break-words"
          style={{
            ...bubbleStyle,
            borderBottomRightRadius: isSender ? 4 : 16,
            borderBottomLeftRadius: isSender ? 16 : 4,
            fontSize: `${fontSize}px`,
            lineHeight: `${Math.round(fontSize * 1.5)}px`,
          }}
        >
          <p className="whitespace-pre-wrap break-words">{text}</p>
          {subText && (
            <p
              className="mt-2 pt-2 border-t border-white/20 text-sm"
              style={{ color: isSender ? 'rgba(255,255,255,0.85)' : FIGMA.subText }}
            >
              {subText}
            </p>
          )}
        </div>

        {/* 타임스탬프 */}
        {timestamp && (
          <p
            className="text-xs mt-1 px-1"
            style={{ color: FIGMA.subText }}
          >
            {timestamp}
          </p>
        )}
      </div>
    </div>
  )
}
