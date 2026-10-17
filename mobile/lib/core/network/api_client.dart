import 'package:dio/dio.dart';

import '../config/app_config.dart';
import '../errors/failure.dart';
import '../storage/token_store.dart';
import 'interceptors.dart';

/// Result envelope the API wraps every payload in: `{ data, page?, meta }`.
class Envelope {
  const Envelope(this.data, this.page);

  final Object? data;
  final PageInfo? page;
}

class PageInfo {
  const PageInfo({required this.hasMore, this.nextCursor});

  final bool hasMore;
  final String? nextCursor;

  static PageInfo? from(Object? json) {
    if (json is! Map) return null;
    return PageInfo(
      hasMore: json['hasMore'] == true,
      nextCursor: json['nextCursor'] as String?,
    );
  }
}

/// Thin typed wrapper over Dio: unwraps the envelope and always throws [ApiException].
class ApiClient {
  ApiClient(this.dio);

  final Dio dio;

  Future<Envelope> request(
    String method,
    String path, {
    Object? body,
    Map<String, Object?>? query,
    Map<String, Object?>? headers,
    bool idempotent = false,
  }) async {
    try {
      final res = await dio.request<Object?>(
        path,
        data: body,
        queryParameters: query == null
            ? null
            : {
                for (final e in query.entries)
                  if (e.value != null) e.key: e.value,
              },
        options: Options(
          method: method,
          headers: headers,
          extra: {if (idempotent) 'idempotent': true},
        ),
      );
      final d = res.data;
      if (d is Map) return Envelope(d['data'], PageInfo.from(d['page']));
      return const Envelope(null, null);
    } on DioException catch (e) {
      final inner = e.error;
      throw inner is ApiException ? inner : ApiException.network();
    }
  }

  Future<Object?> get(String path, {Map<String, Object?>? query}) async =>
      (await request('GET', path, query: query)).data;
  Future<Object?> post(
    String path, {
    Object? body,
    bool idempotent = false,
  }) async => (await request(
    'POST',
    path,
    body: body ?? const <String, Object?>{},
    idempotent: idempotent,
  )).data;
  Future<Object?> put(String path, {Object? body}) async => (await request(
    'PUT',
    path,
    body: body ?? const <String, Object?>{},
  )).data;
  Future<Object?> patch(String path, {Object? body}) async =>
      (await request('PATCH', path, body: body)).data;
  Future<void> delete(String path) async => request('DELETE', path);
  Future<Object?> deleteData(String path) async =>
      (await request('DELETE', path)).data;
}

/// Builds the Dio instance with the interceptor chain in the order that matters:
/// request: api-key -> idempotency -> auth; error: auth(refresh+replay) -> retry -> problem-details.
ApiClient buildApiClient({
  required AppConfig config,
  required TokenStore store,
  void Function(String reason)? onSessionLost,
  HttpClientAdapter? adapter,
  Future<void> Function(Duration)? retrySleep,
}) {
  BaseOptions base() => BaseOptions(
    baseUrl: config.apiRoot,
    connectTimeout: const Duration(seconds: 10),
    receiveTimeout: const Duration(seconds: 20),
    sendTimeout: const Duration(seconds: 20),
    headers: {'Accept': 'application/json'},
    // Non-2xx must reach the interceptors as DioExceptions.
    validateStatus: (s) => s != null && s >= 200 && s < 300,
  );

  final dio = Dio(base());
  // Used for replays and the refresh call itself: it must not re-enter the auth interceptor's queue.
  final bare = Dio(base());
  if (adapter != null) {
    dio.httpClientAdapter = adapter;
    bare.httpClientAdapter = adapter;
  }
  bare.interceptors.add(
    ApiKeyInterceptor(config.apiKey, apiVersion: config.apiVersion),
  );

  Future<Session> refresh(String refreshToken) async {
    try {
      final res = await bare.post<Object?>(
        '/auth/refresh',
        data: {'refreshToken': refreshToken},
      );
      final data = (res.data as Map)['data'] as Map;
      return sessionFromTokens(data['tokens'] as Map);
    } on DioException catch (e) {
      final r = e.response;
      throw r == null
          ? ApiException.network()
          : ApiException.fromProblem(r.statusCode ?? 0, r.data);
    }
  }

  dio.interceptors.addAll([
    ApiKeyInterceptor(config.apiKey, apiVersion: config.apiVersion),
    IdempotencyInterceptor(),
    AuthInterceptor(
      store: store,
      refresh: refresh,
      retryDio: bare,
      onSessionLost: onSessionLost,
    ),
    RetryInterceptor(dio: dio, sleep: retrySleep),
    ProblemDetailsInterceptor(),
  ]);
  return ApiClient(dio);
}

Session sessionFromTokens(
  Map<dynamic, dynamic> tokens, {
  DateTime Function()? clock,
}) {
  final now = (clock ?? DateTime.now)();
  final expiresIn = (tokens['expiresIn'] as num?)?.toInt() ?? 900;
  return Session(
    accessToken: tokens['accessToken'] as String,
    refreshToken: tokens['refreshToken'] as String,
    expiresAt: now.add(Duration(seconds: expiresIn)),
  );
}
