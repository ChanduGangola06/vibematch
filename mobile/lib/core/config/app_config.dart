/// Compile-time configuration. Nothing here is a secret a user could not extract anyway:
/// the API key only *identifies the app* and caps privilege server-side (see docs/security).
class AppConfig {
  const AppConfig({
    required this.apiBaseUrl,
    required this.apiKey,
    this.pinnedSha256 = const [],
    this.apiVersion = '1',
  });

  factory AppConfig.fromEnvironment() => AppConfig(
    apiBaseUrl: const String.fromEnvironment(
      'API_BASE_URL',
      defaultValue: 'http://10.0.2.2:5000',
    ),
    apiKey: const String.fromEnvironment('API_KEY'),
    pinnedSha256: const String.fromEnvironment(
      'PINNED_SHA256',
    ).split(',').map((e) => e.trim()).where((e) => e.isNotEmpty).toList(),
  );

  final String apiBaseUrl;
  final String apiKey;
  final List<String> pinnedSha256;
  final String apiVersion;

  String get apiRoot => '${apiBaseUrl.replaceAll(RegExp(r'/+$'), '')}/api/v1';
  String get socketUrl => apiBaseUrl.replaceAll(RegExp(r'/+$'), '');

  /// Turns server-relative asset paths ("/images/gift/rose.svg") into absolute URLs.
  String absoluteUrl(String path) {
    if (path.isEmpty) return path;
    if (path.startsWith('http://') || path.startsWith('https://')) return path;
    return '${apiBaseUrl.replaceAll(RegExp(r'/+$'), '')}${path.startsWith('/') ? '' : '/'}$path';
  }
}
