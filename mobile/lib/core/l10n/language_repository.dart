import 'package:shared_preferences/shared_preferences.dart';

import '../network/api_client.dart';
import 'translator.dart';

class LanguageInfo {
  const LanguageInfo({
    required this.code,
    required this.name,
    required this.flag,
    required this.rtl,
  });

  factory LanguageInfo.fromJson(Map<String, Object?> j) => LanguageInfo(
    code: j['code']! as String,
    name: (j['name'] as String?) ?? j['code']! as String,
    flag: (j['flag'] as String?) ?? '',
    rtl: j['rtl'] == true,
  );

  final String code;
  final String name;
  final String flag;
  final bool rtl;
}

class LanguageRepository {
  LanguageRepository(this._api, this._prefs);

  final ApiClient _api;
  final SharedPreferences _prefs;
  static const _kCode = 'vm.lang';
  static String _kPack(String c) => 'vm.lang.pack.$c';

  String get savedCode => _prefs.getString(_kCode) ?? 'en';
  Future<void> saveCode(String code) => _prefs.setString(_kCode, code);

  Future<List<LanguageInfo>> list() async {
    final d = await _api.get('/languages');
    return [
      for (final e in (d as List? ?? const []))
        LanguageInfo.fromJson((e as Map).cast<String, Object?>()),
    ];
  }

  /// Network first; falls back to the last pack stored on the device so the app stays translated offline.
  Future<Translator> load(String code) async {
    if (code == 'en') return const Translator();
    try {
      final d = (await _api.get('/languages/$code'))! as Map;
      final messages = {
        for (final e in ((d['translations'] as Map?) ?? const {}).entries)
          e.key as String: '${e.value}',
      };
      final t = Translator(
        code: code,
        rtl: d['rtl'] == true,
        messages: messages,
      );
      await _prefs.setString(
        _kPack(code),
        '${d['rtl'] == true ? 1 : 0}|${_encode(messages)}',
      );
      return t;
    } on Object {
      final cached = _prefs.getString(_kPack(code));
      if (cached == null) return Translator(code: code);
      final split = cached.indexOf('|');
      return Translator(
        code: code,
        rtl: cached.startsWith('1'),
        messages: _decode(cached.substring(split + 1)),
      );
    }
  }

  static String _encode(Map<String, String> m) => m.entries
      .map(
        (e) => '${Uri.encodeComponent(e.key)}=${Uri.encodeComponent(e.value)}',
      )
      .join('&');
  static Map<String, String> _decode(String s) {
    if (s.isEmpty) return {};
    return {
      for (final p in s.split('&'))
        if (p.contains('='))
          Uri.decodeComponent(p.substring(0, p.indexOf('='))):
              Uri.decodeComponent(p.substring(p.indexOf('=') + 1)),
    };
  }
}
