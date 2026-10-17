import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/tr_extension.dart';
import '../../auth/presentation/session_cubit.dart';
import '../../notifications/presentation/notification_cubits.dart';
import '../../notifications/presentation/notification_sheet.dart';
import '../../settings/presentation/site_settings_cubit.dart';

/// Bottom navigation around the three main tabs.
class ShellScreen extends StatelessWidget {
  const ShellScreen({required this.child, required this.location, super.key});

  final Widget child;
  final String location;

  static const tabs = ['/', '/messages', '/settings'];

  int get _index {
    final i = tabs.lastIndexWhere(
      (t) => t == '/' ? location == '/' : location.startsWith(t),
    );
    return i < 0 ? 0 : i;
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final user = context.watch<SessionCubit>().state.user;
    final unread = user == null || user.isGuest
        ? 0
        : context.watch<UnreadCubit>().state;
    return Scaffold(
      appBar: AppBar(
        title: Text(context.watch<SiteSettingsCubit>().state.siteName),
        actions: [
          if (user != null && !user.isGuest)
            IconButton(
              key: const Key('bell'),
              onPressed: () => showNotificationSheet(context),
              icon: Badge(
                isLabelVisible: unread > 0,
                label: Text('$unread'),
                child: const Icon(Icons.notifications_rounded),
              ),
            ),
        ],
      ),
      body: child,
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => context.go(tabs[i]),
        destinations: [
          NavigationDestination(
            icon: const Icon(Icons.videocam_rounded),
            label: t('Home'),
          ),
          NavigationDestination(
            icon: const Icon(Icons.chat_bubble_rounded),
            label: t('Messages'),
          ),
          NavigationDestination(
            icon: const Icon(Icons.settings_rounded),
            label: t('Settings'),
          ),
        ],
      ),
    );
  }
}
