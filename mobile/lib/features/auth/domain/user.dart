import 'package:equatable/equatable.dart';

/// The signed-in person (`/auth/me`). Immutable; copyWith for local patches (gem balance after a purchase...).
class AppUser extends Equatable {
  const AppUser({
    required this.id,
    required this.username,
    required this.name,
    required this.avatar,
    required this.gender,
    required this.country,
    required this.countryCode,
    required this.bio,
    required this.gems,
    required this.likesCount,
    required this.followersCount,
    required this.followingCount,
    required this.isVip,
    required this.isGuest,
    required this.role,
    this.email,
    this.age,
    this.phone = '',
    this.address = '',
    this.vipExpiry,
  });

  factory AppUser.fromJson(Map<String, Object?> j) => AppUser(
    id: j['id']! as String,
    username: (j['username'] as String?) ?? '',
    name: (j['name'] as String?) ?? '',
    avatar: (j['avatar'] as String?) ?? '',
    gender: (j['gender'] as String?) ?? 'other',
    country: (j['country'] as String?) ?? '',
    countryCode: (j['countryCode'] as String?) ?? '',
    bio: (j['bio'] as String?) ?? '',
    gems: (j['gems'] as num?)?.toInt() ?? 0,
    likesCount: (j['likesCount'] as num?)?.toInt() ?? 0,
    followersCount: (j['followersCount'] as num?)?.toInt() ?? 0,
    followingCount: (j['followingCount'] as num?)?.toInt() ?? 0,
    isVip: j['isVip'] == true,
    isGuest: j['isGuest'] == true,
    role: (j['role'] as String?) ?? 'user',
    email: j['email'] as String?,
    age: (j['age'] as num?)?.toInt(),
    phone: (j['phone'] as String?) ?? '',
    address: (j['address'] as String?) ?? '',
    vipExpiry: j['vipExpiry'] == null
        ? null
        : DateTime.tryParse(j['vipExpiry']! as String),
  );

  final String id;
  final String username;
  final String name;
  final String avatar;
  final String gender;
  final String country;
  final String countryCode;
  final String bio;
  final int gems;
  final int likesCount;
  final int followersCount;
  final int followingCount;
  final bool isVip;
  final bool isGuest;
  final String role;
  final String? email;
  final int? age;
  final String phone;
  final String address;
  final DateTime? vipExpiry;

  String get displayName => name.isNotEmpty ? name : username;
  bool get isAdmin => role == 'admin';

  AppUser copyWith({
    int? gems,
    int? likesCount,
    bool? isVip,
    DateTime? vipExpiry,
    String? avatar,
  }) => AppUser(
    id: id,
    username: username,
    name: name,
    avatar: avatar ?? this.avatar,
    gender: gender,
    country: country,
    countryCode: countryCode,
    bio: bio,
    gems: gems ?? this.gems,
    likesCount: likesCount ?? this.likesCount,
    followersCount: followersCount,
    followingCount: followingCount,
    isVip: isVip ?? this.isVip,
    isGuest: isGuest,
    role: role,
    email: email,
    age: age,
    phone: phone,
    address: address,
    vipExpiry: vipExpiry ?? this.vipExpiry,
  );

  @override
  List<Object?> get props => [
    id,
    username,
    name,
    avatar,
    gems,
    likesCount,
    isVip,
    isGuest,
    role,
    vipExpiry,
    followersCount,
    followingCount,
    bio,
    age,
    country,
  ];
}
