import 'package:flutter_test/flutter_test.dart';
import 'package:vibematch/core/router/app_router.dart';
import 'package:vibematch/features/auth/presentation/session_cubit.dart';

void main() {
  String? r(SessionStatus s, {bool onboarded = true, String at = '/'}) =>
      redirectFor(status: s, onboarded: onboarded, location: at);

  test('loading shows the splash', () {
    expect(r(SessionStatus.loading), '/splash');
    expect(r(SessionStatus.loading, at: '/splash'), isNull);
  });
  test('banned accounts are locked on the banned screen', () {
    expect(r(SessionStatus.banned, at: '/messages'), '/banned');
    expect(r(SessionStatus.banned, at: '/banned'), isNull);
  });
  test('signed-out people go through onboarding once, then to sign in', () {
    expect(r(SessionStatus.anonymous, onboarded: false), '/onboarding');
    expect(r(SessionStatus.anonymous, at: '/messages'), '/auth');
    expect(r(SessionStatus.anonymous, at: '/auth'), isNull);
    expect(
      r(SessionStatus.anonymous, onboarded: false, at: '/onboarding'),
      isNull,
    );
  });
  test('signed-in people skip auth screens and leave the splash', () {
    expect(r(SessionStatus.authenticated, at: '/auth'), '/');
    expect(r(SessionStatus.authenticated, at: '/splash'), '/');
    expect(r(SessionStatus.authenticated, at: '/messages'), isNull);
  });
  test(
    'after loading, anonymous users leave the splash for the right screen',
    () {
      expect(r(SessionStatus.anonymous, at: '/splash'), '/auth');
      expect(
        r(SessionStatus.anonymous, onboarded: false, at: '/splash'),
        '/onboarding',
      );
    },
  );
}
