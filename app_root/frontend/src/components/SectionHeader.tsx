'use client'

/**
 * Figma Component 섹션 .section_header 스타일
 * - 배경 #323232, 제목 Bold 48px #fff, 설명 Regular 19px #fff
 */
interface SectionHeaderProps {
  title: string
  description?: string
  icon?: React.ReactNode
  className?: string
}

export default function SectionHeader({ title, description, icon, className = '' }: SectionHeaderProps) {
  return (
    <header
      className={`bg-[#323232] text-white px-10 pt-10 pb-6 ${className}`}
      style={{ fontFamily: 'Pretendard, sans-serif' }}
    >
      <div className="flex items-start gap-5">
        {icon && (
          <div className="w-12 h-12 flex-shrink-0 flex items-center justify-center rounded-lg bg-[#2d2d2d]">
            {icon}
          </div>
        )}
        <div>
          <h2 className="text-[48px] font-bold leading-[1.4] text-white" style={{ lineHeight: '67.2px' }}>
            {title}
          </h2>
          {description && (
            <p className="mt-3 text-[19px] font-normal leading-[1.5] text-white" style={{ lineHeight: '28.5px' }}>
              {description}
            </p>
          )}
        </div>
      </div>
    </header>
  )
}
