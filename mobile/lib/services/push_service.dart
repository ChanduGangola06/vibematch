import 'package:firebase_messaging/firebase_messaging.dart';

/// Push notifications. Registering the token is best-effort: the app works without it.
abstract class PushPort {
  Future<String?> requestToken();
  Stream<String> get tokenRefresh;
}

class FcmPush implements PushPort {
  FcmPush([FirebaseMessaging? fm]) : _fm = fm ?? FirebaseMessaging.instance;

  final FirebaseMessaging _fm;

  @override
  Future<String?> requestToken() async {
    final settings = await _fm.requestPermission();
    if (settings.authorizationStatus == AuthorizationStatus.denied) return null;
    return _fm.getToken();
  }

  @override
  Stream<String> get tokenRefresh => _fm.onTokenRefresh;
}
