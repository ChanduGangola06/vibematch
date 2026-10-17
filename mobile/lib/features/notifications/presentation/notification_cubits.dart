import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/dependencies.dart';
import '../../../core/errors/failure.dart';
import '../../../core/utils/paged.dart';
import '../data/notification_repository.dart';

class UnreadCubit extends Cubit<int> {
  UnreadCubit(this._deps) : super(0);

  final AppDependencies _deps;

  Future<void> load() async {
    try {
      emit(await _deps.notifications.unreadCount());
    } on ApiException {
      // badge stays as it was
    }
  }
}

class NotificationsCubit extends PagedCubit<AppNotification> {
  NotificationsCubit(this._deps, this._unread);

  final AppDependencies _deps;
  final UnreadCubit _unread;

  @override
  Object keyOf(AppNotification item) => item.id;

  @override
  Future<PageResult<AppNotification>> fetch(String? cursor) =>
      _deps.notifications.list(cursor);

  Future<void> open(AppNotification n) async {
    if (n.isRead) return;
    await _deps.notifications.markRead(n.id);
    await _unread.load();
  }

  Future<void> markAll() async {
    await _deps.notifications.markAllRead();
    await _unread.load();
    await refresh();
  }
}
