import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/dependencies.dart';
import '../../../core/errors/failure.dart';
import '../../../core/l10n/tr_extension.dart';
import '../../settings/data/settings_repository.dart';
import '../../settings/presentation/site_settings_cubit.dart';
import '../data/auth_repository.dart';
import 'session_cubit.dart';

enum _Mode { login, register }

/// Sign in / create account / continue as guest / Google. Server validation errors show under the fields.
class AuthScreen extends StatefulWidget {
  const AuthScreen({super.key});

  @override
  State<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends State<AuthScreen> {
  final _form = GlobalKey<FormState>();
  final _identifier = TextEditingController();
  final _username = TextEditingController();
  final _password = TextEditingController();
  _Mode _mode = _Mode.login;
  String _gender = 'other';
  bool _busy = false;
  String? _error;
  Map<String, String> _fields = const {};

  @override
  void dispose() {
    _identifier.dispose();
    _username.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _run(Future<AuthResult> Function() call) async {
    setState(() {
      _busy = true;
      _error = null;
      _fields = const {};
    });
    final t = context.tRead;
    final session = context.read<SessionCubit>();
    try {
      final r = await call();
      session.signedIn(r.user);
    } on PasskeyRequired {
      setState(
        () => _error = t(
          'This account requires a passkey. Sign in from the admin panel.',
        ),
      );
    } on ApiException catch (e) {
      setState(() {
        _fields = e.fieldErrors;
        _error = e.fieldErrors.isNotEmpty
            ? t('Please check the highlighted fields')
            : e.message;
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _submit() {
    if (!(_form.currentState?.validate() ?? false)) return;
    final repo = context.read<AppDependencies>().auth;
    if (_mode == _Mode.login) {
      _run(() => repo.login(_identifier.text.trim(), _password.text));
    } else {
      _run(
        () => repo.register(
          username: _username.text.trim(),
          email: _identifier.text.trim(),
          password: _password.text,
          gender: _gender,
        ),
      );
    }
  }

  Future<void> _google() async {
    final t = context.tRead;
    final deps = context.read<AppDependencies>();
    try {
      final token = await deps.social.googleIdToken();
      if (token == null || !mounted) return;
      await _run(() => deps.auth.social(token));
    } on Object {
      if (mounted) setState(() => _error = t('Google sign-in failed'));
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final SiteSettings settings = context.watch<SiteSettingsCubit>().state;
    final register = _mode == _Mode.register;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Form(
                key: _form,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      settings.siteName,
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.headlineMedium
                          ?.copyWith(fontWeight: FontWeight.w900),
                    ),
                    const SizedBox(height: 24),
                    SegmentedButton<_Mode>(
                      segments: [
                        ButtonSegment(
                          value: _Mode.login,
                          label: Text(t('Sign in')),
                        ),
                        ButtonSegment(
                          value: _Mode.register,
                          label: Text(t('Create account')),
                        ),
                      ],
                      selected: {_mode},
                      onSelectionChanged: (s) => setState(() {
                        _mode = s.first;
                        _error = null;
                        _fields = const {};
                      }),
                    ),
                    const SizedBox(height: 16),
                    TextFormField(
                      key: const Key('identifier'),
                      controller: _identifier,
                      keyboardType: TextInputType.emailAddress,
                      autofillHints: const [AutofillHints.username],
                      decoration: InputDecoration(
                        labelText: register
                            ? t('Email')
                            : t('Email or username'),
                        errorText: _fields['email'] ?? _fields['identifier'],
                      ),
                      validator: (v) => (v == null || v.trim().isEmpty)
                          ? t('Required')
                          : null,
                    ),
                    if (register) ...[
                      const SizedBox(height: 12),
                      TextFormField(
                        key: const Key('username'),
                        controller: _username,
                        decoration: InputDecoration(
                          labelText: t('Username'),
                          errorText: _fields['username'],
                        ),
                        validator: (v) =>
                            RegExp(r'^[a-zA-Z0-9_]{3,20}$').hasMatch(v ?? '')
                            ? null
                            : t('3-20 letters, numbers or _'),
                      ),
                    ],
                    const SizedBox(height: 12),
                    TextFormField(
                      key: const Key('password'),
                      controller: _password,
                      obscureText: true,
                      autofillHints: [
                        register
                            ? AutofillHints.newPassword
                            : AutofillHints.password,
                      ],
                      decoration: InputDecoration(
                        labelText: t('Password'),
                        errorText: _fields['password'],
                      ),
                      validator: (v) =>
                          (v == null || v.length < (register ? 8 : 1))
                          ? t(register ? 'At least 8 characters' : 'Required')
                          : null,
                    ),
                    if (register) ...[
                      const SizedBox(height: 12),
                      DropdownButtonFormField<String>(
                        initialValue: _gender,
                        decoration: InputDecoration(labelText: t('Gender')),
                        items: [
                          DropdownMenuItem(
                            value: 'male',
                            child: Text(t('Male')),
                          ),
                          DropdownMenuItem(
                            value: 'female',
                            child: Text(t('Female')),
                          ),
                          DropdownMenuItem(
                            value: 'other',
                            child: Text(t('Other')),
                          ),
                        ],
                        onChanged: (v) =>
                            setState(() => _gender = v ?? 'other'),
                      ),
                    ],
                    if (_error != null) ...[
                      const SizedBox(height: 12),
                      Text(
                        _error!,
                        key: const Key('auth-error'),
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
                    ],
                    const SizedBox(height: 16),
                    FilledButton(
                      key: const Key('submit'),
                      onPressed: _busy ? null : _submit,
                      child: _busy
                          ? const SizedBox(
                              height: 20,
                              width: 20,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : Text(register ? t('Create account') : t('Sign in')),
                    ),
                    const SizedBox(height: 16),
                    if (settings.googleLogin)
                      OutlinedButton(
                        key: const Key('google'),
                        onPressed: _busy ? null : _google,
                        child: Text(t('Continue with Google')),
                      ),
                    if (settings.guestLogin)
                      TextButton(
                        key: const Key('guest'),
                        onPressed: _busy
                            ? null
                            : () => _run(
                                context.read<AppDependencies>().auth.guest,
                              ),
                        child: Text(t('Continue as guest')),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
