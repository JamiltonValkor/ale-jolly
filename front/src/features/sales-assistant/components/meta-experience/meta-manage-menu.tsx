'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { DotsThree, Play, Power, Trash } from '@phosphor-icons/react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { META_UI_FONT_CLASS } from '@/shared/meta-ui'
import { cn } from '@/lib/utils'
import {
  useDeleteSalesAssistantMutation,
  useStartSalesAssistantMutation,
  useStopSalesAssistantMutation,
} from '../../hooks/use-sales-assistant-mutations'
import { salesAssistantErrorKey } from '../../lib/error-messages'
import { MetaConfirmDialog } from './meta-confirm-dialog'

type Confirming = 'deactivate' | 'delete' | null

interface Props {
  view: 'ready' | 'stopped' | 'preparing'
  className?: string
}

const ITEM =
  'flex cursor-pointer items-center gap-2.5 rounded-[12px] px-3 py-2.5 text-[14px] font-medium outline-none data-[highlighted]:bg-[rgba(255,255,255,0.055)]'

/**
 * «Administrar»: desactivar, reactivar y borrar, fuera del camino diario.
 * Desactivar y borrar piden confirmación; reactivar no pierde nada.
 */
export function MetaManageMenu({ view, className }: Props) {
  const t = useTranslations('metaExperience.header')
  const tLife = useTranslations('salesAssistant.lifecycle')
  const tErrors = useTranslations('salesAssistant')
  const stop = useStopSalesAssistantMutation()
  const start = useStartSalesAssistantMutation()
  const remove = useDeleteSalesAssistantMutation()
  const [confirming, setConfirming] = useState<Confirming>(null)
  const error = stop.error ?? start.error ?? remove.error
  const mutation = confirming === 'delete' ? remove : stop
  const dialog = confirming ? `${confirming}Dialog` : 'deactivateDialog'
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      {error ? (
        <span role="alert" className="mu-chip" data-tone="mal">
          {tErrors(salesAssistantErrorKey(error))}
        </span>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger
          className="mu-btn mu-btn-ghost"
          aria-label={t('manageLabel')}
        >
          <DotsThree size={18} weight="bold" aria-hidden />
          <span className="max-[599px]:sr-only">{t('manage')}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          data-meta-ui=""
          className={cn(
            META_UI_FONT_CLASS,
            'min-w-[240px] rounded-[18px] border border-[rgba(255,255,255,0.11)] bg-[var(--mu-menu)] p-1.5'
          )}
        >
          {view === 'stopped' ? (
            <DropdownMenuItem className={ITEM} onSelect={() => start.mutate()}>
              <Play size={17} weight="light" aria-hidden />
              {tLife('reactivate')}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              className={ITEM}
              onSelect={() => setConfirming('deactivate')}
            >
              <Power size={17} weight="light" aria-hidden />
              {tLife('deactivate')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            className={cn(ITEM, 'text-[var(--mu-peligro)]')}
            onSelect={() => setConfirming('delete')}
          >
            <Trash size={17} weight="light" aria-hidden />
            {tLife('delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <MetaConfirmDialog
        open={confirming !== null}
        onOpenChange={open => (open ? undefined : setConfirming(null))}
        title={tLife(`${dialog}.title`)}
        description={tLife(`${dialog}.description`)}
        confirmLabel={tLife(`${dialog}.confirm`)}
        cancelLabel={tLife(`${dialog}.cancel`)}
        onConfirm={() =>
          mutation.mutate(undefined, { onSettled: () => setConfirming(null) })
        }
        isPending={mutation.isPending}
        destructive={confirming === 'delete'}
      />
    </span>
  )
}
