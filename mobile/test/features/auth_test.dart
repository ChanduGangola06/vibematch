import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibematch/core/errors/failure.dart';
import 'package:vibematch/core/storage/token_store.dart';
import 'package:vibematch/features/auth/data/auth_repository.dart';
import 'package:vibematch/features/auth/presentation/auth_screen.dart';
import 'package:vibematch/features/auth/presentation/session_cubit.dart';

import '../helpers/fake_adapter.dart';
import '../helpers/harness.dart';

void main() {
  group('AuthRepository', () {
    test('login stores the tokens and returns the user', () async {
      final h = await Harness.create(
        handler: (o) => FakeResponse.ok(authJson()),
      );
      final r = await h.deps.auth.login('alice', 'pw');
      expect(r.user.username, 'alice');
      final s = await h.store.read();
      expect(s?.accessToken, 'acc');
      expect(s?.refreshToken, 'ref');
      expect(h.adapter.calls.single.data, {
        'identifier': 'alice',
        'password': 'pw',
      });
    });

    test(
      'passkey-protected accounts are refused without storing tokens',
      () async {
        final h = await Harness.create(
          handler: (o) => FakeResponse.ok({
            'status': 'passkey_required',
            'challengeToken': 'x',
          }),
        );
        await expectLater(
          h.deps.auth.login('admin', 'pw'),
          throwsA(isA<PasskeyRequired>()),
        );
        expect(await h.store.read(), isNull);
      },
    );

    test(
      'logout clears local tokens even when the server call fails',
      () async {
        final h = await Harness.create(
          store: InMemoryTokenStore(validSession()),
          handler: (o) => throw StateError('offline'),
        );
        await h.deps.auth.logout();
        expect(await h.store.read(), isNull);
      },
    );

    test('usernameAvailable', () async {
      final h = await Harness.create(
        handler: (o) => FakeResponse.ok({'available': false}),
      );
      expect(await h.deps.auth.usernameAvailable('bob'), isFalse);
    });
  });

  group('SessionCubit', () {
    test('no stored session -> anonymous', () async {
      final h = await Harness.create();
      final c = SessionCubit(h.deps);
      await c.restore();
      expect(c.state.status, SessionStatus.anonymous);
    });

    test('stored session -> loads the profile', () async {
      final h = await Harness.create(
        store: InMemoryTokenStore(validSession()),
        handler: (o) => FakeResponse.ok(userJson()),
      );
      final c = await h.session();
      expect(c.state.isSignedIn, isTrue);
      expect(c.state.user?.displayName, 'Alice');
    });

    test(
      'a banned account lands on the banned state and loses its tokens',
      () async {
        final h = await Harness.create(
          store: InMemoryTokenStore(validSession()),
          handler: (o) =>
              FakeResponse.problem(403, 'account_banned', detail: 'Banned'),
        );
        final c = await h.session();
        expect(c.state.status, SessionStatus.banned);
        expect(await h.store.read(), isNull);
      },
    );

    test('the network layer ending the session reaches the cubit', () async {
      final h = await Harness.create(
        store: InMemoryTokenStore(validSession()),
        handler: (o) => FakeResponse.ok(userJson()),
      );
      final c = await h.session();
      h.deps.onSessionLost!('session_revoked');
      expect(c.state.status, SessionStatus.anonymous);
      expect(c.state.reason, 'session_revoked');
    });

    test('sign out clears the session and the social login', () async {
      final h = await Harness.create(
        store: InMemoryTokenStore(validSession()),
        handler: (o) => FakeResponse.ok(userJson()),
      );
      final c = await h.session();
      await c.signOut();
      expect(c.state.status, SessionStatus.anonymous);
      expect(h.social.signedOut, isTrue);
      expect(await h.store.read(), isNull);
    });

    test('patchUser updates the gem balance in place', () async {
      final h = await Harness.create(
        store: InMemoryTokenStore(validSession()),
        handler: (o) => FakeResponse.ok(userJson()),
      );
      final c = await h.session();
      c.patchUser((u) => u.copyWith(gems: 42));
      expect(c.state.user?.gems, 42);
    });
  });

  group('AuthScreen', () {
    Handler routes(FakeResponse Function(String path) f) =>
        (o) => o.path.endsWith('/init')
        ? FakeResponse.ok({'settings': {}, 'demoMode': false})
        : f(o.path);

    testWidgets('validates, signs in and updates the session', (tester) async {
      final h = await Harness.create(
        handler: routes((_) => FakeResponse.ok(authJson())),
      );
      final session = SessionCubit(h.deps);
      await tester.pumpWidget(h.app(const AuthScreen(), session: session));
      await tester.tap(find.byKey(const Key('submit')));
      await tester.pump();
      expect(find.text('Required'), findsWidgets);

      await tester.enterText(find.byKey(const Key('identifier')), 'alice');
      await tester.enterText(find.byKey(const Key('password')), 'secret');
      await tester.tap(find.byKey(const Key('submit')));
      await tester.pumpAndSettle();
      expect(h.adapter.where('POST', '/auth/login'), hasLength(1));
      expect(session.state.isSignedIn, isTrue);
    });

    testWidgets('shows the server message and field errors on failure', (
      tester,
    ) async {
      final h = await Harness.create(
        handler: routes(
          (_) => FakeResponse.problem(
            422,
            'validation_failed',
            errors: [
              {'path': 'username', 'message': 'Username taken'},
            ],
          ),
        ),
      );
      await tester.pumpWidget(h.app(const AuthScreen()));
      await tester.tap(find.text('Create account').first);
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('identifier')), 'a@b.co');
      await tester.enterText(find.byKey(const Key('username')), 'alice');
      await tester.enterText(find.byKey(const Key('password')), 'longenough1');
      await tester.tap(find.byKey(const Key('submit')));
      await tester.pumpAndSettle();
      expect(find.text('Username taken'), findsOneWidget);
      expect(find.byKey(const Key('auth-error')), findsOneWidget);
    });

    testWidgets('guest button signs in as guest', (tester) async {
      final h = await Harness.create(
        handler: routes((_) => FakeResponse.ok(authJson({'isGuest': true}))),
      );
      await tester.pumpWidget(h.app(const AuthScreen()));
      await tester.ensureVisible(find.byKey(const Key('guest')));
      await tester.tap(find.byKey(const Key('guest')));
      await tester.pumpAndSettle();
      expect(h.adapter.where('POST', '/auth/guest'), hasLength(1));
    });

    testWidgets('google sign-in sends the Firebase token', (tester) async {
      final h = await Harness.create(
        social: FakeSocial('x' * 30),
        handler: routes((_) => FakeResponse.ok(authJson())),
      );
      await tester.pumpWidget(h.app(const AuthScreen()));
      await tester.ensureVisible(find.byKey(const Key('google')));
      await tester.tap(find.byKey(const Key('google')));
      await tester.pumpAndSettle();
      expect(h.adapter.where('POST', '/auth/social').single.data, {
        'idToken': 'x' * 30,
      });
    });
  });

  test('ApiException helper text', () {
    expect(
      errorText(const ApiException(status: 500, code: 'x', message: 'Boom')),
      'Boom',
    );
    expect(errorText(StateError('x'), 'Fallback'), 'Fallback');
  });
}
