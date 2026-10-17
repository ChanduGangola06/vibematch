import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../../../core/errors/failure.dart';
import '../../../core/network/api_client.dart';

/// Public site configuration from `/init` (needs the app's mobile-level API key).
/// Cached on the device so branding and login options still show when the network is down (RX.4).
class SiteSettings {
  const SiteSettings(this.groups, {this.demoMode = false});

  factory SiteSettings.fromJson(Map<String, Object?> j) => SiteSettings({
    for (final e in ((j['settings'] as Map?) ?? const {}).entries)
      if (e.value is Map)
        e.key as String: (e.value as Map).cast<String, Object?>(),
  }, demoMode: j['demoMode'] == true);

  static const empty = SiteSettings({});

  final Map<String, Map<String, Object?>> groups;
  final bool demoMode;

  T get<T>(String group, String key, T fallback) {
    final v = groups[group]?[key];
    return v is T ? v : fallback;
  }

  String get siteName => get('general', 'siteName', 'VibeMatch');
  bool get guestLogin => get('auth', 'guestLogin', true);
  bool get googleLogin => get('auth', 'googleLogin', true);
  bool get stripeEnabled => get('payments', 'stripeEnabled', false);
  String get currency => get('payments', 'currency', 'USD');
  bool get adsEnabled => get('plugins', 'enableAds', false);
  String get termsUrl => get('general', 'termsUrl', '');
  String get privacyUrl => get('general', 'privacyUrl', '');

  Map<String, Object?> toJson() => {'settings': groups, 'demoMode': demoMode};
}

class SettingsRepository {
  SettingsRepository(this._api, this._prefs);

  final ApiClient _api;
  final SharedPreferences _prefs;
  static const _k = 'vm.settings';

  SiteSettings cached() {
    final raw = _prefs.getString(_k);
    if (raw == null) return SiteSettings.empty;
    try {
      return SiteSettings.fromJson(
        (jsonDecode(raw) as Map).cast<String, Object?>(),
      );
    } on FormatException {
      return SiteSettings.empty;
    }
  }

  Future<SiteSettings> load() async {
    try {
      final d = (await _api.get('/init'))! as Map;
      final s = SiteSettings.fromJson(d.cast<String, Object?>());
      await _prefs.setString(_k, jsonEncode(s.toJson()));
      return s;
    } on ApiException {
      return cached();
    }
  }
}
