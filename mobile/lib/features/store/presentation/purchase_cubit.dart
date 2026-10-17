import 'dart:async';

import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/dependencies.dart';
import '../../../core/errors/failure.dart';
import '../../../services/iap_port.dart';
import '../../auth/presentation/session_cubit.dart';
import '../domain/store_models.dart';

class PurchaseState {
  const PurchaseState({this.busyPackId, this.message, this.error});

  final String? busyPackId;
  final String? message;
  final String? error;
}

/// Store purchase flow. The device only *reports* a purchase; the server verifies it with Google/Apple and
/// credits the gems. A purchase is completed (consumed) only after the server accepted it, so a crash or a
/// network error mid-way is retried on the next launch instead of losing the money.
class PurchaseCubit extends Cubit<PurchaseState> {
  PurchaseCubit(this._deps, this._session) : super(const PurchaseState()) {
    _sub = _deps.iap.updates.listen(
      _onUpdate,
      onError: (Object e) => emit(PurchaseState(error: '$e')),
    );
  }

  final AppDependencies _deps;
  final SessionCubit _session;
  late final StreamSubscription<IapPurchase> _sub;
  final _packByProduct = <String, GemPack>{};

  String? _productId(GemPack p) => _deps.isApple ? p.applePayId : p.googlePayId;

  Future<void> buy(GemPack pack) async {
    final user = _session.state.user;
    if (user == null || user.isGuest) {
      emit(const PurchaseState(error: 'Create an account to buy gems'));
      return;
    }
    final productId = _productId(pack);
    if (productId == null || !await _deps.iap.isAvailable()) {
      emit(
        const PurchaseState(
          error: 'In-app purchases are not available on this device',
        ),
      );
      return;
    }
    _packByProduct[productId] = pack;
    emit(PurchaseState(busyPackId: pack.id));
    try {
      await _deps.iap.buy(productId);
    } on Object catch (e) {
      emit(PurchaseState(error: '$e'));
    }
  }

  Future<void> _onUpdate(IapPurchase p) async {
    switch (p.status) {
      case IapStatus.pending:
        return;
      case IapStatus.canceled:
        emit(const PurchaseState());
        await _deps.iap.complete(p);
      case IapStatus.error:
        emit(PurchaseState(error: p.message ?? 'Purchase failed'));
        await _deps.iap.complete(p);
      case IapStatus.purchased:
        final pack = _packByProduct[p.productId] ?? await _lookup(p.productId);
        if (pack == null) {
          emit(const PurchaseState(error: 'Unknown product'));
          return;
        }
        try {
          final r = await _deps.store.verifyStorePurchase(
            platform: p.platform,
            packId: pack.id,
            receipt: p.receipt,
          );
          _session.patchUser((u) => u.copyWith(gems: r.balance));
          await _deps.iap.complete(p);
          emit(
            PurchaseState(
              message: r.alreadyProcessed
                  ? 'Already credited'
                  : '${r.gems} gems added!',
            ),
          );
        } on ApiException catch (e) {
          // Not completed on purpose: the store re-delivers the purchase and verification is retried.
          emit(PurchaseState(error: e.message));
        }
    }
  }

  Future<GemPack?> _lookup(String productId) async {
    try {
      final packs = await _deps.store.packs();
      return packs
          .where((x) => x.googlePayId == productId || x.applePayId == productId)
          .firstOrNull;
    } on ApiException {
      return null;
    }
  }

  /// Gem-priced VIP subscription. Throws [ApiException] (e.g. `insufficient_gems`).
  Future<void> subscribeVip(VipPlan plan) async {
    final balance = await _deps.store.subscribe(plan.id);
    _session.patchUser((u) => u.copyWith(gems: balance, isVip: true));
    await _session.reloadUser();
  }

  @override
  Future<void> close() async {
    await _sub.cancel();
    return super.close();
  }
}
