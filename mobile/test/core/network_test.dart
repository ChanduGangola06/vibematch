import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibematch/core/config/app_config.dart';
import 'package:vibematch/core/errors/failure.dart';
import 'package:vibematch/core/network/api_client.dart';
import 'package:vibematch/core/storage/token_store.dart';

import '../helpers/fake_adapter.dart';

const config = AppConfig(
  apiBaseUrl: 'http://api.test',
  apiKey: 'vm_mobile_key',
);

Session session({
  String access = 'a1',
  String refresh = 'r1',
  Duration left = const Duration(minutes: 10),
}) => Session(
  accessToken: access,
  refreshToken: refresh,
  expiresAt: DateTime.now().add(left),
);

Map<String, Object?> tokens(String access, String refresh) => {
  'tokens': {
    'accessToken': access,
    'refreshToken': refresh,
    'tokenType': 'Bearer',
    'expiresIn': 900,
  },
};

void main() {
  group('ApiException', () {
    test('parses problem+json including field errors', () {
      final e = ApiException.fromProblem(422, {
        'code': 'validation_failed',
        'detail': 'Invalid',
        'errors': [
          {'path': 'email', 'message': 'Bad email'},
        ],
        'requestId': 'abc',
      });
      expect(e.code, 'validation_failed');
      expect(e.fieldErrors, {'email': 'Bad email'});
      expect(e.requestId, 'abc');
    });

    test('tolerates non-problem bodies', () {
      final e = ApiException.fromProblem(502, '<html>');
      expect(e.status, 502);
      expect(e.code, 'error');
    });
  });

  group('api client', () {
    late FakeAdapter adapter;
    late InMemoryTokenStore store;
    late List<String> lost;

    ApiClient make() {
      lost = [];
      return buildApiClient(
        config: config,
        store: store,
        adapter: adapter,
        onSessionLost: lost.add,
        retrySleep: (_) async {},
      );
    }

    setUp(() {
      store = InMemoryTokenStore(session());
      adapter = FakeAdapter((o) => FakeResponse.ok({'ok': true}));
    });

    test(
      'sends api key, version and bearer token; unwraps the envelope',
      () async {
        final api = make();
        final data = await api.get('/auth/me');
        expect(data, {'ok': true});
        final h = adapter.calls.single.headers;
        expect(h['X-API-Key'], 'vm_mobile_key');
        expect(h['Accept-Version'], '1');
        expect(h['Authorization'], 'Bearer a1');
      },
    );

    test('does not attach the token to login', () async {
      final api = make();
      await api.post('/auth/login', body: {'identifier': 'a', 'password': 'b'});
      expect(
        adapter.calls.single.headers.containsKey('Authorization'),
        isFalse,
      );
    });

    test(
      'adds an Idempotency-Key to gift sends and reuses it on a refresh replay',
      () async {
        var first = true;
        adapter.handler = (o) {
          if (o.path.endsWith('/auth/refresh'))
            return FakeResponse.ok(tokens('a2', 'r2'));
          if (o.path.endsWith('/send') && first) {
            first = false;
            return FakeResponse.problem(401, 'token_expired');
          }
          return FakeResponse.ok({'sent': true});
        };
        final api = make();
        await api.post('/gifts/g1/send', body: {'receiverId': 'u'});
        final sends = adapter.where('POST', '/send');
        expect(sends, hasLength(2));
        final k = sends.first.headers['Idempotency-Key'];
        expect(k, isNotNull);
        expect(sends.last.headers['Idempotency-Key'], k);
        expect(sends.last.headers['Authorization'], 'Bearer a2');
        expect((await store.read())!.refreshToken, 'r2');
      },
    );

    test(
      'concurrent 401s trigger exactly one refresh (single-flight)',
      () async {
        final seen = <String>{};
        adapter.handler = (o) async {
          if (o.path.endsWith('/auth/refresh')) {
            await Future<void>.delayed(const Duration(milliseconds: 20));
            return FakeResponse.ok(tokens('a2', 'r2'));
          }
          if (o.headers['Authorization'] == 'Bearer a1')
            return FakeResponse.problem(401, 'token_expired');
          seen.add(o.path);
          return FakeResponse.ok({});
        };
        final api = make();
        await Future.wait([
          api.get('/one'),
          api.get('/two'),
          api.get('/three'),
        ]);
        expect(adapter.where('POST', '/auth/refresh'), hasLength(1));
        expect(seen, {'/one', '/two', '/three'});
      },
    );

    test('proactively refreshes a token that is about to expire', () async {
      store = InMemoryTokenStore(session(left: const Duration(seconds: 3)));
      adapter.handler = (o) => o.path.endsWith('/auth/refresh')
          ? FakeResponse.ok(tokens('fresh', 'r2'))
          : FakeResponse.ok({});
      final api = make();
      await api.get('/discover');
      expect(
        adapter.where('GET', '/discover').single.headers['Authorization'],
        'Bearer fresh',
      );
    });

    test('a rejected refresh clears the session and reports why', () async {
      adapter.handler = (o) => o.path.endsWith('/auth/refresh')
          ? FakeResponse.problem(401, 'session_revoked')
          : FakeResponse.problem(401, 'token_expired');
      final api = make();
      await expectLater(
        api.get('/auth/me'),
        throwsA(isA<ApiException>().having((e) => e.status, 'status', 401)),
      );
      expect(await store.read(), isNull);
      expect(lost, ['session_revoked']);
    });

    test('a network failure during refresh keeps the session', () async {
      adapter.handler = (o) {
        if (o.path.endsWith('/auth/refresh'))
          throw DioException.connectionError(
            requestOptions: o,
            reason: 'offline',
          );
        return FakeResponse.problem(401, 'token_expired');
      };
      final api = make();
      await expectLater(api.get('/auth/me'), throwsA(isA<ApiException>()));
      expect(await store.read(), isNotNull);
      expect(lost, isEmpty);
    });

    test('a banned account ends the session', () async {
      adapter.handler = (o) => FakeResponse.problem(403, 'account_banned');
      final api = make();
      await expectLater(
        api.get('/discover'),
        throwsA(
          isA<ApiException>().having((e) => e.code, 'code', 'account_banned'),
        ),
      );
      expect(await store.read(), isNull);
      expect(lost, ['account_banned']);
    });

    test('does not loop when the replay also returns 401', () async {
      adapter.handler = (o) => o.path.endsWith('/auth/refresh')
          ? FakeResponse.ok(tokens('a2', 'r2'))
          : FakeResponse.problem(401, 'token_expired');
      final api = make();
      await expectLater(api.get('/x'), throwsA(isA<ApiException>()));
      expect(adapter.where('GET', '/x'), hasLength(2));
      expect(adapter.where('POST', '/auth/refresh'), hasLength(1));
    });

    test(
      'retries transient GET failures with backoff, then succeeds',
      () async {
        var n = 0;
        adapter.handler = (o) => ++n < 3
            ? FakeResponse.problem(503, 'unavailable')
            : FakeResponse.ok({'ok': 1});
        final api = make();
        expect(await api.get('/packs'), {'ok': 1});
        expect(adapter.where('GET', '/packs'), hasLength(3));
      },
    );

    test('never retries a POST without an idempotency key', () async {
      adapter.handler = (o) => FakeResponse.problem(503, 'unavailable');
      final api = make();
      await expectLater(
        api.post('/reports', body: {}),
        throwsA(isA<ApiException>()),
      );
      expect(adapter.where('POST', '/reports'), hasLength(1));
    });

    test('gives up after maxRetries', () async {
      adapter.handler = (o) => FakeResponse.problem(503, 'unavailable');
      final api = make();
      await expectLater(
        api.get('/packs'),
        throwsA(isA<ApiException>().having((e) => e.status, 'status', 503)),
      );
      expect(adapter.where('GET', '/packs'), hasLength(3)); // 1 + 2 retries
    });

    test('maps validation errors for the UI', () async {
      adapter.handler = (o) => FakeResponse.problem(
        422,
        'validation_failed',
        errors: [
          {'path': 'username', 'message': 'Taken'},
        ],
      );
      final api = make();
      await expectLater(
        api.post('/auth/register', body: {}),
        throwsA(
          isA<ApiException>().having(
            (e) => e.fieldErrors['username'],
            'field',
            'Taken',
          ),
        ),
      );
    });

    test('offline surfaces a network ApiException', () async {
      adapter.handler = (o) => throw DioException.connectionError(
        requestOptions: o,
        reason: 'offline',
      );
      final api = make();
      await expectLater(
        api.post('/reports', body: {}),
        throwsA(
          isA<ApiException>().having((e) => e.isNetwork, 'network', true),
        ),
      );
    });
  });

  group('AppConfig', () {
    test('builds api root and absolute urls', () {
      const c = AppConfig(apiBaseUrl: 'https://x.io/', apiKey: 'k');
      expect(c.apiRoot, 'https://x.io/api/v1');
      expect(c.absoluteUrl('/images/a.svg'), 'https://x.io/images/a.svg');
      expect(c.absoluteUrl('https://cdn/a.png'), 'https://cdn/a.png');
      expect(c.absoluteUrl(''), '');
    });
  });
}
