import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../core/di/dependencies.dart';

/// Network image with an initials fallback, so a missing or broken URL never shows an error icon.
class UserAvatar extends StatelessWidget {
  const UserAvatar({
    required this.url,
    required this.name,
    this.radius = 22,
    super.key,
  });

  final String url;
  final String name;
  final double radius;

  String get _initials {
    final parts = name
        .trim()
        .split(RegExp(r'\s+'))
        .where((p) => p.isNotEmpty)
        .take(2);
    final s = parts.map((p) => p[0].toUpperCase()).join();
    return s.isEmpty ? '?' : s;
  }

  @override
  Widget build(BuildContext context) {
    final fallback = CircleAvatar(
      radius: radius,
      backgroundColor: const Color(0xFF047857),
      child: Text(
        _initials,
        style: const TextStyle(fontWeight: FontWeight.w800),
      ),
    );
    if (url.isEmpty || url.endsWith('.svg'))
      return fallback; // SVG presets: shown as initials until flutter_svg is wired
    final abs = context.read<AppDependencies>().config.absoluteUrl(url);
    return ClipOval(
      child: Image.network(
        abs,
        width: radius * 2,
        height: radius * 2,
        fit: BoxFit.cover,
        errorBuilder: (_, _, _) => fallback,
      ),
    );
  }
}
