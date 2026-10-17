import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/features/session/SessionProvider';
import { client, unwrap, unwrapPage } from '@/shared/api/client';
import type { AppNotification } from '@/shared/api/types';

export const useNotifications = () => {
  const { status } = useSession();
  return useQuery({
    queryKey: ['notifications'],
    queryFn: async () => (await unwrapPage<AppNotification>(client.GET('/notifications', { params: { query: { limit: 30 } } }))).items,
    enabled: status === 'authenticated',
    refetchInterval: 60_000,
  });
};

export const useUnreadCount = () => {
  const { status } = useSession();
  return useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: async () => (await unwrap(client.GET('/notifications/unread-count'))).count,
    enabled: status === 'authenticated',
    refetchInterval: 60_000,
  });
};

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(client.POST('/notifications/{id}/read', { params: { path: { id } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}

export function useMarkAllRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(client.POST('/notifications/read-all')),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}

/** Number of people online, refreshed every 10 s (the socket pushes fresher values while connected). */
export const useOnlineUsers = (enabled = true) =>
  useQuery({
    queryKey: ['online'],
    queryFn: async () => (await unwrap(client.GET('/stats/online'))).onlineUsers,
    enabled,
    refetchInterval: 10_000,
  });
