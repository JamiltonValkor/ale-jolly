'use client'

import { Providers } from '@/lib/providers'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarProvider,
} from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentModeSidebarCard } from '@/features/agent-chat'
import {
  AssistantRuntimeProvider,
  SalesAssistantSidebarEntry,
} from '@/features/sales-assistant'
import { MetaSidebarAvatar } from '@/shared/shells/meta-companion'

/**
 * El tramo del menú lateral con la tarjeta de Ale y la de Meta Assistant, con
 * el mismo marcado que `AppSidebar`: en la app solo se ve con sesión iniciada.
 */
export function MetaAssistantLabSidebar() {
  return (
    <Providers session={null}>
      <TooltipProvider>
        <SidebarProvider className="min-h-dvh bg-black">
          <Sidebar collapsible="none" className="h-auto min-h-dvh">
            <SidebarContent>
              <SidebarGroup className="pb-0">
                <SidebarMenu>
                  <SidebarMenuItem className="mx-2 group-data-[collapsible=icon]:mx-0">
                    <AgentModeSidebarCard />
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroup>
              <SidebarGroup className="pb-0">
                <SidebarMenu>
                  <SidebarMenuItem className="mx-2 group-data-[collapsible=icon]:mx-0">
                    <AssistantRuntimeProvider runtime="meta">
                      <SalesAssistantSidebarEntry
                        renderAvatar={({ engaged }) => (
                          <MetaSidebarAvatar engaged={engaged} />
                        )}
                      />
                    </AssistantRuntimeProvider>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
        </SidebarProvider>
      </TooltipProvider>
    </Providers>
  )
}
