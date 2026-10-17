import 'package:flutter_test/flutter_test.dart';
import 'package:vibematch/core/storage/token_store.dart';
import 'package:vibematch/features/auth/presentation/session_cubit.dart';
import 'package:vibematch/features/matching/domain/match_models.dart';
import 'package:vibematch/features/matching/presentation/matching_cubit.dart';

import '../helpers/fake_adapter.dart';
import '../helpers/harness.dart';

Map<String, Object?> partner([String id = 'p1']) => {
  'id': id,
  'name': 'Bella',
  'username': 'bella',
  'avatar': '',
  'country': 'Spain',
  'countryCode': 'ES',
  'likesCount': 2,
  'isVip': false,
};

void main() {
  late Harness h;
  late SessionCubit session;
  late MatchingCubit cubit;

  setUp(() async {
    h = await Harness.create(
      store: InMemoryTokenStore(validSession()),
      handler: (o) {
        if (o.path.endsWith('/auth/me')) return FakeResponse.ok(userJson());
        if (o.path.endsWith('/webrtc/ice-servers'))
          return FakeResponse.ok({
            'iceServers': [
              {'urls': 'stun:x'},
            ],
          });
        if (o.method == 'PUT' && o.path.endsWith('/like'))
          return FakeResponse.ok({'liked': true, 'likesCount': 3});
        if (o.method == 'DELETE' && o.path.endsWith('/like'))
          return FakeResponse.ok({'liked': false, 'likesCount': 2});
        if (o.method == 'PUT' && o.path.endsWith('/follow'))
          return FakeResponse.ok({'isFollowing': true});
        return FakeResponse.ok({});
      },
    );
    h.socket.acks['join_queue'] = {
      'ok': true,
      'applied': {'filtersIgnored': false},
    };
    session = await h.session();
    cubit = MatchingCubit(h.deps, session);
    addTearDown(cubit.close);
  });

  test(
    'start opens media, fetches ICE, joins the queue with filters',
    () async {
      await cubit.start(
        const Filters(gender: 'female', country: 'Spain', superMatch: true),
      );
      expect(h.media.opened, isTrue);
      expect(h.socket.sent('join_queue').single.$2, {
        'gender': 'female',
        'country': 'Spain',
        'superMatch': true,
      });
      expect(cubit.state.phase, Phase.searching);
    },
  );

  test('"All Countries" is not sent to the server', () async {
    await cubit.start();
    expect(h.socket.sent('join_queue').single.$2, {
      'gender': 'both',
      'superMatch': false,
    });
  });

  test(
    'denied camera permission becomes a friendly error and releases media',
    () async {
      h.media.openError = StateError('denied');
      await cubit.start();
      expect(cubit.state.phase, Phase.idle);
      expect(cubit.state.error, isNotNull);
      expect(h.media.opened, isFalse);
    },
  );

  test('match_found connects, starts a peer and relays its signals', () async {
    await cubit.start();
    h.socket.fire('match_found', {'partner': partner(), 'initiator': true});
    await Future<void>.delayed(Duration.zero);
    final s = cubit.state;
    expect(s.phase, Phase.connected);
    expect(s.partner?.name, 'Bella');
    expect(h.peers.single.started, isTrue);
    expect(
      h.socket.sent('signal').single.$2,
      containsPair('signal', containsPair('type', 'offer')),
    );
    h.socket.fire('signal', {
      'signal': {'type': 'answer', 'sdp': {}},
    });
    await Future<void>.delayed(Duration.zero);
    expect(h.peers.single.handled.single['type'], 'answer');
  });

  test('demo partners play a video and create no peer', () async {
    await cubit.start();
    h.socket.fire('match_found', {
      'partner': partner(),
      'isDemo': true,
      'videoUrl': 'http://v/x.mp4',
    });
    expect(cubit.state.isDemo, isTrue);
    expect(cubit.state.videoUrl, 'http://v/x.mp4');
    expect(h.peers, isEmpty);
  });

  test('partner_skipped closes the peer and searches again', () async {
    await cubit.start();
    h.socket.fire('match_found', {'partner': partner(), 'initiator': false});
    await Future<void>.delayed(Duration.zero);
    h.socket.fire('partner_skipped', {});
    await Future<void>.delayed(Duration.zero);
    expect(h.peers.single.closed, isTrue);
    expect(h.socket.sent('join_queue'), hasLength(2));
    expect(cubit.state.phase, Phase.searching);
  });

  test('next skips and re-queues', () async {
    await cubit.start();
    await cubit.next();
    expect(h.socket.sent('skip_match'), hasLength(1));
    expect(h.socket.sent('join_queue'), hasLength(2));
  });

  test(
    'messages: own and partner, de-duplicated, ignoring other senders',
    () async {
      await cubit.start();
      h.socket.fire('match_found', {'partner': partner(), 'initiator': false});
      h.socket.acks['send_message'] = {
        'ok': true,
        'message': {'id': 'm1'},
      };
      await cubit.sendMessage('  hi  ');
      expect(h.socket.sent('send_message').single.$2, {'text': 'hi'});
      h.socket.fire('receive_message', {
        'id': 'm2',
        'from': 'p1',
        'text': 'yo',
      });
      h.socket.fire('receive_message', {
        'id': 'm2',
        'from': 'p1',
        'text': 'yo',
      });
      h.socket.fire('receive_message', {
        'id': 'm3',
        'from': 'stranger',
        'text': 'spam',
      });
      expect(cubit.state.messages.map((m) => m.id), ['m1', 'm2']);
    },
  );

  test('sending a gift updates the gem balance', () async {
    await cubit.start();
    h.socket.fire('match_found', {'partner': partner(), 'initiator': false});
    h.socket.acks['send_gift'] = {
      'ok': true,
      'balance': 250,
      'message': {'id': 'g1'},
      'gift': {'name': 'Rose', 'image': '/r.svg', 'price': 50},
    };
    await cubit.sendGift('gift1');
    expect(session.state.user?.gems, 250);
    expect(cubit.state.messages.single.giftName, 'Rose');
  });

  test('like and follow toggle against the API', () async {
    await cubit.start();
    h.socket.fire('match_found', {'partner': partner(), 'initiator': false});
    await cubit.toggleLike();
    expect(cubit.state.liked, isTrue);
    expect(cubit.state.partner?.likesCount, 3);
    await cubit.toggleLike();
    expect(cubit.state.liked, isFalse);
    await cubit.toggleFollow();
    expect(cubit.state.following, isTrue);
  });

  test('mic and camera toggles reach the media layer', () async {
    cubit.toggleMic();
    cubit.toggleCam();
    expect(h.media.mic, isFalse);
    expect(h.media.cam, isFalse);
    expect(cubit.state.mic, isFalse);
  });

  test('stop leaves the queue and releases the camera', () async {
    await cubit.start();
    await cubit.stop();
    expect(h.socket.sent('leave_queue'), hasLength(1));
    expect(h.media.opened, isFalse);
    expect(cubit.state.phase, Phase.idle);
  });

  test('a match_error from the server is surfaced', () async {
    await cubit.start();
    h.socket.fire('match_error', {'message': 'Not allowed'});
    expect(cubit.state.error, 'Not allowed');
    expect(cubit.state.phase, Phase.idle);
  });
}
