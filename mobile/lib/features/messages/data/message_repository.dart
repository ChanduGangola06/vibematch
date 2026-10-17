import '../../../core/network/api_client.dart';
import '../../../core/utils/paged.dart';
import '../domain/message_models.dart';

class MessageRepository {
  MessageRepository(this._api);

  final ApiClient _api;

  Future<PageResult<T>> _page<T>(
    String path,
    T Function(Map<String, Object?>) map,
    String? cursor, {
    int limit = 20,
  }) async {
    final env = await _api.request(
      'GET',
      path,
      query: {'limit': limit, 'cursor': cursor},
    );
    final items = [
      for (final e in (env.data as List? ?? const []))
        map((e as Map).cast<String, Object?>()),
    ];
    return PageResult(
      items,
      nextCursor: env.page?.nextCursor,
      hasMore: env.page?.hasMore ?? false,
    );
  }

  Future<PageResult<Conversation>> conversations(String? cursor) =>
      _page('/conversations', Conversation.fromJson, cursor);

  /// Newest first (cursor pages walk back in time).
  Future<PageResult<DirectMessage>> messages(
    String partnerId,
    String? cursor,
  ) => _page(
    '/conversations/$partnerId/messages',
    DirectMessage.fromJson,
    cursor,
    limit: 30,
  );

  Future<DirectMessage> send(String partnerId, String text) async =>
      DirectMessage.fromJson(
        ((await _api.post(
                  '/conversations/$partnerId/messages',
                  body: {'text': text},
                  idempotent: true,
                ))!
                as Map)
            .cast<String, Object?>(),
      );

  Future<void> markRead(String partnerId) async =>
      _api.post('/conversations/$partnerId/read');
  Future<void> clear(String partnerId) =>
      _api.delete('/conversations/$partnerId');
}
