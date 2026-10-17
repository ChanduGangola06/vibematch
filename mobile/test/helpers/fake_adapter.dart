import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';

typedef Handler = FutureOr<FakeResponse> Function(RequestOptions options);

class FakeResponse {
  const FakeResponse(this.status, [this.body, this.headers = const {}]);

  final int status;
  final Object? body;
  final Map<String, String> headers;

  static FakeResponse ok(Object? data, {Object? page}) => FakeResponse(200, {
    'data': data,
    if (page != null) 'page': page,
    'meta': {},
  });
  static FakeResponse problem(
    int status,
    String code, {
    String detail = 'x',
    List<Map<String, String>>? errors,
  }) => FakeResponse(status, {
    'status': status,
    'code': code,
    'detail': detail,
    if (errors != null) 'errors': errors,
  });
}

/// Scriptable Dio adapter: records every request and answers from [handler].
class FakeAdapter implements HttpClientAdapter {
  FakeAdapter(this.handler);

  Handler handler;
  final List<RequestOptions> calls = [];

  List<RequestOptions> where(String method, String pathEnd) => calls
      .where((c) => c.method == method && c.path.endsWith(pathEnd))
      .toList();

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    calls.add(options);
    final r = await handler(options);
    final bytes = utf8.encode(jsonEncode(r.body));
    return ResponseBody.fromBytes(
      bytes,
      r.status,
      headers: {
        Headers.contentTypeHeader: [
          r.status >= 400 ? 'application/problem+json' : 'application/json',
        ],
        for (final e in r.headers.entries) e.key: [e.value],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}
