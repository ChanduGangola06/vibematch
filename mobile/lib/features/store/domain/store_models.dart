class GemPack {
  const GemPack({
    required this.id,
    required this.name,
    required this.gems,
    required this.price,
    required this.popular,
    this.googlePayId,
    this.applePayId,
  });

  factory GemPack.fromJson(Map<String, Object?> j) => GemPack(
    id: j['id']! as String,
    name: (j['name'] as String?) ?? '',
    gems: (j['gems'] as num).toInt(),
    price: (j['price'] as num).toDouble(),
    popular: j['popular'] == true,
    googlePayId: j['googlePayId'] as String?,
    applePayId: j['applePayId'] as String?,
  );

  final String id;
  final String name;
  final int gems;
  final double price;
  final bool popular;
  final String? googlePayId;
  final String? applePayId;
}

class VipPlan {
  const VipPlan({
    required this.id,
    required this.name,
    required this.description,
    required this.priceGems,
    required this.durationDays,
    required this.popular,
  });

  factory VipPlan.fromJson(Map<String, Object?> j) => VipPlan(
    id: j['id']! as String,
    name: (j['name'] as String?) ?? '',
    description: (j['description'] as String?) ?? '',
    priceGems: (j['priceGems'] as num).toInt(),
    durationDays: (j['durationDays'] as num).toInt(),
    popular: j['popular'] == true,
  );

  final String id;
  final String name;
  final String description;
  final int priceGems;
  final int durationDays;
  final bool popular;
}

class Gift {
  const Gift({
    required this.id,
    required this.name,
    required this.price,
    required this.image,
  });

  factory Gift.fromJson(Map<String, Object?> j) => Gift(
    id: j['id']! as String,
    name: (j['name'] as String?) ?? '',
    price: (j['price'] as num).toInt(),
    image: (j['image'] as String?) ?? '',
  );

  final String id;
  final String name;
  final int price;
  final String image;
}

class FulfilResult {
  const FulfilResult({
    required this.balance,
    required this.gems,
    required this.alreadyProcessed,
  });

  factory FulfilResult.fromJson(Map<String, Object?> j) => FulfilResult(
    balance: (j['balance'] as num).toInt(),
    gems: (j['gems'] as num).toInt(),
    alreadyProcessed: j['alreadyProcessed'] == true,
  );

  final int balance;
  final int gems;
  final bool alreadyProcessed;
}
