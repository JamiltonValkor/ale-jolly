'use client'

import { useState } from 'react'
import { useFormatter, useNow, useTranslations } from 'next-intl'
import { ChatsCircle, Package } from '@phosphor-icons/react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { META_UI_FONT_CLASS } from '@/shared/meta-ui'
import { cn } from '@/lib/utils'
import type { TeamMember } from '../../../lib/meta-experience/team-model'
import {
  META_TEAM_NAME_MAX,
  useMetaTeamNamesStore,
} from '../../../store/use-meta-team-names-store'
import { MuseSprite } from './muse-sprite'
import { useMemberLine } from './team-desk'
import { useMemberName } from './use-member-name'
import styles from './team-office.module.css'

export interface TeamMemberActions {
  stopped?: boolean
  /** Abre Conversar con el texto escrito. */
  onAsk: (prompt: string) => void
  onTalk: () => void
  onOpenStock: () => void
}

interface Props extends TeamMemberActions {
  member: TeamMember
  businessId: string
  onClose: () => void
}

function NameForm({
  member,
  businessId,
}: Pick<Props, 'member' | 'businessId'>) {
  const t = useTranslations('metaExperience.office.sheet')
  const saved = useMetaTeamNamesStore(
    state => state.names[businessId]?.[member.role] ?? ''
  )
  const rename = useMetaTeamNamesStore(state => state.rename)
  const reset = useMetaTeamNamesStore(state => state.reset)
  const [draft, setDraft] = useState(saved)
  return (
    <form
      className={styles.nameForm}
      onSubmit={event => {
        event.preventDefault()
        rename(businessId, member.role, draft)
      }}
    >
      <label className={styles.nameLabel}>
        {t('nameLabel')}
        <input
          value={draft}
          maxLength={META_TEAM_NAME_MAX}
          placeholder={t('namePlaceholder')}
          onChange={event => setDraft(event.target.value)}
        />
      </label>
      <div className={styles.nameActions}>
        <button type="submit" className="mu-btn" disabled={!draft.trim()}>
          {t('save')}
        </button>
        {saved ? (
          <button
            type="button"
            className="mu-btn mu-btn-ghost"
            onClick={() => {
              reset(businessId, member.role)
              setDraft('')
            }}
          >
            {t('reset')}
          </button>
        ) : null}
      </div>
      <p className={styles.nameNote}>{t('nameNote')}</p>
    </form>
  )
}

function Actions({ member, businessId, ...props }: Omit<Props, 'onClose'>) {
  const t = useTranslations('metaExperience.office')
  const name = useMemberName(businessId, member.role)
  const role = t(`roles.${member.role}.role`)
  if (member.state === 'waiting' && member.role === 'bodega')
    return (
      <button
        type="button"
        className="mu-btn mu-btn-p"
        onClick={props.onOpenStock}
      >
        <Package size={16} weight="light" aria-hidden />
        {t('sheet.openStock')}
      </button>
    )
  const answer = member.state === 'waiting' && member.role === 'ale'
  return (
    <button
      type="button"
      className="mu-btn mu-btn-p"
      aria-disabled={props.stopped || undefined}
      onClick={() => {
        if (props.stopped) return
        if (answer) props.onTalk()
        else props.onAsk(t('sheet.askPrompt', { role, name }))
      }}
    >
      <ChatsCircle size={16} weight="light" aria-hidden />
      {t(answer ? 'sheet.answerAle' : 'sheet.ask')}
    </button>
  )
}

/** La ficha de un agente: quién es, qué hace, ponerle nombre y pedirle algo. */
export function TeamMemberDialog({
  member,
  businessId,
  onClose,
  ...props
}: Props) {
  const t = useTranslations('metaExperience.office')
  const format = useFormatter()
  const now = useNow()
  const name = useMemberName(businessId, member.role)
  const line = useMemberLine(member)
  const since = member.task?.since
  return (
    <Dialog open onOpenChange={open => (open ? undefined : onClose())}>
      <DialogContent
        data-meta-ui=""
        className={cn(
          META_UI_FONT_CLASS,
          'max-w-[440px] gap-0 rounded-[30px] border border-[rgba(255,255,255,0.1)] p-7'
        )}
      >
        <div className={styles.sheetHead}>
          <MuseSprite role={member.role} state={member.state} size={96} />
          <div className="min-w-0">
            <span className="mu-label">{t(`roles.${member.role}.role`)}</span>
            <DialogTitle className="text-[24px] leading-[1.15] font-semibold tracking-[-0.025em]">
              {name}
            </DialogTitle>
            <span className={styles.deskState} data-state={member.state}>
              <span className="mu-dot" aria-hidden />
              {t(`states.${member.state}`)}
            </span>
          </div>
        </div>
        <DialogDescription className="mt-4 text-[14.5px] leading-[1.55] text-[var(--mu-muted)]">
          {t(`roles.${member.role}.about`)}
        </DialogDescription>
        <dl className={styles.sheetFacts}>
          <div>
            <dt className="mu-label">{t('sheet.now')}</dt>
            <dd>
              {line ?? t('sheet.nothing')}
              {since ? (
                <span className={styles.sheetSince}>
                  {' '}
                  ·{' '}
                  {t('sheet.since', {
                    time: format.relativeTime(new Date(since), now),
                  })}
                </span>
              ) : null}
            </dd>
          </div>
          {member.lastDone ? (
            <div>
              <dt className="mu-label">{t('sheet.lastDone')}</dt>
              <dd>{member.lastDone}</dd>
            </div>
          ) : null}
        </dl>
        <NameForm key={member.role} member={member} businessId={businessId} />
        <div className={styles.sheetActions}>
          <button type="button" className="mu-btn" onClick={onClose}>
            {t('sheet.close')}
          </button>
          <Actions member={member} businessId={businessId} {...props} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
