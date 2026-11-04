'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Play, Power, Trash } from '@phosphor-icons/react'
import { SaButton } from '@/shared/components/sa-button'
import { cn } from '@/lib/utils'
import {
  useDeleteSalesAssistantMutation,
  useStartSalesAssistantMutation,
  useStopSalesAssistantMutation,
} from '../hooks/use-sales-assistant-mutations'
import { salesAssistantErrorKey } from '../lib/error-messages'
import { LifecycleConfirmDialog } from './lifecycle-confirm-dialog'

type LifecycleView = 'ready' | 'configureAi' | 'stopped'

interface Props {
  view: LifecycleView
  className?: string
}

interface LifecycleMutation {
  mutate: (variables: void, options?: { onSettled?: () => void }) => void
  isPending: boolean
  error: Error | null
}

interface ConfirmedActionProps {
  kind: 'deactivate' | 'delete'
  mutation: LifecycleMutation
}

const KIND_ICON = { deactivate: Power, delete: Trash } as const

/** Botón que abre su confirmación y ejecuta la acción solo al confirmar. */
function ConfirmedAction({ kind, mutation }: ConfirmedActionProps) {
  const t = useTranslations(`salesAssistant.lifecycle.${kind}Dialog`)
  const tLifecycle = useTranslations('salesAssistant.lifecycle')
  const [open, setOpen] = useState(false)
  const confirm = () =>
    mutation.mutate(undefined, { onSettled: () => setOpen(false) })
  return (
    <>
      <SaButton
        variant={kind === 'delete' ? 'ghost' : 'outline'}
        leftIcon={KIND_ICON[kind]}
        onClick={() => setOpen(true)}
        className={cn(kind === 'delete' && 'text-sa-state-error')}
      >
        {tLifecycle(kind)}
      </SaButton>
      <LifecycleConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t('title')}
        description={t('description')}
        confirmLabel={t('confirm')}
        cancelLabel={t('cancel')}
        onConfirm={confirm}
        isPending={mutation.isPending}
        destructive={kind === 'delete'}
      />
    </>
  )
}

/**
 * Desactivar, reactivar y borrar (OCF-006). Desactivar y borrar piden
 * confirmación; reactivar no, porque no pierde nada. El panel no monta estas
 * acciones mientras se prepara o se borra el asistente.
 */
export function LifecycleActions({ view, className }: Props) {
  const t = useTranslations('salesAssistant')
  const stop = useStopSalesAssistantMutation()
  const start = useStartSalesAssistantMutation()
  const remove = useDeleteSalesAssistantMutation()
  const error = stop.error ?? start.error ?? remove.error
  return (
    <section
      aria-labelledby="sales-assistant-lifecycle-title"
      className={cn('flex flex-col gap-3', className)}
    >
      <h2
        id="sales-assistant-lifecycle-title"
        className="text-sa-text-secondary text-sm font-medium"
      >
        {t('lifecycle.title')}
      </h2>
      <div className="flex flex-wrap gap-2">
        {view === 'stopped' ? (
          <SaButton
            variant="primary"
            leftIcon={Play}
            onClick={() => start.mutate()}
            isLoading={start.isPending}
          >
            {t('lifecycle.reactivate')}
          </SaButton>
        ) : (
          <ConfirmedAction kind="deactivate" mutation={stop} />
        )}
        <ConfirmedAction kind="delete" mutation={remove} />
      </div>
      {error && (
        <p role="alert" className="text-sa-text-secondary text-sm">
          {t(salesAssistantErrorKey(error))}
        </p>
      )}
    </section>
  )
}
