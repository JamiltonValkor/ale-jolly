'use client'

import Link from 'next/link'
import { Fragment, type ReactNode } from 'react'

function internalProposalPath(value: string): string | null {
  try {
    const url = new URL(value, 'https://saleads.ai')
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    if (
      !local &&
      (url.protocol !== 'https:' ||
        !['saleads.ai', 'dev.saleads.ai'].includes(url.hostname))
    )
      return null
    if (local && !['http:', 'https:'].includes(url.protocol)) return null
    return /^\/(es|en)\/dashboard\/agent-landings\/[a-f0-9-]{36}$/i.test(
      url.pathname
    )
      ? url.pathname
      : null
  } catch {
    return null
  }
}

/** Render only our proposal links. Other text remains literal, never HTML or executable Markdown. */
export function LandingMessageText({ text }: { text: string }) {
  const parts: ReactNode[] = []
  let from = 0
  for (const match of text.matchAll(/\[([^\n]*?)\]\(([^)\s]+)\)/g)) {
    const path = internalProposalPath(match[2])
    if (!path || match.index === undefined || match[1].length > 240) continue
    parts.push(text.slice(from, match.index))
    parts.push(
      <Link
        key={match.index}
        href={path}
        className="text-sa-text-link focus-visible:ring-sa-border-focus rounded underline focus-visible:ring-2"
      >
        {match[1].replace(/\\([\\[\]()*_`<>])/g, '$1')}
      </Link>
    )
    from = match.index + match[0].length
  }
  parts.push(text.slice(from))
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>{part}</Fragment>
      ))}
    </>
  )
}
