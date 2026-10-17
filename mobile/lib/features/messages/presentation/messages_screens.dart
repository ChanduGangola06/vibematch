import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/errors/failure.dart';
import '../../../core/l10n/tr_extension.dart';
import '../../../core/utils/paged.dart';
import '../../../shared/widgets/user_avatar.dart';
import '../../auth/presentation/session_cubit.dart';
import '../domain/message_models.dart';
import 'message_cubits.dart';

class InboxScreen extends StatelessWidget {
  const InboxScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final session = context.watch<SessionCubit>().state;
    if (!session.isSignedIn || session.user!.isGuest)
      return Center(child: Text(t('Sign in to see your messages')));
    return BlocBuilder<ConversationsCubit, PagedState<Conversation>>(
      builder: (context, s) {
        if (s.isEmpty) return Center(child: Text(t('No messages yet')));
        final cubit = context.read<ConversationsCubit>();
        return RefreshIndicator(
          onRefresh: cubit.refresh,
          child: ListView.builder(
            itemCount: s.items.length + (s.hasMore ? 1 : 0),
            itemBuilder: (_, i) {
              if (i >= s.items.length) {
                Future<void>.microtask(cubit.loadMore);
                return const Padding(
                  padding: EdgeInsets.all(16),
                  child: Center(child: CircularProgressIndicator()),
                );
              }
              final c = s.items[i];
              return ListTile(
                leading: UserAvatar(
                  url: c.partner.avatar,
                  name: c.partner.displayName,
                ),
                title: Text(c.partner.displayName),
                subtitle: Text(
                  c.lastText,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                trailing: c.unread > 0
                    ? Badge(label: Text('${c.unread}'))
                    : null,
                onTap: () => context.push('/chat/${c.partner.id}'),
              );
            },
          ),
        );
      },
    );
  }
}

/// Provides a [ThreadCubit] for one conversation and loads its first page.
class DirectChatScreen extends StatelessWidget {
  const DirectChatScreen({required this.partnerId, super.key});

  final String partnerId;

  @override
  Widget build(BuildContext context) => BlocProvider(
    create: (c) =>
        ThreadCubit(c.read(), partnerId, c.read<ConversationsCubit>())
          ..loadMore(),
    child: _ChatView(partnerId: partnerId),
  );
}

class _ChatView extends StatefulWidget {
  const _ChatView({required this.partnerId});

  final String partnerId;

  @override
  State<_ChatView> createState() => _ChatViewState();
}

class _ChatViewState extends State<_ChatView> {
  final _input = TextEditingController();
  bool _sending = false;

  @override
  void dispose() {
    _input.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _input.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    final t = context.tRead;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await context.read<ThreadCubit>().send(text);
      _input.clear();
    } on ApiException catch (e) {
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            e.isCode('chat_not_allowed')
                ? t(
                    'You can message each other once you both follow each other or have matched.',
                  )
                : e.message,
          ),
        ),
      );
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final me = context.watch<SessionCubit>().state.user;
    final partner = context
        .watch<ConversationsCubit>()
        .state
        .items
        .where((c) => c.partner.id == widget.partnerId)
        .firstOrNull
        ?.partner;
    return Scaffold(
      appBar: AppBar(title: Text(partner?.displayName ?? t('Chat'))),
      body: Column(
        children: [
          Expanded(
            child: BlocBuilder<ThreadCubit, PagedState<DirectMessage>>(
              builder: (context, s) {
                return ListView.builder(
                  reverse: true,
                  itemCount:
                      s.items.length +
                      (s.hasMore && s.items.isNotEmpty ? 1 : 0),
                  itemBuilder: (_, i) {
                    if (i >= s.items.length)
                      return TextButton(
                        onPressed: context.read<ThreadCubit>().loadMore,
                        child: Text(t('Load earlier messages')),
                      );
                    final m = s.items[i];
                    final mine = m.senderId == me?.id;
                    return Align(
                      alignment: mine
                          ? Alignment.centerRight
                          : Alignment.centerLeft,
                      child: Container(
                        margin: const EdgeInsets.symmetric(
                          horizontal: 12,
                          vertical: 4,
                        ),
                        padding: const EdgeInsets.symmetric(
                          horizontal: 14,
                          vertical: 10,
                        ),
                        decoration: BoxDecoration(
                          color: mine
                              ? Theme.of(context).colorScheme.primary
                              : const Color(0xFF1F222B),
                          borderRadius: BorderRadius.circular(16),
                        ),
                        child: Text(
                          m.giftName != null ? '🎁 ${m.giftName}' : m.text,
                          style: TextStyle(color: mine ? Colors.black : null),
                        ),
                      ),
                    );
                  },
                );
              },
            ),
          ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(8),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      key: const Key('message-input'),
                      controller: _input,
                      maxLength: 2000,
                      decoration: InputDecoration(
                        hintText: t('Message'),
                        counterText: '',
                      ),
                      onSubmitted: (_) => _send(),
                    ),
                  ),
                  IconButton(
                    key: const Key('send'),
                    onPressed: _sending ? null : _send,
                    icon: const Icon(Icons.send_rounded),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
