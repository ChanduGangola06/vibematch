import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/dependencies.dart';
import '../../../core/l10n/tr_extension.dart';
import '../../auth/presentation/session_cubit.dart';
import '../../store/domain/store_models.dart';
import '../../store/presentation/store_sheets.dart';
import '../domain/match_models.dart';
import 'matching_cubit.dart';

/// The landing tab: start a random video chat, then the in-call view.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  Filters _filters = const Filters();
  final _input = TextEditingController();

  @override
  void dispose() {
    _input.dispose();
    super.dispose();
  }

  void _start() {
    final session = context.read<SessionCubit>().state;
    if (!session.isSignedIn) {
      context.go('/auth');
      return;
    }
    context.read<MatchingCubit>().start(_filters);
  }

  Future<void> _guard(Future<void> Function() fn) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      await fn();
    } on Object catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  @override
  Widget build(BuildContext context) => BlocBuilder<MatchingCubit, MatchState>(
    builder: (context, m) => _body(context, m),
  );

  Widget _body(BuildContext context, MatchState m) {
    final t = context.t;
    final ctl = context.read<MatchingCubit>();
    if (m.phase == Phase.idle) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.videocam_rounded, size: 88),
              const SizedBox(height: 16),
              if (m.error != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Text(
                    m.error!,
                    key: const Key('match-error'),
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                    textAlign: TextAlign.center,
                  ),
                ),
              FilledButton(
                key: const Key('start'),
                onPressed: _start,
                child: Text(t('Start video chat')),
              ),
              TextButton(
                key: const Key('filters'),
                onPressed: _openFilters,
                child: Text(t('Match preferences')),
              ),
            ],
          ),
        ),
      );
    }
    final partner = m.partner;
    return Column(
      children: [
        Expanded(
          child: Stack(
            fit: StackFit.expand,
            children: [
              Container(color: Colors.black),
              if (m.phase == Phase.connected && partner != null)
                Center(
                  child: Text(
                    partner.name,
                    style: const TextStyle(
                      fontSize: 22,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                )
              else
                Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const CircularProgressIndicator(),
                      const SizedBox(height: 12),
                      Text(
                        t(
                          m.phase == Phase.starting
                              ? 'Starting camera…'
                              : 'Looking for someone…',
                        ),
                      ),
                    ],
                  ),
                ),
              if (m.remote != null) _Remote(stream: m.remote!),
              if (m.filtersIgnored)
                Positioned(
                  top: 8,
                  left: 8,
                  right: 8,
                  child: Text(
                    t('No one matched your filters, so we widened the search.'),
                    textAlign: TextAlign.center,
                  ),
                ),
            ],
          ),
        ),
        if (m.phase == Phase.connected)
          _Chat(
            messages: m.messages,
            input: _input,
            onSend: () => _guard(() async {
              final text = _input.text;
              _input.clear();
              await ctl.sendMessage(text);
            }),
          ),
        SafeArea(
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: [
              IconButton(
                key: const Key('mic'),
                onPressed: ctl.toggleMic,
                icon: Icon(m.mic ? Icons.mic_rounded : Icons.mic_off_rounded),
              ),
              IconButton(
                key: const Key('cam'),
                onPressed: ctl.toggleCam,
                icon: Icon(
                  m.cam ? Icons.videocam_rounded : Icons.videocam_off_rounded,
                ),
              ),
              if (m.phase == Phase.connected) ...[
                IconButton(
                  key: const Key('like'),
                  onPressed: () => _guard(ctl.toggleLike),
                  icon: Icon(
                    m.liked
                        ? Icons.favorite_rounded
                        : Icons.favorite_border_rounded,
                  ),
                ),
                IconButton(
                  key: const Key('follow'),
                  onPressed: () => _guard(ctl.toggleFollow),
                  icon: Icon(
                    m.following
                        ? Icons.person_remove_rounded
                        : Icons.person_add_rounded,
                  ),
                ),
                IconButton(
                  key: const Key('gift'),
                  onPressed: _openGifts,
                  icon: const Icon(Icons.card_giftcard_rounded),
                ),
                IconButton(
                  key: const Key('next'),
                  onPressed: ctl.next,
                  icon: const Icon(Icons.skip_next_rounded),
                ),
              ],
              IconButton(
                key: const Key('stop'),
                onPressed: ctl.stop,
                color: Theme.of(context).colorScheme.error,
                icon: const Icon(Icons.call_end_rounded),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Future<void> _openFilters() async {
    final vip = context.read<SessionCubit>().state.user?.isVip ?? false;
    if (!vip) {
      await showVipSheet(context);
      return;
    }
    if (!mounted) return;
    final next = await showModalBottomSheet<Filters>(
      context: context,
      builder: (_) => _FilterSheet(initial: _filters),
    );
    if (next != null) setState(() => _filters = next);
  }

  Future<void> _openGifts() async {
    final ctl = context.read<MatchingCubit>();
    final deps = context.read<AppDependencies>();
    await showModalBottomSheet<void>(
      context: context,
      builder: (_) => _GiftSheet(deps: deps, onSend: ctl.sendGift),
    );
  }
}

class _Remote extends StatefulWidget {
  const _Remote({required this.stream});

  final MediaStream stream;

  @override
  State<_Remote> createState() => _RemoteState();
}

class _RemoteState extends State<_Remote> {
  final _renderer = RTCVideoRenderer();

  @override
  void initState() {
    super.initState();
    _renderer.initialize().then((_) {
      if (mounted) setState(() => _renderer.srcObject = widget.stream);
    });
  }

  @override
  void dispose() {
    _renderer.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => RTCVideoView(
    _renderer,
    objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover,
  );
}

class _Chat extends StatelessWidget {
  const _Chat({
    required this.messages,
    required this.input,
    required this.onSend,
  });

  final List<ChatMsg> messages;
  final TextEditingController input;
  final VoidCallback onSend;

  @override
  Widget build(BuildContext context) => Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      SizedBox(
        height: 90,
        child: ListView(
          reverse: true,
          children: [
            for (final m in messages.reversed)
              Align(
                alignment: m.mine
                    ? Alignment.centerRight
                    : Alignment.centerLeft,
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 2,
                  ),
                  child: Text(m.giftName != null ? '🎁 ${m.giftName}' : m.text),
                ),
              ),
          ],
        ),
      ),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8),
        child: Row(
          children: [
            Expanded(
              child: TextField(
                key: const Key('chat-input'),
                controller: input,
                onSubmitted: (_) => onSend(),
              ),
            ),
            IconButton(
              key: const Key('chat-send'),
              onPressed: onSend,
              icon: const Icon(Icons.send_rounded),
            ),
          ],
        ),
      ),
    ],
  );
}

class _FilterSheet extends StatefulWidget {
  const _FilterSheet({required this.initial});

  final Filters initial;

  @override
  State<_FilterSheet> createState() => _FilterSheetState();
}

class _FilterSheetState extends State<_FilterSheet> {
  late String gender = widget.initial.gender;
  late bool superMatch = widget.initial.superMatch;

  @override
  Widget build(BuildContext context) => SafeArea(
    child: Padding(
      padding: const EdgeInsets.all(20),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          SegmentedButton<String>(
            segments: const [
              ButtonSegment(value: 'both', label: Text('Everyone')),
              ButtonSegment(value: 'female', label: Text('Women')),
              ButtonSegment(value: 'male', label: Text('Men')),
            ],
            selected: {gender},
            onSelectionChanged: (s) => setState(() => gender = s.first),
          ),
          SwitchListTile(
            title: const Text('Super match'),
            subtitle: const Text('Only real people, never demo profiles'),
            value: superMatch,
            onChanged: (v) => setState(() => superMatch = v),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(
              Filters(
                gender: gender,
                country: widget.initial.country,
                superMatch: superMatch,
              ),
            ),
            child: const Text('Save'),
          ),
        ],
      ),
    ),
  );
}

class _GiftSheet extends StatefulWidget {
  const _GiftSheet({required this.deps, required this.onSend});

  final AppDependencies deps;
  final Future<void> Function(String giftId) onSend;

  @override
  State<_GiftSheet> createState() => _GiftSheetState();
}

class _GiftSheetState extends State<_GiftSheet> {
  late final Future<List<Gift>> _gifts = widget.deps.store.gifts();

  @override
  Widget build(BuildContext context) {
    final cfg = widget.deps.config;
    final onSend = widget.onSend;
    return FutureBuilder<List<Gift>>(
      future: _gifts,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done)
          return const SizedBox(
            height: 160,
            child: Center(child: CircularProgressIndicator()),
          );
        if (snap.hasError)
          return SizedBox(
            height: 160,
            child: Center(child: Text('${snap.error}')),
          );
        final list = snap.data!;
        return GridView.count(
          crossAxisCount: 4,
          shrinkWrap: true,
          padding: const EdgeInsets.all(12),
          children: [
            for (final g in list)
              InkWell(
                onTap: () async {
                  final nav = Navigator.of(context);
                  try {
                    await onSend(g.id);
                    nav.pop();
                  } on Object {
                    nav.pop();
                    if (context.mounted) await showStoreSheet(context);
                  }
                },
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Image.network(
                      cfg.absoluteUrl(g.image),
                      width: 40,
                      height: 40,
                      errorBuilder: (_, _, _) =>
                          const Icon(Icons.card_giftcard),
                    ),
                    Text(g.name, maxLines: 1, overflow: TextOverflow.ellipsis),
                    Text('${g.price} 💎'),
                  ],
                ),
              ),
          ],
        );
      },
    );
  }
}
