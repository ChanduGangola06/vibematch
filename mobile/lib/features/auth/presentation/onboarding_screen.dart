import 'package:flutter/material.dart';
import '../../../core/di/dependencies.dart';
import '../../../core/l10n/tr_extension.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

const kOnboardedKey = 'vm.onboarded';

class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({required this.onDone, super.key});

  final VoidCallback onDone;

  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen> {
  final _controller = PageController();
  int _page = 0;

  static const _pages = [
    (
      Icons.videocam_rounded,
      'Meet new people',
      'Start a random video chat in one tap.',
    ),
    (
      Icons.favorite_rounded,
      'Make real connections',
      'Follow people you like and keep chatting.',
    ),
    (
      Icons.card_giftcard_rounded,
      'Send gifts',
      'Surprise someone with a gift while you talk.',
    ),
  ];

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _finish() async {
    await context.read<AppDependencies>().prefs.setBool(kOnboardedKey, true);
    if (!mounted) return;
    widget.onDone();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final last = _page == _pages.length - 1;
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Align(
              alignment: Alignment.centerRight,
              child: TextButton(
                key: const Key('skip'),
                onPressed: _finish,
                child: Text(t('Skip')),
              ),
            ),
            Expanded(
              child: PageView.builder(
                controller: _controller,
                itemCount: _pages.length,
                onPageChanged: (i) => setState(() => _page = i),
                itemBuilder: (_, i) {
                  final (icon, title, text) = _pages[i];
                  return Padding(
                    padding: const EdgeInsets.all(32),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(
                          icon,
                          size: 96,
                          color: Theme.of(context).colorScheme.primary,
                        ),
                        const SizedBox(height: 24),
                        Text(
                          t(title),
                          style: Theme.of(context).textTheme.headlineSmall
                              ?.copyWith(fontWeight: FontWeight.w800),
                          textAlign: TextAlign.center,
                        ),
                        const SizedBox(height: 12),
                        Text(t(text), textAlign: TextAlign.center),
                      ],
                    ),
                  );
                },
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(24),
              child: FilledButton(
                key: const Key('next'),
                onPressed: last
                    ? _finish
                    : () => _controller.nextPage(
                        duration: const Duration(milliseconds: 250),
                        curve: Curves.easeOut,
                      ),
                child: Text(last ? t('Get started') : t('Next')),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
