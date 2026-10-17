import 'package:firebase_auth/firebase_auth.dart';
import 'package:google_sign_in/google_sign_in.dart';

/// Returns a Firebase ID token for the backend's `/auth/social`, or null when the person cancelled.
/// An interface so screens and tests never touch the platform plugins.
abstract class SocialSignIn {
  Future<String?> googleIdToken();
  Future<void> signOut();
}

class FirebaseSocialSignIn implements SocialSignIn {
  FirebaseSocialSignIn({GoogleSignIn? google, FirebaseAuth? auth})
    : _googleOverride = google,
      _authOverride = auth;

  // Created on first use: without a Firebase project configured (`Firebase.initializeApp` failed),
  // touching FirebaseAuth.instance throws, and that must only affect the Google button, not app start.
  final GoogleSignIn? _googleOverride;
  final FirebaseAuth? _authOverride;
  late final GoogleSignIn _google = _googleOverride ?? GoogleSignIn(scopes: const ['email']);
  late final FirebaseAuth _auth = _authOverride ?? FirebaseAuth.instance;

  @override
  Future<String?> googleIdToken() async {
    final account = await _google.signIn();
    if (account == null) return null;
    final tokens = await account.authentication;
    final cred = GoogleAuthProvider.credential(
      idToken: tokens.idToken,
      accessToken: tokens.accessToken,
    );
    final signedIn = await _auth.signInWithCredential(cred);
    return signedIn.user?.getIdToken();
  }

  @override
  Future<void> signOut() async {
    await _google.signOut();
    await _auth.signOut();
  }
}
