import 'package:equatable/equatable.dart';

/// RFC 9457 problem details as sent by the API, surfaced as one exception type.
/// UI code switches on [code], never on [message] text.
class ApiException extends Equatable implements Exception {
  const ApiException({
    required this.status,
    required this.code,
    required this.message,
    this.fieldErrors = const {},
    this.requestId,
    this.retryAfter,
  });

  final int status;
  final String code;
  final String message;
  final Map<String, String> fieldErrors;
  final String? requestId;
  final Duration? retryAfter;

  bool isCode(String c) => code == c;
  bool get isNetwork => status == 0;
  bool get isUnauthorized => status == 401;

  factory ApiException.network([
    String message = 'Cannot reach the server. Check your connection.',
  ]) => ApiException(status: 0, code: 'network_error', message: message);

  factory ApiException.fromProblem(
    int status,
    Object? body, {
    Duration? retryAfter,
  }) {
    if (body is Map) {
      final errors = <String, String>{};
      final raw = body['errors'];
      if (raw is List) {
        for (final e in raw) {
          if (e is Map && e['message'] is String) {
            errors[(e['path'] as String?) ?? '_'] = e['message'] as String;
          }
        }
      }
      return ApiException(
        status: status,
        code: (body['code'] as String?) ?? 'error',
        message:
            (body['detail'] as String?) ??
            (body['title'] as String?) ??
            'Request failed ($status)',
        fieldErrors: errors,
        requestId: body['requestId'] as String?,
        retryAfter: retryAfter,
      );
    }
    return ApiException(
      status: status,
      code: 'error',
      message: 'Request failed ($status)',
      retryAfter: retryAfter,
    );
  }

  @override
  List<Object?> get props => [status, code, message, fieldErrors, requestId];

  @override
  String toString() => 'ApiException($status $code: $message)';
}

/// Human-readable text for any thrown object.
String errorText(Object? e, [String fallback = 'Something went wrong']) {
  if (e is ApiException) return e.message.isNotEmpty ? e.message : fallback;
  return fallback;
}
