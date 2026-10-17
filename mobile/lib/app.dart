import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import 'core/di/dependencies.dart';
import 'core/l10n/translator.dart';
import 'core/l10n/translator_cubit.dart';
import 'core/router/app_router.dart';
import 'core/theme/app_theme.dart';
import 'features/auth/presentation/session_cubit.dart';
import 'features/matching/presentation/matching_cubit.dart';
import 'features/messages/presentation/message_cubits.dart';
import 'features/notifications/presentation/notification_cubits.dart';
import 'features/settings/presentation/site_settings_cubit.dart';
import 'features/store/presentation/purchase_cubit.dart';

/// Root: dependencies + app-wide blocs. They sit above MaterialApp so every route and bottom sheet can read them.
class VibeMatchApp extends StatelessWidget {
  const VibeMatchApp({required this.deps, super.key});

  final AppDependencies deps;

  @override
  Widget build(
    BuildContext context,
  ) => RepositoryProvider<AppDependencies>.value(
    value: deps,
    child: MultiBlocProvider(
      providers: [
        BlocProvider(create: (_) => SessionCubit(deps)..restore()),
        BlocProvider(create: (_) => TranslatorCubit(deps.languages)..init()),
        BlocProvider(create: (_) => SiteSettingsCubit(deps.settings)..load()),
        BlocProvider(create: (c) => ConversationsCubit(deps)..loadMore()),
        BlocProvider(create: (c) => UnreadCubit(deps)..load()),
        BlocProvider(
          create: (c) => MatchingCubit(deps, c.read<SessionCubit>()),
        ),
        BlocProvider(
          create: (c) => PurchaseCubit(deps, c.read<SessionCubit>()),
        ),
      ],
      child: const _AppView(),
    ),
  );
}

class _AppView extends StatefulWidget {
  const _AppView();

  @override
  State<_AppView> createState() => _AppViewState();
}

class _AppViewState extends State<_AppView> {
  late final GoRouter _router = buildRouter(
    session: context.read<SessionCubit>(),
    prefs: context.read<AppDependencies>().prefs,
  );

  @override
  void dispose() {
    _router.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final Translator t = context.watch<TranslatorCubit>().state;
    return MultiBlocListener(
      listeners: [
        // Signing in or out re-loads the per-account lists.
        BlocListener<SessionCubit, SessionState>(
          listenWhen: (a, b) => a.user?.id != b.user?.id,
          listener: (context, s) {
            context.read<ConversationsCubit>().refresh();
            context.read<UnreadCubit>().load();
          },
        ),
      ],
      child: MaterialApp.router(
        title: context.watch<SiteSettingsCubit>().state.siteName,
        theme: buildTheme(),
        routerConfig: _router,
        debugShowCheckedModeBanner: false,
        builder: (context, child) => Directionality(
          textDirection: t.direction,
          child: child ?? const SizedBox.shrink(),
        ),
      ),
    );
  }
}
