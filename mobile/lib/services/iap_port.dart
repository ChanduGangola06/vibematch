import 'dart:async';
import 'dart:io' show Platform;

import 'package:in_app_purchase/in_app_purchase.dart';

enum IapStatus { purchased, pending, canceled, error }

class IapPurchase {
  const IapPurchase({
    required this.productId,
    required this.status,
    this.receipt = '',
    this.platform = 'google',
    this.message,
    this.handle,
  });

  final String productId;
  final IapStatus status;

  /// Google: purchase token. Apple: base64 receipt. The server verifies it with the store - the app never decides.
  final String receipt;
  final String platform;
  final String? message;

  /// Opaque plugin object needed to complete the purchase.
  final Object? handle;
}

abstract class IapPort {
  Future<bool> isAvailable();
  Stream<IapPurchase> get updates;
  Future<void> buy(String productId);
  Future<void> complete(IapPurchase purchase);
}

class StoreIap implements IapPort {
  StoreIap([InAppPurchase? iap]) : _iap = iap ?? InAppPurchase.instance;

  final InAppPurchase _iap;

  @override
  Future<bool> isAvailable() => _iap.isAvailable();

  @override
  Stream<IapPurchase> get updates =>
      _iap.purchaseStream.expand((list) => list.map(_map));

  IapPurchase _map(PurchaseDetails d) {
    final status = switch (d.status) {
      PurchaseStatus.purchased ||
      PurchaseStatus.restored => IapStatus.purchased,
      PurchaseStatus.pending => IapStatus.pending,
      PurchaseStatus.canceled => IapStatus.canceled,
      PurchaseStatus.error => IapStatus.error,
    };
    return IapPurchase(
      productId: d.productID,
      status: status,
      receipt: d.verificationData.serverVerificationData,
      platform: Platform.isIOS ? 'apple' : 'google',
      message: d.error?.message,
      handle: d,
    );
  }

  @override
  Future<void> buy(String productId) async {
    final res = await _iap.queryProductDetails({productId});
    if (res.productDetails.isEmpty)
      throw StateError('Product $productId is not available in the store');
    // Gem packs are consumable: they can be bought again.
    await _iap.buyConsumable(
      purchaseParam: PurchaseParam(productDetails: res.productDetails.first),
    );
  }

  @override
  Future<void> complete(IapPurchase purchase) async {
    final h = purchase.handle;
    if (h is PurchaseDetails && h.pendingCompletePurchase)
      await _iap.completePurchase(h);
  }
}
