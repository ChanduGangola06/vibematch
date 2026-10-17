import 'dart:async';
import 'dart:math';

import 'package:dio/dio.dart';
import 'package:uuid/uuid.dart';

import '../errors/failure.dart';
import '../storage/token_store.dart';

const _uuid = Uuid();

/// Identifies the app. The server uses it to cap privilege and, on `/init`, to authorise the bootstrap call.
class ApiKeyInterceptor extends Interceptor {
  ApiKeyInterceptor(this.apiKey, {this.apiVersion = '1'});

  final String apiKey;
  final String apiVersion;

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    if (apiKey.isNotEmpty) options.headers['X-API-Key'] = apiKey;
    options.headers['Accept-Version'] = apiVersion;
    handler.next(options);
  }
}

/// Adds an `Idempotency-Key` to POSTs that must not run twice (payments, gifts, VIP...). The key is stored
/// on the request, so a replay after a token refresh or a retry after a timeout reuses it.
class IdempotencyInterceptor extends Interceptor {
  IdempotencyInterceptor({RegExp? paths}) : _paths = paths ?? defaultPaths;

  static final defaultPaths = RegExp(
    r'/(payments/[a-z]+/verify|gifts/[^/]+/send|vip-plans/[^/]+/subscribe|conversations/[^/]+/messages)$',
  );
  final RegExp _paths;

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    final wants =
        options.extra['idempotent'] == true ||
        (options.method == 'POST' && _paths.hasMatch(options.path));
    if (wants && !options.headers.containsKey('Idempotency-Key')) {
      options.headers['Idempotency-Key'] = _uuid.v4();
    }
    handler.next(options);
  }
}

typedef RefreshCall = Future<Session> Function(String refreshToken);

/// Attaches the bearer token and, on an expired-token 401, refreshes ONCE (single-flight across all
/// concurrent requests) and replays the original request.
class AuthInterceptor extends Interceptor {
  AuthInterceptor({
    required this.store,
    required this.refresh,
    required this.retryDio,
    this.onSessionLost,
    DateTime Function()? clock,
  }) : _now = clock ?? DateTime.now;

  final TokenStore store;
  final RefreshCall refresh;

  /// A Dio without the auth/retry chain, used to replay the request (re-entering `dio` could deadlock or double-retry).
  final Dio retryDio;
  final void Function(String reason)? onSessionLost;
  final DateTime Function() _now;

  static final _authPaths = RegExp(
    r'/auth/(login|register|guest|social|refresh|token|webauthn)',
  );
  static const _tokenProblems = {
    'token_expired',
    'token_invalid',
    'unauthorized',
    'invalid_token',
  };
  Future<Session?>? _inFlight;

  bool _isAuthPath(String path) => _authPaths.hasMatch(path);

  /// Exactly one refresh at a time; every waiting caller gets the same result.
  Future<Session?> refreshOnce() {
    return _inFlight ??= _doRefresh().whenComplete(() => _inFlight = null);
  }

  Future<Session?> _doRefresh() async {
    final current = await store.read();
    if (current == null) return null;
    try {
      final next = await refresh(current.refreshToken);
      await store.write(next);
      return next;
    } on ApiException catch (e) {
      // Only a definitive rejection ends the session; a flaky network must not log people out.
      if (e.status == 401 || e.status == 403) {
        await store.clear();
        onSessionLost?.call(e.code);
      }
      return null;
    }
  }

  @override
  Future<void> onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    if (_isAuthPath(options.path)) return handler.next(options);
    var session = await store.read();
    if (session != null &&
        session.timeLeft(_now()) < const Duration(seconds: 10)) {
      session = await refreshOnce() ?? session;
    }
    if (session != null)
      options.headers['Authorization'] = 'Bearer ${session.accessToken}';
    handler.next(options);
  }

  @override
  Future<void> onError(
    DioException err,
    ErrorInterceptorHandler handler,
  ) async {
    final res = err.response;
    final req = err.requestOptions;
    final replayed = req.extra['replayed'] == true;

    if (res?.statusCode == 403 && _problemCode(res) == 'account_banned') {
      await store.clear();
      onSessionLost?.call('account_banned');
      return handler.next(err);
    }
    if (res?.statusCode != 401 ||
        replayed ||
        _isAuthPath(req.path) ||
        req.data is FormData) {
      return handler.next(err);
    }
    final code = _problemCode(res);
    if (code != null && !_tokenProblems.contains(code)) {
      if (code == 'session_revoked') {
        await store.clear();
        onSessionLost?.call(code);
      }
      return handler.next(err);
    }
    final next = await refreshOnce();
    if (next == null) return handler.next(err);
    try {
      final opts = req.copyWith(extra: {...req.extra, 'replayed': true});
      opts.headers['Authorization'] = 'Bearer ${next.accessToken}';
      handler.resolve(await retryDio.fetch<dynamic>(opts));
    } on DioException catch (e) {
      handler.next(e);
    }
  }

  String? _problemCode(Response<dynamic>? res) {
    final d = res?.data;
    return d is Map ? d['code'] as String? : null;
  }
}

/// Retries transient failures with exponential backoff + jitter. Only requests that are safe to repeat:
/// GET/HEAD/PUT/DELETE, or any request carrying an Idempotency-Key.
class RetryInterceptor extends Interceptor {
  RetryInterceptor({
    required this.dio,
    this.maxRetries = 2,
    this.baseDelay = const Duration(milliseconds: 400),
    Future<void> Function(Duration)? sleep,
    Random? random,
  }) : _sleep = sleep ?? Future<void>.delayed,
       _random = random ?? Random();

  final Dio dio;
  final int maxRetries;
  final Duration baseDelay;
  final Future<void> Function(Duration) _sleep;
  final Random _random;

  bool _safe(RequestOptions o) =>
      const {'GET', 'HEAD', 'PUT', 'DELETE'}.contains(o.method) ||
      o.headers.containsKey('Idempotency-Key');

  bool _transient(DioException e) {
    if (e.type == DioExceptionType.connectionError ||
        e.type == DioExceptionType.connectionTimeout ||
        e.type == DioExceptionType.receiveTimeout ||
        e.type == DioExceptionType.sendTimeout) {
      return true;
    }
    return const {429, 502, 503, 504}.contains(e.response?.statusCode);
  }

  @override
  Future<void> onError(
    DioException err,
    ErrorInterceptorHandler handler,
  ) async {
    final o = err.requestOptions;
    final attempt = (o.extra['retry'] as int?) ?? 0;
    if (attempt >= maxRetries ||
        !_safe(o) ||
        !_transient(err) ||
        o.data is FormData) {
      return handler.next(err);
    }
    final header = err.response?.headers.value('retry-after');
    final serverDelay = header == null
        ? null
        : Duration(seconds: int.tryParse(header) ?? 0);
    final backoff =
        baseDelay * pow(2, attempt).toInt() +
        Duration(milliseconds: _random.nextInt(120));
    await _sleep(
      serverDelay != null && serverDelay > Duration.zero
          ? serverDelay
          : backoff,
    );
    try {
      final res = await dio.fetch<dynamic>(
        o.copyWith(extra: {...o.extra, 'retry': attempt + 1}),
      );
      handler.resolve(res);
    } on DioException catch (e) {
      handler.next(e);
    }
  }
}

/// Last in the chain: turns whatever failed into an [ApiException] the UI can switch on.
class ProblemDetailsInterceptor extends Interceptor {
  @override
  void onError(DioException err, ErrorInterceptorHandler handler) {
    final res = err.response;
    final ApiException ex;
    if (res == null) {
      ex = err.type == DioExceptionType.cancel
          ? const ApiException(
              status: 0,
              code: 'cancelled',
              message: 'Cancelled',
            )
          : ApiException.network();
    } else {
      final ra = int.tryParse(res.headers.value('retry-after') ?? '');
      ex = ApiException.fromProblem(
        res.statusCode ?? 0,
        res.data,
        retryAfter: ra == null ? null : Duration(seconds: ra),
      );
    }
    handler.next(err.copyWith(error: ex));
  }
}
