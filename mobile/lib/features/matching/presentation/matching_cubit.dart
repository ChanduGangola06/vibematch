import 'dart:async';

import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

import '../../../core/di/dependencies.dart';
import '../../../core/errors/failure.dart';
import '../../auth/presentation/session_cubit.dart';
import '../domain/match_models.dart';
import '../../../services/socket_port.dart';
import '../../../services/webrtc.dart';

enum Phase { idle, starting, searching, connected }

class MatchState {
  const MatchState({
    this.phase = Phase.idle,
    this.partner,
    this.isDemo = false,
    this.videoUrl,
    this.messages = const [],
    this.error,
    this.liked = false,
    this.following = false,
    this.filtersIgnored = false,
    this.mic = true,
    this.cam = true,
    this.remote,
  });

  final Phase phase;
  final Partner? partner;
  final bool isDemo;
  final String? videoUrl;
  final List<ChatMsg> messages;
  final String? error;
  final bool liked;
  final bool following;
  final bool filtersIgnored;
  final bool mic;
  final bool cam;
  final MediaStream? remote;

  MatchState copyWith({
    Partner? partner,
    List<ChatMsg>? messages,
    bool? liked,
    bool? following,
    bool? mic,
    bool? cam,
    MediaStream? remote,
  }) => MatchState(
    phase: phase,
    partner: partner ?? this.partner,
    isDemo: isDemo,
    videoUrl: videoUrl,
    messages: messages ?? this.messages,
    error: error,
    liked: liked ?? this.liked,
    following: following ?? this.following,
    filtersIgnored: filtersIgnored,
    mic: mic ?? this.mic,
    cam: cam ?? this.cam,
    remote: remote ?? this.remote,
  );
}

/// Random-chat state machine: idle -> starting (media + ICE) -> searching -> connected -> searching ...
/// The server owns matching; this cubit relays signals and renders what it is told.
class MatchingCubit extends Cubit<MatchState> {
  MatchingCubit(this._deps, this._session) : super(const MatchState()) {
    _socket
      ..on('match_found', _onFound)
      ..on('signal', _onSignal)
      ..on('partner_skipped', _onSkipped)
      ..on('receive_message', _onMessage)
      ..on('partner_liked', _onLiked)
      ..on('match_error', _onMatchError);
  }

  final AppDependencies _deps;
  final SessionCubit _session;
  Filters _filters = const Filters();
  PeerPort? _peer;
  final _subs = <StreamSubscription<Object?>>[];
  List<Map<String, Object?>> _ice = const [];
  int _seq = 0;

  SocketPort get _socket => _deps.socket;
  LocalMedia get _media => _deps.media;

  Map<String, Object?> _map(Object? d) =>
      d is Map ? d.cast<String, Object?>() : const {};

  Future<void> start([Filters filters = const Filters()]) async {
    _filters = filters;
    final my = ++_seq;
    emit(const MatchState(phase: Phase.starting));
    try {
      await _media.open();
      final d = _map(await _deps.api.get('/webrtc/ice-servers'));
      _ice = [for (final s in (d['iceServers'] as List? ?? const [])) _map(s)];
      if (my != _seq) return;
      if (!_deps.socket.connected) _deps.socket.connect();
      await _join();
    } on Object catch (e) {
      await _media.close();
      emit(
        MatchState(
          error: e is ApiException
              ? e.message
              : 'Could not start the call. Check camera and microphone permissions.',
        ),
      );
    }
  }

  Future<void> _join() async {
    final res = await _deps.socket.emitAck(
      'join_queue',
      _filters.toJoinPayload(),
    );
    if (state.phase != Phase.connected) {
      emit(
        MatchState(
          phase: Phase.searching,
          filtersIgnored: _map(res['applied'])['filtersIgnored'] == true,
        ),
      );
    }
  }

  Future<void> stop() async {
    _seq++;
    if (_deps.socket.connected)
      _deps.socket.emit(
        state.phase == Phase.connected ? 'skip_match' : 'leave_queue',
      );
    await _closePeer();
    await _media.close();
    emit(const MatchState());
  }

  Future<void> next() async {
    await _closePeer();
    _deps.socket.emit('skip_match');
    emit(const MatchState(phase: Phase.searching));
    try {
      await _join();
    } on ApiException catch (e) {
      emit(MatchState(error: e.message));
    }
  }

  Future<void> _closePeer() async {
    for (final s in _subs) {
      await s.cancel();
    }
    _subs.clear();
    final p = _peer;
    _peer = null;
    await p?.close();
  }

  // ---- server events ---------------------------------------------------------------------------------
  void _onFound(Object? raw) {
    final d = _map(raw);
    unawaited(_closePeer());
    final isDemo = d['isDemo'] == true;
    emit(
      MatchState(
        phase: Phase.connected,
        partner: Partner.fromJson(_map(d['partner'])),
        isDemo: isDemo,
        videoUrl: d['videoUrl'] as String?,
        mic: state.mic,
        cam: state.cam,
      ),
    );
    if (isDemo) return;
    final peer = _deps.peerFactory(
      iceServers: _ice,
      local: _media,
      initiator: d['initiator'] == true,
    );
    _peer = peer;
    _subs
      ..add(
        peer.signals.listen((s) => _deps.socket.emit('signal', {'signal': s})),
      )
      ..add(peer.remoteStream.listen((m) => emit(state.copyWith(remote: m))));
    peer.start().catchError(
      (Object _) =>
          emit(const MatchState(error: 'Could not establish the connection')),
    );
  }

  void _onSignal(Object? raw) =>
      _peer?.handle(_map(_map(raw)['signal'])).catchError((Object _) {});

  void _onSkipped(Object? _) {
    unawaited(_closePeer());
    emit(const MatchState(phase: Phase.searching));
    _join().catchError(
      (Object e) => emit(
        MatchState(error: e is ApiException ? e.message : 'Disconnected'),
      ),
    );
  }

  void _onMessage(Object? raw) {
    final m = _map(raw);
    if (m['from'] != state.partner?.id)
      return; // someone else's chat belongs to the inbox
    final gift = _map(m['gift']);
    _add(
      ChatMsg(
        id: m['id']! as String,
        mine: false,
        text: (m['text'] as String?) ?? '',
        giftName: gift['name'] as String?,
        giftImage: gift['image'] as String?,
      ),
    );
  }

  void _onLiked(Object? raw) {
    final n = (_map(raw)['newLikesCount'] as num?)?.toInt();
    if (n != null) _session.patchUser((u) => u.copyWith(likesCount: n));
  }

  void _onMatchError(Object? raw) => emit(
    MatchState(error: (_map(raw)['message'] as String?) ?? 'Match error'),
  );

  void _add(ChatMsg m) {
    if (state.messages.any((x) => x.id == m.id)) return;
    emit(state.copyWith(messages: [...state.messages, m]));
  }

  // ---- in-call actions ---------------------------------------------------------------------------------
  Future<void> sendMessage(String text) async {
    final t = text.trim();
    if (t.isEmpty) return;
    final r = await _deps.socket.emitAck('send_message', {'text': t});
    _add(ChatMsg(id: _map(r['message'])['id']! as String, mine: true, text: t));
  }

  Future<void> sendGift(String giftId) async {
    final r = await _deps.socket.emitAck('send_gift', {'giftId': giftId});
    final gift = _map(r['gift']);
    final balance = (r['balance'] as num?)?.toInt();
    if (balance != null) _session.patchUser((u) => u.copyWith(gems: balance));
    _add(
      ChatMsg(
        id: _map(r['message'])['id']! as String,
        mine: true,
        text: '',
        giftName: gift['name'] as String?,
        giftImage: gift['image'] as String?,
      ),
    );
  }

  Future<void> toggleLike() async {
    final p = state.partner;
    if (p == null) return;
    final r = _map(
      state.liked
          ? await _deps.api.deleteData('/users/${p.id}/like')
          : await _deps.api.put('/users/${p.id}/like'),
    );
    emit(
      state.copyWith(
        liked: r['liked'] == true,
        partner: p.withLikes(
          (r['likesCount'] as num?)?.toInt() ?? p.likesCount,
        ),
      ),
    );
  }

  Future<void> toggleFollow() async {
    final p = state.partner;
    if (p == null) return;
    final r = _map(
      state.following
          ? await _deps.api.deleteData('/users/${p.id}/follow')
          : await _deps.api.put('/users/${p.id}/follow'),
    );
    emit(state.copyWith(following: r['isFollowing'] == true));
  }

  void toggleMic() {
    _media.setMic(!state.mic);
    emit(state.copyWith(mic: !state.mic));
  }

  void toggleCam() {
    _media.setCam(!state.cam);
    emit(state.copyWith(cam: !state.cam));
  }

  @override
  Future<void> close() async {
    _seq++;
    for (final e in const [
      'match_found',
      'signal',
      'partner_skipped',
      'receive_message',
      'partner_liked',
      'match_error',
    ]) {
      _deps.socket.off(e);
    }
    await _closePeer();
    await _media.close();
    return super.close();
  }
}
