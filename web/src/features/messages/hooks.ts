import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useSession } from '@/features/session/SessionProvider';
import { client, unwrap, unwrapPage } from '@/shared/api/client';
import { useCursorList } from '@/shared/api/infinite';
import type { Conversation, Message } from '@/shared/api/types';
import { useSocket } from '@/shared/socket/SocketProvider';

export const useConversations = () => {
  const { status } = useSession();
  return useCursorList<Conversation>(['conversations'], (cursor) => unwrapPage(client.GET('/conversations', { params: { query: { limit: 20, ...(cursor ? { cursor } : {}) } } })), status === 'authenticated');
};

export const useThread = (partnerId: string | undefined) =>
  useCursorList<Message>(['thread', partnerId], (cursor) => unwrapPage(client.GET('/conversations/{partnerId}/messages', { params: { path: { partnerId: partnerId! }, query: { limit: 30, ...(cursor ? { cursor } : {}) } } })), Boolean(partnerId));

export const useUnreadMessages = () => {
  const { status } = useSession();
  return useQuery({ queryKey: ['conversations', 'unread'], queryFn: async () => (await unwrap(client.GET('/conversations/unread-count'))).count, enabled: status === 'authenticated', refetchInterval: 60_000 });
};

export function useSendMessage(partnerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => unwrap(client.POST('/conversations/{partnerId}/messages', { params: { path: { partnerId }, header: { 'Idempotency-Key': crypto.randomUUID() } }, body: { text } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['thread', partnerId] });
      void qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

export function useMarkThreadRead(partnerId: string | undefined, enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!partnerId || !enabled) return;
    void unwrap(client.POST('/conversations/{partnerId}/read', { params: { path: { partnerId } } })).then(() => qc.invalidateQueries({ queryKey: ['conversations'] })).catch(() => {});
  }, [partnerId, enabled, qc]);
}

export function useClearThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (partnerId: string) => unwrap(client.DELETE('/conversations/{partnerId}', { params: { path: { partnerId } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['conversations'] }),
  });
}

/** Keeps the inbox and the open thread fresh when the server pushes a message. */
export function useRealtimeInbox(openPartnerId?: string) {
  const { socket } = useSocket();
  const qc = useQueryClient();
  useEffect(() => {
    if (!socket) return;
    const onMsg = (m: { senderId: string }) => {
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      if (m.senderId === openPartnerId) void qc.invalidateQueries({ queryKey: ['thread', openPartnerId] });
    };
    socket.on('new_message_notification', onMsg);
    return () => { socket.off('new_message_notification', onMsg); };
  }, [socket, qc, openPartnerId]);
}
