import 'dart:io' show Platform;

import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'app.dart';
import 'core/config/app_config.dart';
import 'core/di/dependencies.dart';
import 'services/iap_port.dart';
import 'services/social_sign_in.dart';
import 'services/socket_port.dart';
import 'services/webrtc.dart';

/// Starts the app. Firebase failing to initialise (missing config) must not stop the app from opening.
Future<void> bootstrap() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    await Firebase.initializeApp();
  } on Object catch (e) {
    debugPrint('Firebase unavailable: $e');
  }
  final deps = AppDependencies.create(
    config: AppConfig.fromEnvironment(),
    prefs: await SharedPreferences.getInstance(),
    social: FirebaseSocialSignIn(),
    socket: (config, store) => IoSocketPort(
      url: config.socketUrl,
      tokenProvider: () async => (await store.read())?.accessToken,
    ),
    media: DeviceMedia(),
    peerFactory: ({required iceServers, required local, required initiator}) =>
        RtcPeer(iceServers: iceServers, local: local, initiator: initiator),
    iap: StoreIap(),
    isApple: Platform.isIOS,
  );
  runApp(VibeMatchApp(deps: deps));
}
