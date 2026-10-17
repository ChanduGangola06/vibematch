import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/dependencies.dart';
import '../../../core/errors/failure.dart';
import '../../../core/l10n/tr_extension.dart';
import '../../auth/presentation/session_cubit.dart';
import '../../settings/presentation/site_settings_cubit.dart';
import '../domain/store_models.dart';
import 'purchase_cubit.dart';

Future<void> showStoreSheet(BuildContext context) => showModalBottomSheet<void>(
  context: context,
  isScrollControlled: true,
  builder: (_) => const StoreSheet(),
);

Future<void> showVipSheet(BuildContext context) {
  // The sheet lives in a different route, so hand the cubit over explicitly.
  final purchase = context.read<PurchaseCubit>();
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (_) =>
        BlocProvider.value(value: purchase, child: const VipSheet()),
  );
}

class StoreSheet extends StatefulWidget {
  const StoreSheet({super.key});

  @override
  State<StoreSheet> createState() => _StoreSheetState();
}

class _StoreSheetState extends State<StoreSheet> {
  late final Future<List<GemPack>> _packs = context
      .read<AppDependencies>()
      .store
      .packs();

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final currency = context.watch<SiteSettingsCubit>().state.currency;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: BlocBuilder<PurchaseCubit, PurchaseState>(
          builder: (context, purchase) {
            return Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  t('Get gems'),
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 12),
                if (purchase.message != null)
                  Text(
                    t(purchase.message!),
                    key: const Key('purchase-ok'),
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.primary,
                    ),
                  ),
                if (purchase.error != null)
                  Text(
                    t(purchase.error!),
                    key: const Key('purchase-error'),
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                FutureBuilder<List<GemPack>>(
                  future: _packs,
                  builder: (context, snap) {
                    if (snap.connectionState != ConnectionState.done)
                      return const Padding(
                        padding: EdgeInsets.all(24),
                        child: CircularProgressIndicator(),
                      );
                    if (snap.hasError) return Text(errorText(snap.error));
                    return Column(
                      children: [
                        for (final p in snap.data!)
                          ListTile(
                            key: Key('pack-${p.id}'),
                            leading: const Icon(Icons.diamond_rounded),
                            title: Text('${p.gems} ${t('gems')}'),
                            subtitle: Text(p.name),
                            trailing: FilledButton(
                              style: FilledButton.styleFrom(
                                minimumSize: const Size(90, 40),
                              ),
                              onPressed: purchase.busyPackId != null
                                  ? null
                                  : () => context.read<PurchaseCubit>().buy(p),
                              child: purchase.busyPackId == p.id
                                  ? const SizedBox(
                                      width: 16,
                                      height: 16,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                      ),
                                    )
                                  : Text(
                                      '${p.price.toStringAsFixed(2)} $currency',
                                    ),
                            ),
                          ),
                      ],
                    );
                  },
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class VipSheet extends StatefulWidget {
  const VipSheet({super.key});

  @override
  State<VipSheet> createState() => _VipSheetState();
}

class _VipSheetState extends State<VipSheet> {
  late final Future<List<VipPlan>> _plans = context
      .read<AppDependencies>()
      .store
      .vipPlans();
  String? _busy;

  Future<void> _subscribe(VipPlan plan) async {
    final nav = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final t = context.tRead;
    final purchase = context.read<PurchaseCubit>();
    final gems = context.read<SessionCubit>().state.user?.gems ?? 0;
    if (gems < plan.priceGems) {
      nav.pop();
      await showStoreSheet(context);
      return;
    }
    setState(() => _busy = plan.id);
    try {
      await purchase.subscribeVip(plan);
      messenger.showSnackBar(SnackBar(content: Text(t('Welcome to VIP!'))));
      nav.pop();
    } on ApiException catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(t('Go VIP'), style: Theme.of(context).textTheme.titleLarge),
            FutureBuilder<List<VipPlan>>(
              future: _plans,
              builder: (context, snap) {
                if (snap.connectionState != ConnectionState.done)
                  return const Padding(
                    padding: EdgeInsets.all(24),
                    child: CircularProgressIndicator(),
                  );
                if (snap.hasError) return Text(errorText(snap.error));
                return Column(
                  children: [
                    for (final p in snap.data!)
                      ListTile(
                        key: Key('plan-${p.id}'),
                        leading: const Icon(
                          Icons.workspace_premium_rounded,
                          color: Colors.amber,
                        ),
                        title: Text(p.name),
                        subtitle: Text(
                          p.description.isNotEmpty
                              ? p.description
                              : t('{n} days', {'n': p.durationDays}),
                        ),
                        trailing: FilledButton(
                          style: FilledButton.styleFrom(
                            minimumSize: const Size(80, 40),
                          ),
                          onPressed: _busy != null ? null : () => _subscribe(p),
                          child: Text('${p.priceGems} 💎'),
                        ),
                      ),
                  ],
                );
              },
            ),
          ],
        ),
      ),
    );
  }
}
