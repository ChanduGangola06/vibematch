import 'package:flutter/widgets.dart';

/// English text is the key (same convention as the web app and the admin "Languages" editor).
/// Missing keys fall back to the English text, so an incomplete pack never shows blanks.
class Translator {
  const Translator({
    this.code = 'en',
    this.rtl = false,
    this.messages = const {},
  });

  final String code;
  final bool rtl;
  final Map<String, String> messages;

  TextDirection get direction => rtl ? TextDirection.rtl : TextDirection.ltr;

  String call(String key, [Map<String, Object?> args = const {}]) {
    var out = messages[key] ?? key;
    args.forEach((k, v) => out = out.replaceAll('{$k}', '$v'));
    return out;
  }
}
