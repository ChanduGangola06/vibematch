import 'package:flutter_bloc/flutter_bloc.dart';

import '../errors/failure.dart';

class PageResult<T> {
  const PageResult(this.items, {this.nextCursor, this.hasMore = false});

  final List<T> items;
  final String? nextCursor;
  final bool hasMore;
}

class PagedState<T> {
  const PagedState({
    this.items = const [],
    this.cursor,
    this.hasMore = true,
    this.loading = false,
    this.error,
    this.loadedOnce = false,
  });

  final List<T> items;
  final String? cursor;
  final bool hasMore;
  final bool loading;
  final ApiException? error;
  final bool loadedOnce;

  bool get isEmpty => loadedOnce && items.isEmpty && error == null;

  PagedState<T> copyWith({
    List<T>? items,
    String? Function()? cursor,
    bool? hasMore,
    bool? loading,
    ApiException? Function()? error,
    bool? loadedOnce,
  }) => PagedState<T>(
    items: items ?? this.items,
    cursor: cursor != null ? cursor() : this.cursor,
    hasMore: hasMore ?? this.hasMore,
    loading: loading ?? this.loading,
    error: error != null ? error() : this.error,
    loadedOnce: loadedOnce ?? this.loadedOnce,
  );
}

/// Cursor-paginated list with infinite-scroll semantics. Subclasses implement [fetch] only.
/// Calls made while a page is loading are ignored, so a scroll listener may call [loadMore] freely.
abstract class PagedCubit<T> extends Cubit<PagedState<T>> {
  PagedCubit() : super(PagedState<T>());

  Future<PageResult<T>> fetch(String? cursor);

  /// Items are de-duplicated by this key (a new message can arrive while paging).
  Object keyOf(T item) => item as Object;

  Future<void> loadMore() async {
    final s = state;
    if (s.loading || !s.hasMore) return;
    emit(s.copyWith(loading: true, error: () => null));
    try {
      final page = await fetch(s.cursor);
      if (isClosed) return;
      final seen = {for (final i in s.items) keyOf(i)};
      emit(
        state.copyWith(
          items: [
            ...s.items,
            ...page.items.where((i) => !seen.contains(keyOf(i))),
          ],
          cursor: () => page.nextCursor,
          hasMore: page.hasMore && page.nextCursor != null,
          loading: false,
          loadedOnce: true,
        ),
      );
    } on ApiException catch (e) {
      if (!isClosed)
        emit(state.copyWith(loading: false, error: () => e, loadedOnce: true));
    }
  }

  Future<void> refresh() async {
    emit(PagedState<T>());
    await loadMore();
  }

  /// Local edits (optimistic updates, realtime pushes).
  void mutate(List<T> Function(List<T>) change) =>
      emit(state.copyWith(items: change(state.items)));
}
