import 'dart:async';

import 'package:socket_io_client/socket_io_client.dart' as io;

import '../core/errors/failure.dart';

typedef SocketHandler = void Function(Object? data);

/// What the app needs from a realtime connection. The Socket.IO client sits behind it so features and
/// tests never depend on the plugin.
abstract class SocketPort {
  bool get connected;
  void connect();
  void disconnect();
  void on(String event, SocketHandler handler);
  void off(String event, [SocketHandler? handler]);
  void emit(String event, [Object? payload]);

  /// Emit and wait for the server's `{ok, ...}` acknowledgement. Throws [ApiException] on `ok:false`/timeout.
  Future<Map<String, Object?>> emitAck(
    String event, [
    Object? payload,
    Duration timeout = const Duration(seconds: 8),
  ]);
}

class IoSocketPort implements SocketPort {
  /// [tokenProvider] is read on every (re)connection so a refreshed access token is used automatically.
  /// [onAuthError] lets the owner refresh the session and reconnect after `token_expired`.
  IoSocketPort({
    required String url,
    required Future<String?> Function() tokenProvider,
    Future<bool> Function()? onAuthError,
  }) : _onAuthError = onAuthError {
    _socket = io.io(
      url,
      io.OptionBuilder()
          .setTransports(['websocket'])
          .disableAutoConnect()
          .setReconnectionDelayMax(8000)
          .build(),
    );
    _tokenProvider = tokenProvider;
    _socket.onConnectError((dynamic err) async {
      final code = err is Map
          ? (err['data'] is Map ? (err['data'] as Map)['code'] : null)
          : null;
      if ((code == 'token_expired' || code == 'token_invalid') &&
          _onAuthError != null &&
          !_refreshing) {
        _refreshing = true;
        try {
          if (await _onAuthError()) await _openWithToken();
        } finally {
          _refreshing = false;
        }
      }
    });
  }

  late final io.Socket _socket;
  late final Future<String?> Function() _tokenProvider;
  final Future<bool> Function()? _onAuthError;
  bool _refreshing = false;
  final Map<String, Map<SocketHandler, void Function(dynamic)>> _wrapped = {};

  Future<void> _openWithToken() async {
    final token = await _tokenProvider();
    _socket.auth = {'token': token};
    _socket.connect();
  }

  @override
  bool get connected => _socket.connected;

  @override
  void connect() => unawaited(_openWithToken());

  @override
  void disconnect() => _socket.disconnect();

  @override
  void on(String event, SocketHandler handler) {
    void wrapper(dynamic d) => handler(d);
    (_wrapped[event] ??= {})[handler] = wrapper;
    _socket.on(event, wrapper);
  }

  @override
  void off(String event, [SocketHandler? handler]) {
    final fns = _wrapped[event];
    if (handler == null) {
      _socket.off(event);
      _wrapped.remove(event);
    } else if (fns != null) {
      final w = fns.remove(handler);
      if (w != null) _socket.off(event, w);
    }
  }

  @override
  void emit(String event, [Object? payload]) =>
      _socket.emit(event, payload ?? <String, Object?>{});

  @override
  Future<Map<String, Object?>> emitAck(
    String event, [
    Object? payload,
    Duration timeout = const Duration(seconds: 8),
  ]) {
    final c = Completer<Map<String, Object?>>();
    final timer = Timer(timeout, () {
      if (!c.isCompleted)
        c.completeError(
          const ApiException(
            status: 0,
            code: 'timeout',
            message: 'The server did not respond',
          ),
        );
    });
    _socket.emitWithAck(
      event,
      payload ?? <String, Object?>{},
      ack: (dynamic res) {
        timer.cancel();
        if (c.isCompleted) return;
        final m = res is Map
            ? res.cast<String, Object?>()
            : const <String, Object?>{};
        if (m['ok'] == true) {
          c.complete(m);
        } else {
          final err = m['error'] is Map
              ? (m['error']! as Map).cast<String, Object?>()
              : const <String, Object?>{};
          c.completeError(
            ApiException(
              status: 0,
              code: (err['code'] as String?) ?? 'error',
              message: (err['message'] as String?) ?? 'Request failed',
            ),
          );
        }
      },
    );
    return c.future;
  }
}
