import 'package:equatable/equatable.dart';

class Person extends Equatable {
  const Person({
    required this.id,
    required this.name,
    required this.username,
    required this.avatar,
    this.isOnline = false,
    this.isFollowing = false,
    this.isMutualFollow = false,
  });

  factory Person.fromJson(Map<String, Object?> j) => Person(
    id: j['id']! as String,
    name: (j['name'] as String?) ?? '',
    username: (j['username'] as String?) ?? '',
    avatar: (j['avatar'] as String?) ?? '',
    isOnline: j['isOnline'] == true,
    isFollowing: j['isFollowing'] == true,
    isMutualFollow: j['isMutualFollow'] == true,
  );

  final String id;
  final String name;
  final String username;
  final String avatar;
  final bool isOnline;
  final bool isFollowing;
  final bool isMutualFollow;

  String get displayName => name.isNotEmpty ? name : username;

  @override
  List<Object?> get props => [id, name, isOnline];
}

class Conversation extends Equatable {
  const Conversation({
    required this.partner,
    required this.lastText,
    required this.lastAt,
    required this.unread,
  });

  factory Conversation.fromJson(Map<String, Object?> j) {
    final last = j['lastMessage'] is Map
        ? (j['lastMessage']! as Map).cast<String, Object?>()
        : const <String, Object?>{};
    return Conversation(
      partner: Person.fromJson((j['partner']! as Map).cast<String, Object?>()),
      lastText: last['isGift'] == true ? '🎁' : (last['text'] as String?) ?? '',
      lastAt:
          DateTime.tryParse((j['lastMessageAt'] as String?) ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0),
      unread: (j['unreadCount'] as num?)?.toInt() ?? 0,
    );
  }

  final Person partner;
  final String lastText;
  final DateTime lastAt;
  final int unread;

  @override
  List<Object?> get props => [partner.id, lastText, lastAt, unread];
}

class DirectMessage extends Equatable {
  const DirectMessage({
    required this.id,
    required this.senderId,
    required this.text,
    required this.createdAt,
    this.giftName,
    this.giftImage,
    this.isRead = false,
  });

  factory DirectMessage.fromJson(Map<String, Object?> j) {
    final gift = j['gift'] is Map
        ? (j['gift']! as Map).cast<String, Object?>()
        : null;
    return DirectMessage(
      id: j['id']! as String,
      senderId: (j['senderId'] as String?) ?? '',
      text: (j['text'] as String?) ?? '',
      createdAt:
          DateTime.tryParse((j['createdAt'] as String?) ?? '') ??
          DateTime.now(),
      giftName: gift?['name'] as String?,
      giftImage: gift?['image'] as String?,
      isRead: j['isRead'] == true,
    );
  }

  final String id;
  final String senderId;
  final String text;
  final DateTime createdAt;
  final String? giftName;
  final String? giftImage;
  final bool isRead;

  @override
  List<Object?> get props => [id];
}
