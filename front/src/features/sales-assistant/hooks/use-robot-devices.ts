'use client'

import { useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isRobotChannelUnavailable } from '../lib/robot-pairing-code'
import { useAssistantFeatureEnabled, useAssistantRuntime } from '../runtime'
import { useSalesAssistantUserId } from './use-sales-assistant-me'

function useRobotDevicesKey() {
  const { keys } = useAssistantRuntime()
  return keys.robotDevices(useSalesAssistantUserId() ?? 'anonymous')
}

/**
 * Robots vinculados del dueño (`GET …/devices`). Con el canal apagado (404)
 * no reintenta: la UI lo trata como «no disponible».
 */
export function useRobotDevices() {
  const {
    devices: { fetchRobotDevices },
  } = useAssistantRuntime()
  const enabledByFlag = useAssistantFeatureEnabled()
  const userId = useSalesAssistantUserId()
  const queryKey = useRobotDevicesKey()
  const queryFn = useCallback(
    ({ signal }: { signal: AbortSignal }) => fetchRobotDevices(signal),
    [fetchRobotDevices]
  )
  return useQuery({
    queryKey,
    queryFn,
    enabled: enabledByFlag && userId !== null,
    staleTime: 30_000,
    retry: (count, error) => !isRobotChannelUnavailable(error) && count < 1,
  })
}

/** `POST …/devices/claim {code}`; al vincular se refresca la lista. */
export function useClaimRobotDeviceMutation() {
  const {
    devices: { claimRobotDevice },
  } = useAssistantRuntime()
  const queryClient = useQueryClient()
  const queryKey = useRobotDevicesKey()
  return useMutation({
    mutationFn: (code: string) => claimRobotDevice(code),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  })
}

/** `DELETE …/devices/{id}`: el robot deja de poder hablar (401). */
export function useRevokeRobotDeviceMutation() {
  const {
    devices: { revokeRobotDevice },
  } = useAssistantRuntime()
  const queryClient = useQueryClient()
  const queryKey = useRobotDevicesKey()
  return useMutation({
    mutationFn: (deviceId: string) => revokeRobotDevice(deviceId),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })
}
