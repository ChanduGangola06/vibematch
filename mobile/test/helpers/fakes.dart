import 'dart:async';

import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:vibematch/services/socket_port.dart';
import 'package:vibematch/services/webrtc.dart';

class FakeSocketPort implements SocketPort {
  final handlers = <String, List<SocketHandler>>{};
  final emitted = <(String, Object?)>[];
  final acks = <String, Map<String, Object?>>{};
  Object? ackError;
  @override
  bool connected = false;

  @override
  void connect() => connected = true;
  @override
  void disconnect() => connected = false;
  @override
  void on(String event, SocketHandler handler) =>
      (handlers[event] ??= []).add(handler);
  @override
  void off(String event, [SocketHandler? handler]) => handler == null
      ? handlers.remove(event)
      : handlers[event]?.remove(handler);
  @override
  void emit(String event, [Object? payload]) => emitted.add((event, payload));

  @override
  Future<Map<String, Object?>> emitAck(
    String event, [
    Object? payload,
    Duration timeout = const Duration(seconds: 8),
  ]) async {
    emitted.add((event, payload));
    if (ackError != null) throw ackError!;
    return acks[event] ?? {'ok': true};
  }

  void fire(String event, Object? data) {
    for (final h in List.of(handlers[event] ?? const <SocketHandler>[])) {
      h(data);
    }
  }

  List<(String, Object?)> sent(String event) =>
      emitted.where((e) => e.$1 == event).toList();
}

class FakeMedia implements LocalMedia {
  bool opened = false;
  bool? mic;
  bool? cam;
  Object? openError;

  @override
  MediaStream? get stream => null;
  @override
  Future<void> open() async {
    if (openError != null) throw openError!;
    opened = true;
  }

  @override
  Future<void> close() async => opened = false;
  @override
  void setMic(bool on) => mic = on;
  @override
  void setCam(bool on) => cam = on;
}

class FakePeer implements PeerPort {
  FakePeer({required this.initiator});

  final bool initiator;
  final signalsOut = StreamController<Map<String, Object?>>.broadcast();
  final handled = <Map<String, Object?>>[];
  bool started = false;
  bool closed = false;

  @override
  Stream<Map<String, Object?>> get signals => signalsOut.stream;
  @override
  Stream<MediaStream> get remoteStream => const Stream.empty();
  @override
  Future<void> start() async {
    started = true;
    if (initiator)
      signalsOut.add({
        'type': 'offer',
        'sdp': {'type': 'offer', 'sdp': 'x'},
      });
  }

  @override
  Future<void> handle(Map<String, Object?> signal) async => handled.add(signal);
  @override
  Future<void> close() async => closed = true;
}
