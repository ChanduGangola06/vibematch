import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vibematch/app.dart';
import 'package:vibematch/core/config/app_config.dart';
import 'package:vibematch/core/di/dependencies.dart';
import 'package:vibematch/core/storage/token_store.dart';
import 'package:vibematch/services/iap_port.dart';
import 'package:vibematch/services/social_sign_in.dart';
import 'package:vibematch/services/socket_port.dart';
import 'package:vibematch/services/webrtc.dart';

/// Smoke flow against a running backend:
///   fvm flutter test integration_test --dart-define=API_BASE_URL=http://10.0.2.2:5000 --dart-define=API_KEY=KEY
/// onboarding -> continue as guest -> home screen with the "Start video chat" button.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('guest can get from first launch to the home screen', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({});
    final config = AppConfig.fromEnvironment();
    final deps = AppDependencies.create(
      config: config,
      prefs: await SharedPreferences.getInstance(),
      social: FirebaseSocialSignIn(),
      socket: (c, store) => IoSocketPort(
        url: c.socketUrl,
        tokenProvider: () async => (await store.read())?.accessToken,
      ),
      media: DeviceMedia(),
      peerFactory:
          ({required iceServers, required local, required initiator}) =>
              RtcPeer(
                iceServers: iceServers,
                local: local,
                initiator: initiator,
              ),
      iap: StoreIap(),
      isApple: false,
      tokenStore: InMemoryTokenStore(),
    );
    await tester.pumpWidget(VibeMatchApp(deps: deps));
    await tester.pumpAndSettle(const Duration(seconds: 2));

    await tester.tap(find.byKey(const Key('skip')));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const Key('guest')));
    await tester.tap(find.byKey(const Key('guest')));
    await tester.pumpAndSettle(const Duration(seconds: 3));

    expect(find.byKey(const Key('start')), findsOneWidget);
  });
}
