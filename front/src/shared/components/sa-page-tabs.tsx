'use client'

import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

export interface SaPageTab {
  value: string
  label: string
  badge?: string
  disabled?: boolean
}

interface SaPageTabsProps {
  tabs: SaPageTab[]
  value: string
  onValueChange?: (value: string) => void
  className?: string
  listClassName?: string
  children?: React.ReactNode
}

export function SaPageTabs({
  tabs,
  value,
  onValueChange,
  className,
  listClassName,
  children,
}: SaPageTabsProps) {
  return (
    <Tabs
      value={value}
      onValueChange={onValueChange}
      className={cn('gap-0', className)}
    >
      <div className="relative">
        <TabsList
          variant="line"
          className={cn(
            'h-auto gap-6 rounded-none bg-transparent p-0',
            listClassName
          )}
        >
          {tabs.map(tab => (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              disabled={tab.disabled}
              className={cn(
                'h-auto flex-initial rounded-none border-none bg-transparent! px-0 pb-3 shadow-none',
                'font-mono text-[13px] leading-[16.5px] font-normal tracking-[0.55px] uppercase',
                'text-white/35 hover:text-white/50',
                'data-[state=active]:bg-transparent! data-[state=active]:text-white',
                'dark:text-white/35 dark:hover:text-white/50 dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-transparent! dark:data-[state=active]:text-white',
                'after:bottom-0! after:h-px after:bg-white',
                'focus-visible:ring-0 focus-visible:outline-none',
                'cursor-pointer'
              )}
            >
              {tab.label}
              {tab.badge && (
                <span className="inline-flex h-6 items-center gap-[5px] rounded-full border border-[#7C3AED40] bg-[#7C3AED26] px-[10px] font-mono text-[11px] leading-none font-normal tracking-normal text-[#A78BFA] uppercase">
                  {tab.badge}
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        <Separator className="bg-sa-border-default absolute inset-x-0 bottom-0" />
      </div>
      {children}
    </Tabs>
  )
}

export { TabsContent as SaPageTabsContent }
