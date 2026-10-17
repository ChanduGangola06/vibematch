import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/dependencies.dart';
import '../../../core/l10n/tr_extension.dart';
import '../../../core/l10n/translator.dart';
import '../../../core/utils/paged.dart';
import '../data/notification_repository.dart';
import 'notification_cubits.dart';

Future<void> showNotificationSheet(BuildContext context) {
  final deps = context.read<AppDependencies>();
  final unread = context.read<UnreadCubit>();
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (_) => BlocProvider(
      create: (_) => NotificationsCubit(deps, unread)..loadMore(),
      child: const NotificationSheet(),
    ),
  );
}

class NotificationSheet extends StatelessWidget {
  const NotificationSheet({super.key});

  String _text(Translator t, AppNotification n) {
    final who = n.fromName.isNotEmpty ? n.fromName : t('Someone');
    return switch (n.type) {
      'follow' => t('{name} started following you', {'name': who}),
      'gift' => t('{name} sent you a gift', {'name': who}),
      _ => t('New notification'),
    };
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.7,
      builder: (_, scroll) => Column(
        children: [
          ListTile(
            title: Text(
              t('Notifications'),
              style: const TextStyle(fontWeight: FontWeight.w800),
            ),
            trailing: TextButton(
              onPressed: () =>
                  context.read<NotificationsCubit>().markAll().ignore(),
              child: Text(t('Mark all read')),
            ),
          ),
          Expanded(
            child: BlocBuilder<NotificationsCubit, PagedState<AppNotification>>(
              builder: (context, s) {
                if (s.isEmpty)
                  return Center(child: Text(t('No notifications yet')));
                return ListView.builder(
                  controller: scroll,
                  itemCount: s.items.length,
                  itemBuilder: (_, i) {
                    final n = s.items[i];
                    return ListTile(
                      title: Text(
                        _text(t, n),
                        style: TextStyle(
                          fontWeight: n.isRead
                              ? FontWeight.normal
                              : FontWeight.w700,
                        ),
                      ),
                      onTap: () async {
                        await context.read<NotificationsCubit>().open(n);
                        if (context.mounted && n.fromUsername.isNotEmpty) {
                          Navigator.of(context).pop();
                          unawaited(context.push<void>("/u/${n.fromUsername}"));
                        }
                      },
                    );
                  },
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
