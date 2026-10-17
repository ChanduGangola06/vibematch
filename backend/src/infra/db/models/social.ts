import { model, Schema, type InferSchemaType, type Types } from 'mongoose';
import { baseOptions, idField, secondsInDay, ttlDays } from './common.js';

const followSchema = new Schema(
  { followerId: { type: String, required: true }, followeeId: { type: String, required: true } },
  baseOptions,
);
followSchema.index({ followerId: 1, followeeId: 1 }, { unique: true });
followSchema.index({ followeeId: 1, createdAt: -1, _id: -1 });
followSchema.index({ followerId: 1, createdAt: -1, _id: -1 });
export type FollowDoc = InferSchemaType<typeof followSchema> & { _id: Types.ObjectId };
export const FollowModel = model('Follow', followSchema);

const likeSchema = new Schema(
  { likerId: { type: String, required: true }, targetId: { type: String, required: true } },
  baseOptions,
);
// One like per (liker, target): the counter can't be inflated by repeated calls.
likeSchema.index({ likerId: 1, targetId: 1 }, { unique: true });
likeSchema.index({ targetId: 1 });
export type LikeDoc = InferSchemaType<typeof likeSchema> & { _id: Types.ObjectId };
export const LikeModel = model('Like', likeSchema);

const partnerSnapshot = new Schema(
  {
    name: String,
    username: String,
    avatar: String,
    country: String,
    age: Number,
  },
  { _id: false },
);

const matchSchema = new Schema(
  {
    id: idField('hist'),
    userId: { type: String, required: true },
    partnerId: { type: String, required: true },
    type: { type: String, enum: ['video_chat', 'view'], required: true },
    durationSec: { type: Number, default: 0 },
    partner: { type: partnerSnapshot, default: {} },
  },
  baseOptions,
);
matchSchema.index({ userId: 1, type: 1, createdAt: -1, _id: -1 });
matchSchema.index({ userId: 1, partnerId: 1, type: 1, createdAt: -1 });
matchSchema.index({ partnerId: 1, userId: 1 });
matchSchema.index({ createdAt: 1 }, { expireAfterSeconds: ttlDays('HISTORY_TTL_DAYS', 180) * secondsInDay });
export type MatchDoc = InferSchemaType<typeof matchSchema> & { _id: Types.ObjectId };
export const MatchModel = model('Match', matchSchema);

const notificationSchema = new Schema(
  {
    id: idField('notif'),
    userId: { type: String, required: true },
    type: { type: String, enum: ['follow', 'gift', 'message', 'system'], required: true },
    fromUserId: { type: String },
    fromUserName: { type: String },
    fromUserUsername: { type: String },
    fromUserAvatar: { type: String },
    isRead: { type: Boolean, default: false },
  },
  baseOptions,
);
notificationSchema.index({ userId: 1, createdAt: -1, _id: -1 });
notificationSchema.index({ userId: 1, isRead: 1 });
export type NotificationDoc = InferSchemaType<typeof notificationSchema> & { _id: Types.ObjectId };
export const NotificationModel = model('Notification', notificationSchema);

const giftRef = new Schema({ id: String, name: String, image: String, cost: Number }, { _id: false });

const messageSchema = new Schema(
  {
    id: idField('msg'),
    senderId: { type: String, required: true },
    receiverId: { type: String, required: true },
    conversationKey: { type: String, required: true },
    text: { type: String, default: '', maxlength: 2000 },
    gift: { type: giftRef },
    isRead: { type: Boolean, default: false },
  },
  baseOptions,
);
messageSchema.index({ conversationKey: 1, createdAt: -1, _id: -1 });
messageSchema.index({ receiverId: 1, isRead: 1, senderId: 1 });
messageSchema.index({ senderId: 1, createdAt: -1 });
export type MessageDoc = InferSchemaType<typeof messageSchema> & { _id: Types.ObjectId };
export const MessageModel = model('Message', messageSchema);

const conversationSchema = new Schema(
  {
    key: { type: String, required: true },
    /** Sorted pair of user ids. */
    participants: { type: [String], required: true, validate: (v: string[]) => v.length === 2 },
    lastMessage: {
      id: String,
      senderId: String,
      text: String,
      isGift: Boolean,
    },
    lastMessageAt: { type: Date, required: true },
    /** { [userId]: unread count } — denormalised so the inbox needs no scan of messages. */
    unread: { type: Schema.Types.Mixed, default: {} },
    /** { [userId]: Date } — per-user "clear chat": hides older messages for that user only. */
    clearedAt: { type: Schema.Types.Mixed, default: {} },
  },
  baseOptions,
);
conversationSchema.index({ key: 1 }, { unique: true });
conversationSchema.index({ participants: 1, lastMessageAt: -1, _id: -1 });
export type ConversationDoc = InferSchemaType<typeof conversationSchema> & { _id: Types.ObjectId };
export const ConversationModel = model('Conversation', conversationSchema);

const reportSchema = new Schema(
  {
    id: idField('rep'),
    reporterId: { type: String, required: true },
    reportedUserId: { type: String, required: true },
    reason: { type: String, required: true, maxlength: 120 },
    details: { type: String, default: '', maxlength: 2000 },
    status: { type: String, enum: ['pending', 'reviewed', 'resolved', 'dismissed'], default: 'pending' },
  },
  baseOptions,
);
reportSchema.index({ status: 1, createdAt: -1, _id: -1 });
reportSchema.index({ reportedUserId: 1 });
export type ReportDoc = InferSchemaType<typeof reportSchema> & { _id: Types.ObjectId };
export const ReportModel = model('Report', reportSchema);

const contactSchema = new Schema(
  {
    id: idField('msg'),
    name: { type: String, required: true, maxlength: 120 },
    email: { type: String, required: true, maxlength: 254 },
    message: { type: String, required: true, maxlength: 5000 },
    userId: { type: String },
    status: { type: String, enum: ['unread', 'read', 'archived'], default: 'unread' },
  },
  baseOptions,
);
contactSchema.index({ status: 1, createdAt: -1, _id: -1 });
export type ContactMessageDoc = InferSchemaType<typeof contactSchema> & { _id: Types.ObjectId };
export const ContactMessageModel = model('ContactMessage', contactSchema);
