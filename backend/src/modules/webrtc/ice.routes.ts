import type { ModuleRegistrar } from '../../app.js';
import { iceServersSchema, onlineSchema } from '../dto.js';
import type { IceService } from './ice.service.js';

export const iceRoutes = (ice: IceService, onlineCount: () => Promise<number | null>): ModuleRegistrar => ({ v1 }) => {
  v1.add({
    method: 'get', path: '/webrtc/ice-servers', summary: 'STUN/TURN servers for a call', tags: ['webrtc'],
    // Authenticated: TURN credentials are a paid resource and must not be handed to anonymous callers.
    auth: 'user', roles: ['guest', 'user', 'admin'], schema: { response: iceServersSchema },
    handler: async () => ({ data: { iceServers: await ice.servers() } }),
  });

  v1.add({
    method: 'get', path: '/stats/online', summary: 'People online right now (null when hidden)', tags: ['public'],
    auth: 'public', schema: { response: onlineSchema },
    handler: async () => ({ data: { onlineUsers: await onlineCount() } }),
  });
};
