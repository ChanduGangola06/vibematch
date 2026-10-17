import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vibematch/core/config/app_config.dart';
import 'package:vibematch/core/di/dependencies.dart';
import 'package:vibematch/core/l10n/translator_cubit.dart';
import 'package:vibematch/core/storage/token_store.dart';
import 'package:vibematch/features/auth/presentation/session_cubit.dart';
import 'package:vibematch/features/settings/presentation/site_settings_cubit.dart';
import 'package:vibematch/services/iap_port.dart';
import 'package:vibematch/services/social_sign_in.dart';

import 'fake_adapter.dart';
import 'fakes.dart';

const testConfig = AppConfig(apiBaseUrl: 'http://api.test', apiKey: 'k');

class FakeSocial implements SocialSignIn {
  FakeSocial([this.token]);

  String? token;
  bool signedOut = false;

  @override
  Future<String?> googleIdToken() async => token;

  @override
  Future<void> signOut() async => signedOut = true;
}

Map<String, Object?> userJson([Map<String, Object?> over = const {}]) => {
  'id': 'u1',
  'username': 'alice',
  'name': 'Alice',
  'avatar': '',
  'gender': 'female',
  'country': 'France',
  'countryCode': 'FR',
  'bio': '',
  'gems': 300,
  'likesCount': 0,
  'followersCount': 0,
  'followingCount': 0,
  'isVip': false,
  'isGuest': false,
  'role': 'user',
  'email': 'a@x.io',
  ...over,
};

Map<String, Object?> authJson([Map<String, Object?> over = const {}]) => {
  'status': 'authenticated',
  'isNewUser': false,
  'tokens': {
    'accessToken': 'acc',
    'refreshToken': 'ref',
    'tokenType': 'Bearer',
    'expiresIn': 900,
  },
  'user': userJson(over),
};

Session validSession() => Session(
  accessToken: 'acc',
  refreshToken: 'ref',
  expiresAt: DateTime.now().add(const Duration(minutes: 10)),
);

class FakeIap implements IapPort {
  final controller = StreamController<IapPurchase>.broadcast();
  final completed = <String>[];
  final bought = <String>[];
  bool available = true;

  @override
  Future<bool> isAvailable() async => available;
  @override
  Stream<IapPurchase> get updates => controller.stream;
  @override
  Future<void> buy(String productId) async => bought.add(productId);
  @override
  Future<void> complete(IapPurchase p) async => completed.add(p.productId);
}

/// Real repositories + blocs on a scriptable transport and fake platform plugins.
class Harness {
  Harness._(
    this.deps,
    this.adapter,
    this.socket,
    this.media,
    this.iap,
    this.social,
    this.peers,
  );

  static Future<Harness> create({
    Handler? handler,
    TokenStore? store,
    Map<String, Object> prefs = const {},
    FakeSocial? social,
  }) async {
    SharedPreferences.setMockInitialValues(prefs);
    final adapter = FakeAdapter(handler ?? (o) => FakeResponse.ok({}));
    final socket = FakeSocketPort();
    final media = FakeMedia();
    final iap = FakeIap();
    final sosh = social ?? FakeSocial();
    final peers = <FakePeer>[];
    final deps = AppDependencies.create(
      config: testConfig,
      prefs: await SharedPreferences.getInstance(),
      social: sosh,
      socket: (_, _) => socket,
      media: media,
      peerFactory: ({required iceServers, required local, required initiator}) {
        final p = FakePeer(initiator: initiator);
        peers.add(p);
        return p;
      },
      iap: iap,
      isApple: false,
      tokenStore: store ?? InMemoryTokenStore(),
      adapter: adapter,
      retrySleep: (_) async {},
    );
    return Harness._(deps, adapter, socket, media, iap, sosh, peers);
  }

  final AppDependencies deps;
  final FakeAdapter adapter;
  final FakeSocketPort socket;
  final FakeMedia media;
  final FakeIap iap;
  final FakeSocial social;
  final List<FakePeer> peers;

  TokenStore get store => deps.tokenStore;

  /// A restored, signed-in session cubit (needs a handler answering `/auth/me`).
  Future<SessionCubit> session() async {
    final c = SessionCubit(deps);
    await c.restore();
    return c;
  }

  /// Wraps [home] with the dependencies and the blocs screens expect.
  Widget app(Widget home, {SessionCubit? session}) =>
      RepositoryProvider<AppDependencies>.value(
        value: deps,
        child: MultiBlocProvider(
          providers: [
            BlocProvider(create: (_) => session ?? SessionCubit(deps)),
            BlocProvider(create: (_) => TranslatorCubit(deps.languages)),
            BlocProvider(create: (_) => SiteSettingsCubit(deps.settings)),
          ],
          child: MaterialApp(home: home),
        ),
      );
}
