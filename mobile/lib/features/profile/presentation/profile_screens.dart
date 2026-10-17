import 'package:country_picker/country_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

import '../../../core/errors/failure.dart';
import '../../../core/di/dependencies.dart';
import '../../../core/l10n/tr_extension.dart';
import '../../../shared/widgets/user_avatar.dart';
import '../../auth/presentation/session_cubit.dart';
import '../data/profile_repository.dart';

class UserProfileScreen extends StatefulWidget {
  const UserProfileScreen({required this.username, super.key});

  final String username;

  @override
  State<UserProfileScreen> createState() => _UserProfileScreenState();
}

class _UserProfileScreenState extends State<UserProfileScreen> {
  bool? _following;
  late final Future<PublicProfile> _profile = context
      .read<AppDependencies>()
      .profile
      .byUsername(widget.username);

  Future<void> _toggle(PublicProfile p) async {
    final t = context.tRead;
    final deps = context.read<AppDependencies>();
    final session = context.read<SessionCubit>().state;
    if (!session.isSignedIn || session.user!.isGuest) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(t('Sign in to follow people'))));
      return;
    }
    final messenger = ScaffoldMessenger.of(context);
    try {
      final now = await deps.profile.setFollow(
        p.person.id,
        follow: !(_following ?? p.person.isFollowing),
      );
      setState(() => _following = now);
    } on ApiException catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final me = context.watch<SessionCubit>().state.user;
    return Scaffold(
      appBar: AppBar(title: Text('@${widget.username}')),
      body: FutureBuilder<PublicProfile>(
        future: _profile,
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done)
            return const Center(child: CircularProgressIndicator());
          final e = snap.error;
          if (e != null)
            return Center(
              child: Text(
                e is ApiException && e.status == 404
                    ? t('User not found')
                    : errorText(e),
              ),
            );
          final p = snap.data!;
          final following = _following ?? p.person.isFollowing;
          final isMe = me?.id == p.person.id;
          return ListView(
            padding: const EdgeInsets.all(24),
            children: [
              Center(
                child: UserAvatar(
                  url: p.person.avatar,
                  name: p.person.displayName,
                  radius: 52,
                ),
              ),
              const SizedBox(height: 12),
              Text(
                p.person.displayName,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.headlineSmall,
              ),
              Text(
                [
                  p.country,
                  if (p.age != null) '${p.age}',
                ].where((s) => s.isNotEmpty).join(' · '),
                textAlign: TextAlign.center,
              ),
              if (p.bio.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Text(p.bio, textAlign: TextAlign.center),
                ),
              const SizedBox(height: 16),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                children: [
                  _Stat(t('Followers'), p.followers),
                  _Stat(t('Following'), p.following),
                  _Stat(t('Likes'), p.likes),
                ],
              ),
              const SizedBox(height: 24),
              if (isMe)
                FilledButton(
                  onPressed: () => context.push('/edit-profile'),
                  child: Text(t('Edit profile')),
                )
              else ...[
                FilledButton(
                  key: const Key('follow'),
                  onPressed: () => _toggle(p),
                  child: Text(following ? t('Unfollow') : t('Follow')),
                ),
                const SizedBox(height: 8),
                OutlinedButton(
                  onPressed: () => context.push('/chat/${p.person.id}'),
                  child: Text(t('Message')),
                ),
              ],
            ],
          );
        },
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat(this.label, this.value);

  final String label;
  final int value;

  @override
  Widget build(BuildContext context) => Column(
    children: [
      Text(
        '$value',
        style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18),
      ),
      Text(label),
    ],
  );
}

class EditProfileScreen extends StatefulWidget {
  const EditProfileScreen({super.key});

  @override
  State<EditProfileScreen> createState() => _EditProfileScreenState();
}

class _EditProfileScreenState extends State<EditProfileScreen> {
  late final TextEditingController _name;
  late final TextEditingController _username;
  late final TextEditingController _bio;
  late final TextEditingController _age;
  String _gender = 'other';
  Country? _country;
  bool _busy = false;
  Map<String, String> _errors = const {};

  @override
  void initState() {
    super.initState();
    final u = context.read<SessionCubit>().state.user;
    _name = TextEditingController(text: u?.name);
    _username = TextEditingController(text: u?.username);
    _bio = TextEditingController(text: u?.bio);
    _age = TextEditingController(text: u?.age?.toString() ?? '');
    _gender = u?.gender ?? 'other';
  }

  @override
  void dispose() {
    _name.dispose();
    _username.dispose();
    _bio.dispose();
    _age.dispose();
    super.dispose();
  }

  Future<void> _photo() async {
    final file = await ImagePicker().pickImage(
      source: ImageSource.gallery,
      maxWidth: 1024,
    );
    if (file == null || !mounted) return;
    setState(() => _busy = true);
    final messenger = ScaffoldMessenger.of(context);
    final deps = context.read<AppDependencies>();
    final session = context.read<SessionCubit>();
    try {
      final u = await deps.profile.uploadAvatar(file.path);
      session.patchUser((x) => x.copyWith(avatar: u.avatar));
    } on ApiException catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _errors = const {};
    });
    final t = context.tRead;
    final messenger = ScaffoldMessenger.of(context);
    final router = GoRouter.of(context);
    final deps = context.read<AppDependencies>();
    final session = context.read<SessionCubit>();
    try {
      await deps.profile.update(
        ProfileEdit(
          name: _name.text.trim(),
          username: _username.text.trim(),
          bio: _bio.text,
          age: int.tryParse(_age.text),
          gender: _gender,
          country: _country?.name,
          countryCode: _country?.countryCode,
        ),
      );
      await session.reloadUser();
      messenger.showSnackBar(SnackBar(content: Text(t('Profile updated'))));
      router.pop();
    } on ApiException catch (e) {
      setState(() => _errors = e.fieldErrors);
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            e.fieldErrors.isNotEmpty
                ? t('Please check the highlighted fields')
                : e.message,
          ),
        ),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final u = context.watch<SessionCubit>().state.user;
    return Scaffold(
      appBar: AppBar(title: Text(t('Edit profile'))),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Center(
            child: GestureDetector(
              onTap: _busy ? null : _photo,
              child: UserAvatar(
                url: u?.avatar ?? '',
                name: u?.displayName ?? '',
                radius: 48,
              ),
            ),
          ),
          TextButton(
            onPressed: _busy ? null : _photo,
            child: Text(t('Change photo')),
          ),
          TextField(
            key: const Key('name'),
            controller: _name,
            decoration: InputDecoration(
              labelText: t('Name'),
              errorText: _errors['name'],
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            key: const Key('username'),
            controller: _username,
            decoration: InputDecoration(
              labelText: t('Username'),
              errorText: _errors['username'],
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            key: const Key('age'),
            controller: _age,
            keyboardType: TextInputType.number,
            decoration: InputDecoration(
              labelText: t('Age'),
              errorText: _errors['age'],
            ),
          ),
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(
            initialValue: _gender,
            decoration: InputDecoration(labelText: t('Gender')),
            items: [
              for (final g in const ['male', 'female', 'other'])
                DropdownMenuItem(
                  value: g,
                  child: Text(t(g[0].toUpperCase() + g.substring(1))),
                ),
            ],
            onChanged: (v) => setState(() => _gender = v ?? 'other'),
          ),
          const SizedBox(height: 12),
          OutlinedButton(
            onPressed: () => showCountryPicker(
              context: context,
              onSelect: (c) => setState(() => _country = c),
            ),
            child: Text(
              _country?.name ??
                  (u?.country.isNotEmpty ?? false
                      ? u!.country
                      : t('Select country')),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            key: const Key('bio'),
            controller: _bio,
            maxLines: 3,
            maxLength: 500,
            decoration: InputDecoration(
              labelText: t('Bio'),
              errorText: _errors['bio'],
            ),
          ),
          const SizedBox(height: 12),
          FilledButton(
            key: const Key('save'),
            onPressed: _busy ? null : _save,
            child: Text(t('Save')),
          ),
        ],
      ),
    );
  }
}

class DeleteAccountScreen extends StatefulWidget {
  const DeleteAccountScreen({super.key});

  @override
  State<DeleteAccountScreen> createState() => _DeleteAccountScreenState();
}

class _DeleteAccountScreenState extends State<DeleteAccountScreen> {
  final _password = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _password.dispose();
    super.dispose();
  }

  Future<void> _delete() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final deps = context.read<AppDependencies>();
    final session = context.read<SessionCubit>();
    try {
      await deps.profile.deleteAccount(_password.text);
      await session.signOut();
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Scaffold(
      appBar: AppBar(title: Text(t('Delete account'))),
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(t('This is permanent. Enter your password to confirm.')),
            const SizedBox(height: 16),
            TextField(
              key: const Key('password'),
              controller: _password,
              obscureText: true,
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(
                labelText: t('Password'),
                errorText: _error,
              ),
            ),
            const SizedBox(height: 16),
            FilledButton(
              key: const Key('delete'),
              style: FilledButton.styleFrom(
                backgroundColor: Theme.of(context).colorScheme.error,
                foregroundColor: Colors.white,
              ),
              onPressed: _busy || _password.text.isEmpty ? null : _delete,
              child: Text(t('Delete my account')),
            ),
          ],
        ),
      ),
    );
  }
}
