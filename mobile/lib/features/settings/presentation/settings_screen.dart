import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/di/dependencies.dart';
import '../../../core/l10n/language_repository.dart';
import '../../../core/l10n/tr_extension.dart';
import '../../../core/l10n/translator_cubit.dart';
import '../../auth/presentation/session_cubit.dart';
import 'site_settings_cubit.dart';
import '../../store/presentation/store_sheets.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  List<LanguageInfo> langs = const [];

  @override
  void initState() {
    super.initState();
    context.read<AppDependencies>().languages.list().then((l) {
      if (mounted) setState(() => langs = l);
    }, onError: (Object _) {});
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final user = context.watch<SessionCubit>().state.user;
    final site = context.watch<SiteSettingsCubit>().state;
    return ListView(
      children: [
        if (user != null)
          ListTile(
            leading: const Icon(Icons.person_rounded),
            title: Text(user.displayName),
            subtitle: Text('@${user.username} · ${user.gems} 💎'),
            onTap: user.isGuest
                ? null
                : () => context.push('/u/${user.username}'),
          ),
        if (user != null && !user.isGuest)
          ListTile(
            leading: const Icon(Icons.edit_rounded),
            title: Text(t('Edit profile')),
            onTap: () => context.push('/edit-profile'),
          ),
        ListTile(
          leading: const Icon(Icons.diamond_rounded),
          title: Text(t('Get gems')),
          onTap: () => showStoreSheet(context),
        ),
        ListTile(
          leading: const Icon(Icons.workspace_premium_rounded),
          title: Text(t('Go VIP')),
          onTap: () => showVipSheet(context),
        ),
        ListTile(
          leading: const Icon(Icons.language_rounded),
          title: Text(t('Language')),
          subtitle: Text(t.code),
          onTap: langs.isEmpty
              ? null
              : () => showModalBottomSheet<void>(
                  context: context,
                  builder: (_) => ListView(
                    children: [
                      for (final l in langs)
                        ListTile(
                          title: Text(l.name),
                          trailing: l.code == context.tRead.code
                              ? const Icon(Icons.check)
                              : null,
                          onTap: () {
                            context.read<TranslatorCubit>().setLanguage(l.code);
                            Navigator.of(context).pop();
                          },
                        ),
                    ],
                  ),
                ),
        ),
        if (site.termsUrl.isNotEmpty)
          ListTile(
            leading: const Icon(Icons.description_rounded),
            title: Text(t('Terms of service')),
            onTap: () => _open(site.termsUrl),
          ),
        if (site.privacyUrl.isNotEmpty)
          ListTile(
            leading: const Icon(Icons.privacy_tip_rounded),
            title: Text(t('Privacy policy')),
            onTap: () => _open(site.privacyUrl),
          ),
        if (user != null)
          ListTile(
            key: const Key('sign-out'),
            leading: const Icon(Icons.logout_rounded),
            title: Text(t('Sign out')),
            onTap: context.read<SessionCubit>().signOut,
          ),
        if (user != null && !user.isGuest)
          ListTile(
            leading: Icon(
              Icons.delete_forever_rounded,
              color: Theme.of(context).colorScheme.error,
            ),
            title: Text(
              t('Delete account'),
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
            onTap: () => context.push('/delete-account'),
          ),
      ],
    );
  }

  Future<void> _open(String url) async {
    final uri = Uri.tryParse(url);
    if (uri != null) await launchUrl(uri, mode: LaunchMode.externalApplication);
  }
}
