import 'package:flutter/widgets.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import 'translator.dart';
import 'translator_cubit.dart';

extension TranslateContext on BuildContext {
  /// `context.t('Sign in')` - rebuilds the widget when the language changes.
  Translator get t => watch<TranslatorCubit>().state;

  /// Same, for callbacks (does not subscribe).
  Translator get tRead => read<TranslatorCubit>().state;
}
