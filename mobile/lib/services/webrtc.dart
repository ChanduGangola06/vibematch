import 'dart:async';

import 'package:flutter_webrtc/flutter_webrtc.dart';

/// Camera + microphone. Interface so the matching state machine is testable without hardware.
abstract class LocalMedia {
  MediaStream? get stream;
  Future<void> open();
  Future<void> close();
  void setMic(bool on);
  void setCam(bool on);
}

class DeviceMedia implements LocalMedia {
  MediaStream? _stream;

  @override
  MediaStream? get stream => _stream;

  @override
  Future<void> open() async {
    if (_stream != null) return;
    _stream = await navigator.mediaDevices.getUserMedia({
      'audio': true,
      'video': {'facingMode': 'user'},
    });
  }

  @override
  Future<void> close() async {
    final s = _stream;
    _stream = null;
    if (s == null) return;
    for (final t in s.getTracks()) {
      await t.stop();
    }
    await s.dispose();
  }

  @override
  void setMic(bool on) {
    for (final t in _stream?.getAudioTracks() ?? <MediaStreamTrack>[]) {
      t.enabled = on;
    }
  }

  @override
  void setCam(bool on) {
    for (final t in _stream?.getVideoTracks() ?? <MediaStreamTrack>[]) {
      t.enabled = on;
    }
  }
}

/// One call leg. The server relays opaque signals between the two matched peers.
abstract class PeerPort {
  /// Signals to forward to the partner via the socket.
  Stream<Map<String, Object?>> get signals;
  Stream<MediaStream> get remoteStream;
  Future<void> start();
  Future<void> handle(Map<String, Object?> signal);
  Future<void> close();
}

typedef PeerFactory =
    PeerPort Function({
      required List<Map<String, Object?>> iceServers,
      required LocalMedia local,
      required bool initiator,
    });

class RtcPeer implements PeerPort {
  RtcPeer({
    required this.iceServers,
    required this.local,
    required this.initiator,
  });

  final List<Map<String, Object?>> iceServers;
  final LocalMedia local;
  final bool initiator;

  RTCPeerConnection? _pc;
  final _signals = StreamController<Map<String, Object?>>.broadcast();
  final _remote = StreamController<MediaStream>.broadcast();
  final _pending = <RTCIceCandidate>[];
  bool _remoteSet = false;
  bool _closed = false;

  @override
  Stream<Map<String, Object?>> get signals => _signals.stream;

  @override
  Stream<MediaStream> get remoteStream => _remote.stream;

  Future<RTCPeerConnection> _connection() async {
    final existing = _pc;
    if (existing != null) return existing;
    final pc = await createPeerConnection({
      'iceServers': iceServers,
      'sdpSemantics': 'unified-plan',
    });
    final stream = local.stream;
    if (stream != null) {
      for (final t in stream.getTracks()) {
        await pc.addTrack(t, stream);
      }
    }
    pc.onIceCandidate = (c) {
      if (_closed || c.candidate == null) return;
      _signals.add({
        'type': 'candidate',
        'candidate': {
          'candidate': c.candidate,
          'sdpMid': c.sdpMid,
          'sdpMLineIndex': c.sdpMLineIndex,
        },
      });
    };
    pc.onTrack = (e) {
      if (e.streams.isNotEmpty && !_closed) _remote.add(e.streams.first);
    };
    return _pc = pc;
  }

  @override
  Future<void> start() async {
    final pc = await _connection();
    if (!initiator) return;
    final offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    _signals.add({
      'type': 'offer',
      'sdp': {'type': offer.type, 'sdp': offer.sdp},
    });
  }

  @override
  Future<void> handle(Map<String, Object?> signal) async {
    if (_closed) return;
    final pc = await _connection();
    switch (signal['type']) {
      case 'offer':
        await pc.setRemoteDescription(_description(signal['sdp']));
        _remoteSet = true;
        await _flush(pc);
        final answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        _signals.add({
          'type': 'answer',
          'sdp': {'type': answer.type, 'sdp': answer.sdp},
        });
      case 'answer':
        await pc.setRemoteDescription(_description(signal['sdp']));
        _remoteSet = true;
        await _flush(pc);
      default:
        final c = signal['candidate'];
        if (c is Map) {
          final cand = RTCIceCandidate(
            c['candidate'] as String?,
            c['sdpMid'] as String?,
            (c['sdpMLineIndex'] as num?)?.toInt(),
          );
          if (_remoteSet) {
            await pc.addCandidate(cand);
          } else {
            _pending.add(cand);
          }
        }
    }
  }

  RTCSessionDescription _description(Object? raw) {
    final m = (raw! as Map).cast<String, Object?>();
    return RTCSessionDescription(m['sdp'] as String?, m['type'] as String?);
  }

  Future<void> _flush(RTCPeerConnection pc) async {
    final queued = List<RTCIceCandidate>.of(_pending);
    _pending.clear();
    for (final c in queued) {
      await pc.addCandidate(c);
    }
  }

  @override
  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    await _pc?.close();
    await _signals.close();
    await _remote.close();
  }
}
