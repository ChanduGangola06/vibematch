import 'package:flutter_bloc/flutter_bloc.dart';

import 'language_repository.dart';
import 'translator.dart';

/// Current translations. English is instant; other packs load from the network with an offline cache.
class TranslatorCubit extends Cubit<Translator> {
  TranslatorCubit(this._repo) : super(const Translator());

  final LanguageRepository _repo;

  Future<void> init() async {
    final code = _repo.savedCode;
    if (code != 'en') emit(await _repo.load(code));
  }

  Future<void> setLanguage(String code) async {
    await _repo.saveCode(code);
    emit(await _repo.load(code));
  }
}
