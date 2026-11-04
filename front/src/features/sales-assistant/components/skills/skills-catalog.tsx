'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useBusinessStore } from '@/store/use-business-store'
import { useSkillCatalog } from '../../hooks/use-orqa-queries'
import { useProposeSkill } from '../../hooks/use-orqa-mutations'
import type { CatalogItem } from '../../types'
import { SkillCard, type SkillCardAction } from './skill-card'
import { useAssistantRuntime } from '../../runtime'

interface SectionProps {
  title: string
  items: CatalogItem[]
  action: SkillCardAction
  isBusy: boolean
  onAction: (item: CatalogItem, action: 'install' | 'uninstall') => void
}

function SkillSection({
  title,
  items,
  action,
  isBusy,
  onAction,
}: SectionProps) {
  if (!items.length) return null
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sa-text-secondary text-sm font-medium">{title}</h3>
      {items.map(item => (
        <SkillCard
          key={`${item.id}@${item.version}`}
          item={item}
          action={action}
          isBusy={isBusy}
          onAction={onAction}
        />
      ))}
    </section>
  )
}

function Message({ text }: { text: string }) {
  return (
    <p className="text-sa-text-secondary text-sm" role="status">
      {text}
    </p>
  )
}

/** Catálogo del negocio activo (OSF-004). La industria la decide el servidor; el front no filtra. */
function Catalog({ businessId }: { businessId: string }) {
  const t = useTranslations('salesAssistant.skills')
  const locale = useLocale()
  const { dashboardPath } = useAssistantRuntime()
  const router = useRouter()
  const catalog = useSkillCatalog(businessId)
  const propose = useProposeSkill(businessId)

  if (catalog.isPending) return <Message text={t('loading')} />
  if (catalog.isError || !catalog.data) return <Message text={t('error')} />
  const { data } = catalog
  const onAction = (item: CatalogItem, action: 'install' | 'uninstall') =>
    propose.mutate(
      { itemId: item.id, action },
      {
        onSuccess: ({ approval_id }) =>
          router.push(`/${locale}${dashboardPath}/approvals/${approval_id}`),
      }
    )
  const busy = propose.isPending
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sa-text-secondary text-sm">
        {t('subtitle', {
          industry: data.industry_slug
            ? data.industry_slug.replaceAll('_', ' ')
            : t('industryUnknown'),
        })}
      </p>
      {propose.isError ? (
        <p role="alert" className="text-sa-state-error text-sm">
          {t('error')}
        </p>
      ) : null}
      <SkillSection
        title={t('retiredTitle')}
        items={data.retired_installed}
        action="uninstall"
        isBusy={busy}
        onAction={onAction}
      />
      <SkillSection
        title={t('installedTitle')}
        items={data.installed}
        action={null}
        isBusy={busy}
        onAction={onAction}
      />
      <SkillSection
        title={t('availableTitle')}
        items={data.available}
        action="install"
        isBusy={busy}
        onAction={onAction}
      />
      {!data.available.length ? <Message text={t('empty')} /> : null}
    </div>
  )
}

export function SkillsCatalog() {
  const t = useTranslations('salesAssistant.skills')
  const businessId = useBusinessStore(
    state => state.selectedBusiness?.business_id ?? null
  )
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sa-text-primary text-lg font-semibold">
        {t('title')}
      </h2>
      {businessId ? (
        <Catalog businessId={businessId} />
      ) : (
        <Message text={t('noBusiness')} />
      )}
    </section>
  )
}
