import 'package:flutter_bloc/flutter_bloc.dart';

import '../data/settings_repository.dart';

/// Public site configuration. Starts from the on-device cache so branding shows instantly.
class SiteSettingsCubit extends Cubit<SiteSettings> {
  SiteSettingsCubit(this._repo) : super(_repo.cached());

  final SettingsRepository _repo;

  Future<void> load() async => emit(await _repo.load());
}
