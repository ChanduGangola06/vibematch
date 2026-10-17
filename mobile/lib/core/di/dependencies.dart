import 'package:dio/dio.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../features/auth/data/auth_repository.dart';
import '../../features/messages/data/message_repository.dart';
import '../../features/notifications/data/notification_repository.dart';
import '../../features/profile/data/profile_repository.dart';
import '../../features/settings/data/settings_repository.dart';
import '../../features/store/data/store_repository.dart';
import '../../services/iap_port.dart';
import '../../services/social_sign_in.dart';
import '../../services/socket_port.dart';
import '../../services/webrtc.dart';
import '../config/app_config.dart';
import '../l10n/language_repository.dart';
import '../network/api_client.dart';
import '../storage/token_store.dart';

/// Everything the blocs need, built once at startup and handed down with a `RepositoryProvider`.
/// Platform plugins arrive as interfaces, so tests pass fakes and nothing else changes.
class AppDependencies {
  AppDependencies._({
    required this.config,
    required this.tokenStore,
    required this.prefs,
    required this.api,
    required this.social,
    required this.socket,
    required this.media,
    required this.peerFactory,
    required this.iap,
    required this.isApple,
  }) : auth = AuthRepository(api, tokenStore),
       settings = SettingsRepository(api, prefs),
       languages = LanguageRepository(api, prefs),
       messages = MessageRepository(api),
       profile = ProfileRepository(api),
       notifications = NotificationRepository(api),
       store = StoreRepository(api);

  factory AppDependencies.create({
    required AppConfig config,
    required SharedPreferences prefs,
    required SocialSignIn social,
    required SocketPort Function(AppConfig, TokenStore) socket,
    required LocalMedia media,
    required PeerFactory peerFactory,
    required IapPort iap,
    required bool isApple,
    TokenStore? tokenStore,
    HttpClientAdapter? adapter,
    Future<void> Function(Duration)? retrySleep,
  }) {
    final store = tokenStore ?? SecureTokenStore();
    late final AppDependencies deps;
    final api = buildApiClient(
      config: config,
      store: store,
      adapter: adapter,
      retrySleep: retrySleep,
      onSessionLost: (reason) => deps.onSessionLost?.call(reason),
    );
    return deps = AppDependencies._(
      config: config,
      tokenStore: store,
      prefs: prefs,
      api: api,
      social: social,
      socket: socket(config, store),
      media: media,
      peerFactory: peerFactory,
      iap: iap,
      isApple: isApple,
    );
  }

  final AppConfig config;
  final TokenStore tokenStore;
  final SharedPreferences prefs;
  final ApiClient api;
  final SocialSignIn social;
  final SocketPort socket;
  final LocalMedia media;
  final PeerFactory peerFactory;
  final IapPort iap;
  final bool isApple;

  final AuthRepository auth;
  final SettingsRepository settings;
  final LanguageRepository languages;
  final MessageRepository messages;
  final ProfileRepository profile;
  final NotificationRepository notifications;
  final StoreRepository store;

  /// Set by the SessionCubit: called by the network layer when the server ends the session.
  void Function(String reason)? onSessionLost;
}
