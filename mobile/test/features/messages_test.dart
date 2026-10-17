import 'package:flutter_test/flutter_test.dart';
import 'package:vibematch/core/errors/failure.dart';
import 'package:vibematch/core/storage/token_store.dart';
import 'package:vibematch/features/messages/presentation/message_cubits.dart';

import '../helpers/fake_adapter.dart';
import '../helpers/harness.dart';

Map<String, Object?> conv(String id, String text, {int unread = 0}) => {
  'partner': {'id': id, 'name': id.toUpperCase(), 'username': id, 'avatar': ''},
  'lastMessage': {'text': text},
  'lastMessageAt': '2026-01-01T00:00:00Z',
  'unreadCount': unread,
};

Map<String, Object?> msg(String id, String from, String text) => {
  'id': id,
  'senderId': from,
  'receiverId': 'x',
  'text': text,
  'isRead': false,
  'createdAt': '2026-01-01T00:00:00Z',
};

Future<void> settle() => Future<void>.delayed(const Duration(milliseconds: 20));

void main() {
  test(
    'inbox loads, paginates with the cursor and refreshes on a push',
    () async {
      var n = 0;
      final h = await Harness.create(
        store: InMemoryTokenStore(validSession()),
        handler: (o) {
          final cursor = o.queryParameters['cursor'];
          if (cursor == 'c1')
            return FakeResponse.ok(
              [conv('b', 'older')],
              page: {'hasMore': false},
            );
          return FakeResponse.ok(
            [conv('a', n++ == 0 ? 'first' : 'pushed', unread: 2)],
            page: {'hasMore': true, 'nextCursor': 'c1'},
          );
        },
      );
      final c = ConversationsCubit(h.deps);
      addTearDown(c.close);
      await c.loadMore();
      expect(c.state.items.single.lastText, 'first');
      expect(c.state.items.single.unread, 2);
      await c.loadMore();
      expect(c.state.items.map((e) => e.partner.id), ['a', 'b']);
      h.socket.fire('new_message_notification', {'senderId': 'a'});
      await settle();
      expect(c.state.items.first.lastText, 'pushed');
      expect(h.adapter.where('GET', '/conversations'), hasLength(3));
    },
  );

  test(
    'opening a thread loads newest-first, marks it read and clears the unread badge',
    () async {
      final h = await Harness.create(
        store: InMemoryTokenStore(validSession()),
        handler: (o) {
          if (o.path.endsWith('/conversations/a/messages'))
            return FakeResponse.ok(
              [msg('2', 'me', 'second'), msg('1', 'a', 'first')],
              page: {'hasMore': false},
            );
          if (o.path.endsWith('/conversations'))
            return FakeResponse.ok(
              [conv('a', 'first', unread: 3)],
              page: {'hasMore': false},
            );
          return FakeResponse.ok({'updated': 1});
        },
      );
      final inbox = ConversationsCubit(h.deps);
      final thread = ThreadCubit(h.deps, 'a', inbox);
      addTearDown(inbox.close);
      addTearDown(thread.close);
      await inbox.loadMore();
      await thread.loadMore();
      await settle();
      expect(thread.state.items.map((m) => m.id), ['2', '1']);
      expect(h.adapter.where('POST', '/conversations/a/read'), hasLength(1));
      expect(inbox.state.items.single.unread, 0);
    },
  );

  test('send adds the message with an idempotency key', () async {
    final h = await Harness.create(
      store: InMemoryTokenStore(validSession()),
      handler: (o) {
        if (o.method == 'POST') return FakeResponse.ok(msg('9', 'me', 'hello'));
        return FakeResponse.ok(<Object?>[], page: {'hasMore': false});
      },
    );
    final inbox = ConversationsCubit(h.deps);
    final thread = ThreadCubit(h.deps, 'a', inbox);
    addTearDown(inbox.close);
    addTearDown(thread.close);
    await thread.send(' hello ');
    expect(thread.state.items.single.text, 'hello');
    final post = h.adapter.where('POST', '/conversations/a/messages').single;
    expect(post.data, {'text': 'hello'});
    expect(post.headers['Idempotency-Key'], isNotNull);
  });

  test(
    'a follow-gate rejection propagates as ApiException for the UI to explain',
    () async {
      final h = await Harness.create(
        store: InMemoryTokenStore(validSession()),
        handler: (o) => o.method == 'POST'
            ? FakeResponse.problem(403, 'chat_not_allowed')
            : FakeResponse.ok(<Object?>[], page: {'hasMore': false}),
      );
      final inbox = ConversationsCubit(h.deps);
      final thread = ThreadCubit(h.deps, 'a', inbox);
      addTearDown(inbox.close);
      addTearDown(thread.close);
      await expectLater(
        thread.send('hi'),
        throwsA(
          isA<ApiException>().having((e) => e.code, 'code', 'chat_not_allowed'),
        ),
      );
    },
  );
}
