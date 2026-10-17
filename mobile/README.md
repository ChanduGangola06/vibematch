# VibeMatch mobile (Flutter)

Feature-first Clean Architecture (`lib/features/<feature>/{data,domain,presentation}`), flutter_bloc, go_router, dio.

**Toolchain:** pinned with FVM (`.fvmrc` -> Flutter 3.47.2). Run everything through `fvm`:

```bash
fvm install            # once
fvm flutter pub get
fvm dart format lib test integration_test
fvm flutter analyze
fvm flutter test       # 68 tests, all passing
fvm flutter test integration_test --dart-define=API_BASE_URL=http://10.0.2.2:5000 --dart-define=API_KEY=<mobile-level key>   # needs a device + running backend
```

**State management:** `flutter_bloc` (Cubits). Dependencies are built once in `lib/core/di/dependencies.dart`
and provided with a `RepositoryProvider`; app-wide cubits (session, translator, site settings, inbox, unread,
matching, purchase) are created in `lib/app.dart` above `MaterialApp`, so sheets and routes can read them.

**Status:** `analyze` has no errors/warnings in `lib` (a few style infos remain in test helpers); unit and widget
tests pass. Not yet run: the integration test and anything touching real WebRTC, IAP, FCM, AdMob or Firebase.

## Configuration (compile-time, no secrets in the bundle)

| `--dart-define` | Meaning |
|---|---|
| `API_BASE_URL` | Server origin, e.g. `https://api.example.com` (no trailing slash, no `/api/v1`) |
| `API_KEY` | A *mobile-level* API key created in Admin -> API keys. It identifies the app; it is not a user credential. |
| `PINNED_SHA256` | Optional comma-separated SHA-256 certificate fingerprints to pin |

## Firebase
`android/app/google-services.json` and `ios/Runner/GoogleService-Info.plist` are carried over from the
original template and belong to its author. **Replace them with your own Firebase project's files.**

## Known unverified areas
Platform plugin wrappers in `lib/services` (WebRTC, IAP, Socket.IO, Google sign-in) compile but have only been
exercised through fakes; test them on a device.

## Not implemented yet
- AdMob (`google_mobile_ads` is a dependency; no ad widgets/service yet).
- FCM token registration on sign-in (`lib/services/push_service.dart` exists, not wired).
- Stripe/WebView checkout screen (repository methods exist: `StoreRepository.stripeCheckoutUrl/verifyStripe`).
- Phone/Apple sign-in (Google + email + guest only), report dialog and gift-from-profile flows.
