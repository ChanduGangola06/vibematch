import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/dependencies.dart';
import '../../../core/errors/failure.dart';
import '../domain/user.dart';

enum SessionStatus { loading, anonymous, authenticated, banned }

class SessionState {
  const SessionState(this.status, {this.user, this.reason});

  final SessionStatus status;
  final AppUser? user;
  final String? reason;

  bool get isSignedIn => status == SessionStatus.authenticated && user != null;
}

/// Who is signed in. The router, shell and every feature watch this.
class SessionCubit extends Cubit<SessionState> {
  SessionCubit(this._deps) : super(const SessionState(SessionStatus.loading)) {
    _deps.onSessionLost = sessionLost;
  }

  final AppDependencies _deps;

  /// Cold start: if tokens exist, load the profile (the interceptor refreshes an expired access token).
  Future<void> restore() async {
    if (!await _deps.auth.hasSession()) {
      emit(const SessionState(SessionStatus.anonymous));
      return;
    }
    try {
      emit(
        SessionState(SessionStatus.authenticated, user: await _deps.auth.me()),
      );
    } on ApiException catch (e) {
      // Tokens stay in the store, so an offline cold start recovers on the next launch; a rejected
      // session was already cleared by the interceptor.
      emit(
        e.code == 'account_banned'
            ? SessionState(SessionStatus.banned, reason: e.message)
            : const SessionState(SessionStatus.anonymous),
      );
    }
  }

  void signedIn(AppUser user) =>
      emit(SessionState(SessionStatus.authenticated, user: user));

  Future<void> signOut() async {
    await _deps.auth.logout();
    try {
      await _deps.social.signOut();
    } on Object {
      // not signed in with a social provider
    }
    emit(const SessionState(SessionStatus.anonymous));
  }

  void sessionLost(String reason) => emit(
    reason == 'account_banned'
        ? SessionState(SessionStatus.banned, reason: reason)
        : SessionState(SessionStatus.anonymous, reason: reason),
  );

  void patchUser(AppUser Function(AppUser) change) {
    final u = state.user;
    if (u != null) emit(SessionState(state.status, user: change(u)));
  }

  Future<void> reloadUser() async {
    if (!state.isSignedIn) return;
    try {
      emit(
        SessionState(SessionStatus.authenticated, user: await _deps.auth.me()),
      );
    } on ApiException {
      // keep the cached profile
    }
  }
}
