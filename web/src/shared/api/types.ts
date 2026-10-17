import type { paths } from './schema';

/** Payload type (`data`) of a successful response, taken from the generated OpenAPI types. */
export type DataOf<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends {
  responses: { '2XX': { content: { 'application/json': { data: infer D } } } };
}
  ? D
  : unknown;

export type SelfUser = DataOf<'/auth/me', 'get'>;
export type PublicProfile = DataOf<'/users/{id}', 'get'>;
export type DiscoverUser = DataOf<'/discover', 'get'>[number];
export type Conversation = DataOf<'/conversations', 'get'>[number];
export type Message = DataOf<'/conversations/{partnerId}/messages', 'get'>[number];
export type AppNotification = DataOf<'/notifications', 'get'>[number];
export type HistoryEntry = DataOf<'/matches', 'get'>[number];
export type Gift = DataOf<'/gifts', 'get'>[number];
export type Pack = DataOf<'/packs', 'get'>[number];
export type VipPlan = DataOf<'/vip-plans', 'get'>[number];
export type Purchase = DataOf<'/payments/purchases', 'get'>[number];
export type PublicSettings = DataOf<'/settings/public', 'get'>;
export type Language = DataOf<'/languages', 'get'>[number];
export type LanguagePack = DataOf<'/languages/{code}', 'get'>;
export type IceServers = DataOf<'/webrtc/ice-servers', 'get'>['iceServers'];
export type CheckoutResult = DataOf<'/payments/stripe/checkout', 'post'>;
export type FulfilResult = DataOf<'/payments/stripe/verify', 'post'>;
export type InstallStatus = DataOf<'/install/status', 'get'>;
