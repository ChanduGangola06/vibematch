import 'dart:async';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:go_router/go_router.dart';

import '../../features/auth/presentation/auth_screen.dart';
import '../../features/auth/presentation/onboarding_screen.dart';
import '../../features/auth/presentation/session_cubit.dart';
import '../../features/home/presentation/shell_screen.dart';
import '../../features/matching/presentation/home_screen.dart';
import '../../features/messages/presentation/messages_screens.dart';
import '../../features/profile/presentation/profile_screens.dart';
import '../../features/settings/presentation/settings_screen.dart';
import '../l10n/tr_extension.dart';

/// Pure redirect rules so they can be unit-tested without a widget tree.
/// Guests and members share the shell; the auth screen is only for people who are signed out.
String? redirectFor({
  required SessionStatus status,
  required bool onboarded,
  required String location,
}) {
  if (status == SessionStatus.loading)
    return location == '/splash' ? null : '/splash';
  if (status == SessionStatus.banned)
    return location == '/banned' ? null : '/banned';
  if (location == '/splash' || location == '/banned')
    return status == SessionStatus.authenticated
        ? '/'
        : (onboarded ? '/auth' : '/onboarding');
  if (status == SessionStatus.anonymous) {
    if (!onboarded && location != '/onboarding') return '/onboarding';
    final open = location == '/auth' || location == '/onboarding';
    return open ? null : '/auth';
  }
  if (location == '/auth' || location == '/onboarding') return '/';
  return null;
}

/// Re-evaluates redirects whenever the session changes.
class _SessionListenable extends ChangeNotifier {
  _SessionListenable(Stream<SessionState> stream) {
    _sub = stream.listen((_) => notifyListeners());
  }

  late final StreamSubscription<SessionState> _sub;

  @override
  void dispose() {
    _sub.cancel();
    super.dispose();
  }
}

GoRouter buildRouter({
  required SessionCubit session,
  required SharedPreferences prefs,
}) {
  return GoRouter(
    initialLocation: '/splash',
    refreshListenable: _SessionListenable(session.stream),
    redirect: (context, state) => redirectFor(
      status: session.state.status,
      onboarded: prefs.getBool(kOnboardedKey) ?? false,
      location: state.matchedLocation,
    ),
    routes: [
      GoRoute(
        path: '/splash',
        builder: (_, _) =>
            const Scaffold(body: Center(child: CircularProgressIndicator())),
      ),
      GoRoute(path: '/banned', builder: (_, _) => const _BannedScreen()),
      GoRoute(
        path: '/onboarding',
        builder: (c, _) => OnboardingScreen(onDone: () => c.go('/auth')),
      ),
      GoRoute(path: '/auth', builder: (_, _) => const AuthScreen()),
      ShellRoute(
        builder: (_, state, child) =>
            ShellScreen(location: state.matchedLocation, child: child),
        routes: [
          GoRoute(path: '/', builder: (_, _) => const HomeScreen()),
          GoRoute(path: '/messages', builder: (_, _) => const InboxScreen()),
          GoRoute(path: '/settings', builder: (_, _) => const SettingsScreen()),
        ],
      ),
      GoRoute(
        path: '/chat/:partnerId',
        builder: (_, s) =>
            DirectChatScreen(partnerId: s.pathParameters['partnerId']!),
      ),
      GoRoute(
        path: '/u/:username',
        builder: (_, s) =>
            UserProfileScreen(username: s.pathParameters['username']!),
      ),
      GoRoute(
        path: '/edit-profile',
        builder: (_, _) => const EditProfileScreen(),
      ),
      GoRoute(
        path: '/delete-account',
        builder: (_, _) => const DeleteAccountScreen(),
      ),
    ],
  );
}

class _BannedScreen extends StatelessWidget {
  const _BannedScreen();

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Scaffold(
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.block_rounded, size: 72),
              const SizedBox(height: 16),
              Text(
                t('Your account has been suspended'),
                style: Theme.of(context).textTheme.titleLarge,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 8),
              Text(
                t('If you think this is a mistake, please contact support.'),
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
