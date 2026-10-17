import '../../../core/network/api_client.dart';
import '../domain/store_models.dart';

class StoreRepository {
  StoreRepository(this._api);

  final ApiClient _api;

  List<T> _list<T>(Object? d, T Function(Map<String, Object?>) f) => [
    for (final e in (d as List? ?? const []))
      f((e as Map).cast<String, Object?>()),
  ];

  Future<List<GemPack>> packs() async =>
      _list(await _api.get('/packs'), GemPack.fromJson);
  Future<List<VipPlan>> vipPlans() async =>
      _list(await _api.get('/vip-plans'), VipPlan.fromJson);
  Future<List<Gift>> gifts() async =>
      _list(await _api.get('/gifts'), Gift.fromJson);

  /// Server-side verification with Google Play / App Store. Idempotent: replaying the same receipt
  /// returns `alreadyProcessed` instead of crediting twice.
  Future<FulfilResult> verifyStorePurchase({
    required String platform,
    required String packId,
    required String receipt,
  }) async {
    final d = await _api.post(
      '/payments/$platform/verify',
      body: {'packId': packId, 'receipt': receipt},
      idempotent: true,
    );
    return FulfilResult.fromJson((d! as Map).cast<String, Object?>());
  }

  /// Hosted checkout (Stripe) for devices without store billing; returns the URL to open in a WebView.
  Future<String> stripeCheckoutUrl(String packId, String returnUrl) async {
    final d =
        (await _api.post(
              '/payments/stripe/checkout',
              body: {'packId': packId, 'returnUrl': returnUrl},
            ))!
            as Map;
    return d['url']! as String;
  }

  Future<FulfilResult> verifyStripe(String sessionId) async =>
      FulfilResult.fromJson(
        ((await _api.post(
                  '/payments/stripe/verify',
                  body: {'sessionId': sessionId},
                  idempotent: true,
                ))!
                as Map)
            .cast<String, Object?>(),
      );

  /// Returns the new gem balance.
  Future<int> subscribe(String planId) async =>
      (((await _api.post('/vip-plans/$planId/subscribe', idempotent: true))!
                  as Map)['balance']
              as num)
          .toInt();
}
