import 'package:dio/dio.dart';

import '../../../core/network/api_client.dart';
import '../../auth/domain/user.dart';
import '../../messages/domain/message_models.dart';

class PublicProfile {
  const PublicProfile({
    required this.person,
    required this.bio,
    required this.country,
    required this.age,
    required this.likes,
    required this.followers,
    required this.following,
    required this.isVip,
  });

  factory PublicProfile.fromJson(Map<String, Object?> j) => PublicProfile(
    person: Person.fromJson(j),
    bio: (j['bio'] as String?) ?? '',
    country: (j['country'] as String?) ?? '',
    age: (j['age'] as num?)?.toInt(),
    likes: (j['likesCount'] as num?)?.toInt() ?? 0,
    followers: (j['followersCount'] as num?)?.toInt() ?? 0,
    following: (j['followingCount'] as num?)?.toInt() ?? 0,
    isVip: j['isVip'] == true,
  );

  final Person person;
  final String bio;
  final String country;
  final int? age;
  final int likes;
  final int followers;
  final int following;
  final bool isVip;
}

class ProfileEdit {
  const ProfileEdit({
    this.name,
    this.username,
    this.bio,
    this.age,
    this.gender,
    this.country,
    this.countryCode,
    this.avatar,
  });

  final String? name;
  final String? username;
  final String? bio;
  final int? age;
  final String? gender;
  final String? country;
  final String? countryCode;
  final String? avatar;

  Map<String, Object?> toJson() => {
    if (name != null) 'name': name,
    if (username != null) 'username': username,
    if (bio != null) 'bio': bio,
    if (age != null) 'age': age,
    if (gender != null) 'gender': gender,
    if (country != null) 'country': country,
    if (countryCode != null) 'countryCode': countryCode,
    if (avatar != null) 'avatar': avatar,
  };
}

class ProfileRepository {
  ProfileRepository(this._api);

  final ApiClient _api;

  Map<String, Object?> _m(Object? o) => (o! as Map).cast<String, Object?>();

  Future<PublicProfile> byUsername(String username) async =>
      PublicProfile.fromJson(
        _m(
          await _api.get('/users/by-username/${Uri.encodeComponent(username)}'),
        ),
      );

  Future<AppUser> update(ProfileEdit edit) async =>
      AppUser.fromJson(_m(await _api.patch('/users/me', body: edit.toJson())));

  Future<AppUser> uploadAvatar(String filePath) async {
    final form = FormData.fromMap({
      'avatar': await MultipartFile.fromFile(filePath),
    });
    final env = await _api.request('POST', '/users/me/avatar', body: form);
    return AppUser.fromJson(_m(env.data));
  }

  Future<void> deleteAccount(String password) =>
      _api.post('/users/me/delete', body: {'password': password});

  /// Returns the new `isFollowing` flag.
  Future<bool> setFollow(String id, {required bool follow}) async {
    final d = _m(
      follow
          ? await _api.put('/users/$id/follow')
          : await _api.deleteData('/users/$id/follow'),
    );
    return d['isFollowing'] == true;
  }

  Future<void> registerPushToken(String token) =>
      _api.put('/users/me/push-token', body: {'token': token});
}
