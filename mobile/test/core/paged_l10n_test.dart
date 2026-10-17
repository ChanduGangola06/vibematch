import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vibematch/core/errors/failure.dart';
import 'package:vibematch/core/l10n/language_repository.dart';
import 'package:vibematch/core/l10n/translator.dart';
import 'package:vibematch/core/network/api_client.dart';
import 'package:vibematch/core/config/app_config.dart';
import 'package:vibematch/core/storage/token_store.dart';
import 'package:vibematch/core/utils/paged.dart';

import '../helpers/fake_adapter.dart';

class Numbers extends PagedCubit<int> {
  final calls = <String?>[];
  Object? failOnce;

  @override
  Future<PageResult<int>> fetch(String? cursor) async {
    calls.add(cursor);
    if (failOnce != null) {
      final e = failOnce!;
      failOnce = null;
      throw e;
    }
    final start = cursor == null ? 0 : int.parse(cursor);
    final items = List.generate(3, (i) => start + i);
    return PageResult(
      items,
      nextCursor: start + 3 >= 6 ? null : '${start + 3}',
      hasMore: start + 3 < 6,
    );
  }
}

void main() {
  group('PagedCubit', () {
    test('loads the first page, then more, then stops', () async {
      final c = Numbers();
      addTearDown(c.close);
      await c.loadMore();
      expect(c.state.items, [0, 1, 2]);
      await c.loadMore();
      expect(c.state.items, [0, 1, 2, 3, 4, 5]);
      expect(c.state.hasMore, isFalse);
      await c.loadMore();
      expect(c.calls, [null, '3']);
    });

    test('ignores overlapping loadMore calls', () async {
      final c = Numbers();
      addTearDown(c.close);
      await Future.wait<void>([c.loadMore(), c.loadMore(), c.loadMore()]);
      expect(c.calls, [null]);
    });

    test('keeps items and exposes the error, and a retry succeeds', () async {
      final c = Numbers();
      addTearDown(c.close);
      await c.loadMore();
      c.failOnce = const ApiException(
        status: 503,
        code: 'unavailable',
        message: 'down',
      );
      await c.loadMore();
      expect(c.state.error?.code, 'unavailable');
      expect(c.state.items, [0, 1, 2]);
      await c.loadMore();
      expect(c.state.error, isNull);
      expect(c.state.items, hasLength(6));
    });

    test('refresh starts over and mutate edits locally', () async {
      final c = Numbers();
      addTearDown(c.close);
      await c.loadMore();
      c.mutate((l) => [99, ...l]);
      expect(c.state.items.first, 99);
      await c.refresh();
      expect(c.state.items, [0, 1, 2]);
    });
  });

  group('Translator', () {
    test('falls back to the key and substitutes placeholders', () {
      const t = Translator(messages: {'Hello {name}': 'Bonjour {name}'});
      expect(t('Hello {name}', {'name': 'Zoe'}), 'Bonjour Zoe');
      expect(t('Unknown'), 'Unknown');
      expect(t('Bye {n}', {'n': 2}), 'Bye 2');
    });
    test(
      'rtl direction',
      () => expect(const Translator(rtl: true).direction.name, 'rtl'),
    );
  });

  group('LanguageRepository', () {
    late FakeAdapter adapter;
    late LanguageRepository repo;
    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      adapter = FakeAdapter(
        (o) => FakeResponse.ok({
          'code': 'ar',
          'name': 'Arabic',
          'rtl': true,
          'translations': {'Home': 'الرئيسية', 'A&B': 'x=y'},
        }),
      );
      final api = buildApiClient(
        config: const AppConfig(apiBaseUrl: 'http://t', apiKey: ''),
        store: InMemoryTokenStore(),
        adapter: adapter,
      );
      repo = LanguageRepository(api, await SharedPreferences.getInstance());
    });

    test('loads a pack and caches it for offline use', () async {
      final online = await repo.load('ar');
      expect(online('Home'), 'الرئيسية');
      expect(online.rtl, isTrue);
      adapter.handler = (o) => throw StateError('offline');
      final offline = await repo.load('ar');
      expect(offline('Home'), 'الرئيسية');
      expect(offline('A&B'), 'x=y');
      expect(offline.rtl, isTrue);
    });

    test('english needs no network', () async {
      expect((await repo.load('en')).code, 'en');
      expect(adapter.calls, isEmpty);
    });

    test('remembers the chosen language', () async {
      expect(repo.savedCode, 'en');
      await repo.saveCode('ar');
      expect(repo.savedCode, 'ar');
    });
  });
}
