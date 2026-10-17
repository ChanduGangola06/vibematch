import 'dart:async';

import '../../../core/di/dependencies.dart';
import '../../../core/utils/paged.dart';
import '../domain/message_models.dart';

class ConversationsCubit extends PagedCubit<Conversation> {
  ConversationsCubit(this._deps) {
    // A push for a new direct message refreshes the inbox.
    _deps.socket.on('new_message_notification', _onPush);
  }

  final AppDependencies _deps;

  void _onPush(Object? _) => refresh().ignore();

  @override
  Object keyOf(Conversation item) => item.partner.id;

  @override
  Future<PageResult<Conversation>> fetch(String? cursor) =>
      _deps.messages.conversations(cursor);

  void markReadLocally(String partnerId) => mutate(
    (l) => [
      for (final c in l)
        c.partner.id == partnerId
            ? Conversation(
                partner: c.partner,
                lastText: c.lastText,
                lastAt: c.lastAt,
                unread: 0,
              )
            : c,
    ],
  );

  @override
  Future<void> close() {
    _deps.socket.off('new_message_notification', _onPush);
    return super.close();
  }
}

/// One thread, newest first (the UI reverses the list view), so loading older pages appends.
class ThreadCubit extends PagedCubit<DirectMessage> {
  ThreadCubit(this._deps, this.partnerId, this._inbox) {
    _deps.socket.on('new_message_notification', _onPush);
  }

  final AppDependencies _deps;
  final String partnerId;
  final ConversationsCubit _inbox;

  void _onPush(Object? raw) {
    if (raw is Map && raw['senderId'] == partnerId) refresh().ignore();
  }

  @override
  Object keyOf(DirectMessage item) => item.id;

  @override
  Future<PageResult<DirectMessage>> fetch(String? cursor) async {
    final page = await _deps.messages.messages(partnerId, cursor);
    if (cursor == null) {
      // Opening the thread marks it read; a failure here must not break the screen.
      unawaited(
        _deps.messages
            .markRead(partnerId)
            .then(
              (_) => _inbox.markReadLocally(partnerId),
              onError: (Object _) {},
            ),
      );
    }
    return page;
  }

  /// Throws [ApiException] (e.g. `chat_not_allowed`) so the screen can explain it.
  Future<void> send(String text) async {
    final m = await _deps.messages.send(partnerId, text.trim());
    emit(state.copyWith(items: [m, ...state.items.where((x) => x.id != m.id)]));
    _inbox.refresh().ignore();
  }

  Future<void> clear() async {
    await _deps.messages.clear(partnerId);
    emit(const PagedState<DirectMessage>(loadedOnce: true, hasMore: false));
    _inbox.refresh().ignore();
  }

  @override
  Future<void> close() {
    _deps.socket.off('new_message_notification', _onPush);
    return super.close();
  }
}
