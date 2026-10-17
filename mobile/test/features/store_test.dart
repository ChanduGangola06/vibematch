import 'package:flutter_test/flutter_test.dart';
import 'package:vibematch/core/storage/token_store.dart';
import 'package:vibematch/features/auth/presentation/session_cubit.dart';
import 'package:vibematch/features/store/presentation/purchase_cubit.dart';
import 'package:vibematch/services/iap_port.dart';

import '../helpers/fake_adapter.dart';
import '../helpers/harness.dart';

const pack = {
  'id': 'p1',
  'name': '100 gems',
  'description': '',
  'price': 4.99,
  'gems': 100,
  'popular': false,
  'googlePayId': 'gems_100',
};

void main() {
  late Harness h;
  late SessionCubit session;
  late PurchaseCubit cubit;
  var verifyStatus = 201;

  Future<void> setUp_({Map<String, Object?>? user}) async {
    verifyStatus = 201;
    h = await Harness.create(
      store: InMemoryTokenStore(validSession()),
      handler: (o) {
        if (o.path.endsWith('/auth/me'))
          return FakeResponse.ok(user ?? userJson());
        if (o.path.endsWith('/packs')) return FakeResponse.ok([pack]);
        if (o.path.endsWith('/payments/google/verify')) {
          return verifyStatus == 201
              ? FakeResponse.ok({
                  'balance': 400,
                  'gems': 100,
                  'purchaseId': 'x',
                  'alreadyProcessed': false,
                })
              : FakeResponse.problem(
                  verifyStatus,
                  'payment_verification_failed',
                  detail: 'Receipt rejected',
                );
        }
        return FakeResponse.ok({});
      },
    );
    session = await h.session();
    cubit = PurchaseCubit(h.deps, session);
    addTearDown(cubit.close);
  }

  Future<void> settle() =>
      Future<void>.delayed(const Duration(milliseconds: 20));

  test(
    'a verified purchase credits gems and then completes the store transaction',
    () async {
      await setUp_();
      final packs = await h.deps.store.packs();
      await cubit.buy(packs.single);
      expect(h.iap.bought, ['gems_100']);
      h.iap.controller.add(
        const IapPurchase(
          productId: 'gems_100',
          status: IapStatus.purchased,
          receipt: 'tok_receipt_value_123',
        ),
      );
      await settle();
      expect(session.state.user?.gems, 400);
      expect(h.iap.completed, ['gems_100']);
      final req = h.adapter.where('POST', '/payments/google/verify').single;
      expect(req.data, {'packId': 'p1', 'receipt': 'tok_receipt_value_123'});
      expect(req.headers['Idempotency-Key'], isNotNull);
    },
  );

  test(
    'a rejected receipt is NOT completed, so the store re-delivers it',
    () async {
      await setUp_();
      verifyStatus = 400;
      final packs = await h.deps.store.packs();
      await cubit.buy(packs.single);
      h.iap.controller.add(
        const IapPurchase(
          productId: 'gems_100',
          status: IapStatus.purchased,
          receipt: 'bad',
        ),
      );
      await settle();
      expect(h.iap.completed, isEmpty);
      expect(cubit.state.error, 'Receipt rejected');
      expect(session.state.user?.gems, 300);
    },
  );

  test('cancel and error clear the busy state', () async {
    await setUp_();
    final packs = await h.deps.store.packs();
    await cubit.buy(packs.single);
    expect(cubit.state.busyPackId, 'p1');
    h.iap.controller.add(
      const IapPurchase(productId: 'gems_100', status: IapStatus.canceled),
    );
    await settle();
    expect(cubit.state.busyPackId, isNull);
    h.iap.controller.add(
      const IapPurchase(
        productId: 'gems_100',
        status: IapStatus.error,
        message: 'Billing unavailable',
      ),
    );
    await settle();
    expect(cubit.state.error, 'Billing unavailable');
  });

  test('guests cannot buy gems', () async {
    await setUp_(user: userJson({'isGuest': true}));
    final packs = await h.deps.store.packs();
    await cubit.buy(packs.single);
    expect(h.iap.bought, isEmpty);
    expect(cubit.state.error, isNotNull);
  });

  test(
    'store billing unavailable is reported without calling the store',
    () async {
      await setUp_();
      h.iap.available = false;
      final packs = await h.deps.store.packs();
      await cubit.buy(packs.single);
      expect(h.iap.bought, isEmpty);
      expect(cubit.state.error, contains('not available'));
    },
  );
}
