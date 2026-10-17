import '../../../core/network/api_client.dart';
import '../../../core/utils/paged.dart';

class AppNotification {
  const AppNotification({
    required this.id,
    required this.type,
    required this.isRead,
    required this.fromName,
    required this.fromUsername,
    required this.createdAt,
  });

  factory AppNotification.fromJson(Map<String, Object?> j) {
    final from = j['from'] is Map
        ? (j['from']! as Map).cast<String, Object?>()
        : const <String, Object?>{};
    return AppNotification(
      id: j['id']! as String,
      type: (j['type'] as String?) ?? '',
      isRead: j['isRead'] == true,
      fromName: (from['name'] as String?) ?? '',
      fromUsername: (from['username'] as String?) ?? '',
      createdAt:
          DateTime.tryParse((j['createdAt'] as String?) ?? '') ??
          DateTime.now(),
    );
  }

  final String id;
  final String type;
  final bool isRead;
  final String fromName;
  final String fromUsername;
  final DateTime createdAt;
}

class NotificationRepository {
  NotificationRepository(this._api);

  final ApiClient _api;

  Future<PageResult<AppNotification>> list(String? cursor) async {
    final env = await _api.request(
      'GET',
      '/notifications',
      query: {'limit': 20, 'cursor': cursor},
    );
    return PageResult(
      [
        for (final e in (env.data as List? ?? const []))
          AppNotification.fromJson((e as Map).cast<String, Object?>()),
      ],
      nextCursor: env.page?.nextCursor,
      hasMore: env.page?.hasMore ?? false,
    );
  }

  Future<int> unreadCount() async =>
      (((await _api.get('/notifications/unread-count'))! as Map)['count']
              as num)
          .toInt();
  Future<void> markRead(String id) => _api.post('/notifications/$id/read');
  Future<void> markAllRead() => _api.post('/notifications/read-all');
}
