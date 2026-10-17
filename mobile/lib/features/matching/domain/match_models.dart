import 'package:equatable/equatable.dart';

class Filters extends Equatable {
  const Filters({
    this.gender = 'both',
    this.country = 'All Countries',
    this.superMatch = false,
  });

  final String gender;
  final String country;
  final bool superMatch;

  Map<String, Object?> toJoinPayload() => {
    'gender': gender,
    if (country.isNotEmpty && country != 'All Countries') 'country': country,
    'superMatch': superMatch,
  };

  @override
  List<Object?> get props => [gender, country, superMatch];
}

class Partner extends Equatable {
  const Partner({
    required this.id,
    required this.name,
    required this.username,
    required this.avatar,
    required this.country,
    required this.countryCode,
    required this.likesCount,
    required this.isVip,
    this.age,
  });

  factory Partner.fromJson(Map<String, Object?> j) => Partner(
    id: j['id']! as String,
    name: (j['name'] as String?) ?? '',
    username: (j['username'] as String?) ?? '',
    avatar: (j['avatar'] as String?) ?? '',
    country: (j['country'] as String?) ?? '',
    countryCode: (j['countryCode'] as String?) ?? '',
    likesCount: (j['likesCount'] as num?)?.toInt() ?? 0,
    isVip: j['isVip'] == true,
    age: (j['age'] as num?)?.toInt(),
  );

  final String id;
  final String name;
  final String username;
  final String avatar;
  final String country;
  final String countryCode;
  final int likesCount;
  final bool isVip;
  final int? age;

  Partner withLikes(int n) => Partner(
    id: id,
    name: name,
    username: username,
    avatar: avatar,
    country: country,
    countryCode: countryCode,
    likesCount: n,
    isVip: isVip,
    age: age,
  );

  @override
  List<Object?> get props => [id, name, likesCount];
}

class ChatMsg extends Equatable {
  const ChatMsg({
    required this.id,
    required this.mine,
    required this.text,
    this.giftName,
    this.giftImage,
  });

  final String id;
  final bool mine;
  final String text;
  final String? giftName;
  final String? giftImage;

  @override
  List<Object?> get props => [id];
}
