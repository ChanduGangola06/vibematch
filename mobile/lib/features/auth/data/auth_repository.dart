import '../../../core/errors/failure.dart';
import '../../../core/network/api_client.dart';
import '../../../core/storage/token_store.dart';
import '../domain/user.dart';

class AuthResult {
  const AuthResult(this.user, {this.isNewUser = false});

  final AppUser user;
  final bool isNewUser;
}

/// Raised when an admin account must sign in with a passkey (WebAuthn) - not supported on mobile.
class PasskeyRequired implements Exception {
  const PasskeyRequired();
}

class AuthRepository {
  AuthRepository(this._api, this._store, {DateTime Function()? clock})
    : _clock = clock ?? DateTime.now;

  final ApiClient _api;
  final TokenStore _store;
  final DateTime Function() _clock;

  Future<AuthResult> _complete(Object? data) async {
    final m = (data! as Map).cast<String, Object?>();
    if (m['status'] == 'passkey_required') throw const PasskeyRequired();
    await _store.write(sessionFromTokens((m['tokens']! as Map), clock: _clock));
    return AuthResult(
      AppUser.fromJson((m['user']! as Map).cast<String, Object?>()),
      isNewUser: m['isNewUser'] == true,
    );
  }

  Future<AuthResult> login(String identifier, String password) async =>
      _complete(
        await _api.post(
          '/auth/login',
          body: {'identifier': identifier, 'password': password},
        ),
      );

  Future<AuthResult> register({
    required String username,
    required String email,
    required String password,
    String? name,
    String? gender,
  }) async => _complete(
    await _api.post(
      '/auth/register',
      body: {
        'username': username,
        'email': email,
        'password': password,
        if (name != null && name.isNotEmpty) 'name': name,
        'gender': ?gender,
      },
    ),
  );

  Future<AuthResult> guest() async => _complete(await _api.post('/auth/guest'));

  /// [idToken] is a Firebase ID token (Google / Apple / phone sign-in done on the device).
  Future<AuthResult> social(String idToken, {String? gender}) async =>
      _complete(
        await _api.post(
          '/auth/social',
          body: {'idToken': idToken, 'gender': ?gender},
        ),
      );

  Future<AppUser> me() async => AppUser.fromJson(
    ((await _api.get('/auth/me'))! as Map).cast<String, Object?>(),
  );

  Future<bool> usernameAvailable(String username) async {
    final d =
        (await _api.get(
              '/users/check-username',
              query: {'username': username},
            ))!
            as Map;
    return d['available'] == true;
  }

  Future<bool> hasSession() async => (await _store.read()) != null;

  Future<void> logout() async {
    final s = await _store.read();
    try {
      if (s != null)
        await _api.post('/auth/logout', body: {'refreshToken': s.refreshToken});
    } on ApiException {
      // local sign-out must always succeed
    } finally {
      await _store.clear();
    }
  }
}
