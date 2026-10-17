import 'package:flutter/services.dart' show PlatformException;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class Session {
  const Session({
    required this.accessToken,
    required this.refreshToken,
    required this.expiresAt,
  });

  final String accessToken;
  final String refreshToken;
  final DateTime expiresAt;

  Duration timeLeft(DateTime now) => expiresAt.difference(now);
}

/// Where tokens live. The access token is short-lived; the refresh token is the long-lived secret
/// and therefore goes to the platform keystore (flutter_secure_storage), never SharedPreferences.
abstract class TokenStore {
  Future<Session?> read();
  Future<void> write(Session session);
  Future<void> clear();
}

class SecureTokenStore implements TokenStore {
  SecureTokenStore([FlutterSecureStorage? storage])
    : _storage =
          storage ??
          const FlutterSecureStorage(
            aOptions: AndroidOptions(encryptedSharedPreferences: true),
            iOptions: IOSOptions(
              accessibility: KeychainAccessibility.first_unlock_this_device,
            ),
          );

  final FlutterSecureStorage _storage;
  static const _kAccess = 'vm.access';
  static const _kRefresh = 'vm.refresh';
  static const _kExpires = 'vm.expires';

  /// Last known value, used when the platform keystore is unavailable (e.g. an unsigned simulator build
  /// without keychain entitlements fails with PlatformException -34018). Tokens then live only for this run
  /// instead of the app hanging on start-up.
  Session? _memory;
  bool _keystoreBroken = false;

  @override
  Future<Session?> read() async {
    if (_keystoreBroken) return _memory;
    try {
      final access = await _storage.read(key: _kAccess);
      final refresh = await _storage.read(key: _kRefresh);
      final expires = await _storage.read(key: _kExpires);
      if (access == null || refresh == null || expires == null) return _memory;
      final at = DateTime.tryParse(expires);
      if (at == null) return null;
      return Session(accessToken: access, refreshToken: refresh, expiresAt: at);
    } on PlatformException {
      _keystoreBroken = true;
      return _memory;
    }
  }

  @override
  Future<void> write(Session s) async {
    _memory = s;
    if (_keystoreBroken) return;
    try {
      await _storage.write(key: _kAccess, value: s.accessToken);
      await _storage.write(key: _kRefresh, value: s.refreshToken);
      await _storage.write(key: _kExpires, value: s.expiresAt.toUtc().toIso8601String());
    } on PlatformException {
      _keystoreBroken = true;
    }
  }

  @override
  Future<void> clear() async {
    _memory = null;
    if (_keystoreBroken) return;
    try {
      await _storage.delete(key: _kAccess);
      await _storage.delete(key: _kRefresh);
      await _storage.delete(key: _kExpires);
    } on PlatformException {
      _keystoreBroken = true;
    }
  }
}

/// For tests and previews.
class InMemoryTokenStore implements TokenStore {
  InMemoryTokenStore([this._session]);

  Session? _session;

  @override
  Future<Session?> read() async => _session;

  @override
  Future<void> write(Session session) async => _session = session;

  @override
  Future<void> clear() async => _session = null;
}
