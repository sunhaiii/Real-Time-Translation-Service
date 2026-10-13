'use client'

import { useEffect, useRef, useState } from 'react'

const DOMAIN_OPTIONS = [
  { id: 'bank', name: '은행' },
  { id: 'hospital', name: '병원' },
]

type Term = {
  id: number
  domain: string
  term: string
}

type Props = {
  open: boolean
  initialDomain?: string
  onClose: () => void
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8001'

async function fetchTerms(domain: string): Promise<Term[]> {
  const res = await fetch(`${API_BASE}/api/domains/${domain}/terms`)
  if (!res.ok) throw new Error('용어 목록 조회 실패')
  const data = await res.json()
  return data.terms as Term[]
}

async function postTerm(domain: string, term: string): Promise<Term> {
  const res = await fetch(`${API_BASE}/api/domains/${domain}/terms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ term }),
  })
  if (!res.ok) throw new Error('용어 추가 실패')
  const data = await res.json()
  return { id: data.term_id, domain, term: data.term }
}

async function deleteTerm(domain: string, termId: number): Promise<void> {
  const res = await fetch(`${API_BASE}/api/domains/${domain}/terms/${termId}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error('용어 삭제 실패')
}

export default function WordDictionaryModal({ open, initialDomain = 'bank', onClose }: Props) {
  const [domain, setDomain] = useState(initialDomain)
  const [terms, setTerms] = useState<Term[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newTerm, setNewTerm] = useState('')
  const [adding, setAdding] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setDomain(initialDomain)
      setNewTerm('')
      setError(null)
    }
  }, [open, initialDomain])

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    fetchTerms(domain)
      .then(setTerms)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [open, domain])

  const handleAdd = async () => {
    const term = newTerm.trim()
    if (!term) return
    setAdding(true)
    setError(null)
    try {
      const added = await postTerm(domain, term)
      setTerms((prev) => {
        if (prev.some((t) => t.id === added.id)) return prev
        return [...prev, added].sort((a, b) => a.term.localeCompare(b.term, 'ko'))
      })
      setNewTerm('')
      inputRef.current?.focus()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '추가 실패')
    } finally {
      setAdding(false)
    }
  }

  const handleDelete = async (termId: number) => {
    setError(null)
    try {
      await deleteTerm(domain, termId)
      setTerms((prev) => prev.filter((t) => t.id !== termId))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '삭제 실패')
    }
  }

  if (!open) return null

  const R = 20
  const s = {
    titleFontSize: 1.25 * R,
    labelFontSize: 0.875 * R,
    smallFontSize: 0.75 * R,
    cardPadding: 1.5 * R,
    cardRadius: 1 * R,
    headerMarginBottom: 1.25 * R,
    closePadding: 0.25 * R,
    closeIconSize: 1.5 * R,
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-[110]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="word-dict-modal-title"
      onClick={onClose}
    >
      <div
        className="bg-white shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
        style={{
          fontSize: `${R}px`,
          width: 440,
          maxHeight: '80vh',
          padding: s.cardPadding,
          borderRadius: s.cardRadius,
        }}
      >
        {/* 헤더 */}
        <div className="flex justify-between items-center flex-shrink-0" style={{ marginBottom: s.headerMarginBottom }}>
          <p id="word-dict-modal-title" className="font-semibold text-gray-800" style={{ fontSize: s.titleFontSize }}>
            용어 사전
          </p>
          <button
            type="button"
            onClick={onClose}
            className="rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
            style={{ padding: s.closePadding }}
            aria-label="닫기"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ width: s.closeIconSize, height: s.closeIconSize }}>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 도메인 선택 */}
        <div className="flex items-center gap-3 flex-shrink-0 mb-4">
          <span className="font-medium text-gray-700 flex-shrink-0" style={{ fontSize: s.labelFontSize }}>도메인</span>
          <select
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            className="flex-1 border border-gray-300 rounded-lg text-gray-800 focus:outline-none focus:ring-2 focus:ring-[#13448c] bg-white"
            style={{ fontSize: s.labelFontSize, padding: '6px 10px' }}
          >
            {DOMAIN_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>{opt.name}</option>
            ))}
          </select>
        </div>

        {/* 오류 메시지 */}
        {error && (
          <p className="text-red-600 text-xs mb-3 flex-shrink-0" style={{ fontSize: s.smallFontSize }}>
            {error}
          </p>
        )}

        {/* 용어 목록 */}
        <div className="flex-1 overflow-y-auto min-h-0 border border-gray-200 rounded-lg mb-4">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-gray-400" style={{ fontSize: s.smallFontSize }}>
              불러오는 중...
            </div>
          ) : terms.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-gray-400" style={{ fontSize: s.smallFontSize }}>
              등록된 용어가 없습니다
            </div>
          ) : (
            <ul>
              {terms.map((t, idx) => (
                <li
                  key={t.id}
                  className="flex items-center justify-between px-4 py-2 hover:bg-gray-50"
                  style={{
                    borderBottom: idx < terms.length - 1 ? '1px solid #f3f4f6' : 'none',
                    fontSize: s.labelFontSize,
                  }}
                >
                  <span className="text-gray-800 flex-1 min-w-0 truncate">{t.term}</span>
                  <button
                    type="button"
                    onClick={() => handleDelete(t.id)}
                    className="ml-3 shrink-0 p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                    aria-label={`${t.term} 삭제`}
                    title="삭제"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="16" height="16">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3M4 7h16" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 용어 입력 + 추가 */}
        <div className="flex gap-2 flex-shrink-0">
          <input
            ref={inputRef}
            type="text"
            value={newTerm}
            onChange={(e) => setNewTerm(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAdd() }}
            placeholder="새 용어 입력"
            className="flex-1 border border-gray-300 rounded-lg px-3 text-gray-800 focus:outline-none focus:ring-2 focus:ring-[#13448c]"
            style={{ fontSize: s.labelFontSize, paddingTop: 8, paddingBottom: 8 }}
            disabled={adding}
          />
          <button
            type="button"
            onClick={handleAdd}
            disabled={adding || !newTerm.trim()}
            className="shrink-0 rounded-lg font-medium text-white transition-colors disabled:opacity-50"
            style={{
              backgroundColor: '#13448c',
              fontSize: s.labelFontSize,
              paddingLeft: 20,
              paddingRight: 20,
              paddingTop: 8,
              paddingBottom: 8,
            }}
          >
            추가
          </button>
        </div>
      </div>
    </div>
  )
}
